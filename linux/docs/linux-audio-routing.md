# Linux 音频路由设计（PulseAudio / PipeWire）

> Owner：Lead。本文是实现方（`scripts/` Python 引擎 与 `desktop/src-tauri` Rust）共同遵守的音频架构约定。
> 修改前先改本文，再改代码。所有命令行示例都来自实测可用的 WSLg PulseAudio 16.1（`PULSE_SERVER=unix:/mnt/wslg/PulseServer`）。

## 1. 目标与约束

Windows 版靠 WASAPI 进程回环实现「采集系统声音但排除本软件输出」。Linux 没有等价的进程排除接口，本设计用 **PulseAudio 的虚拟 sink 路由**达到同样效果：把「其他应用的声音」与「本软件的译文语音」放到两条不同的路由上，只采集前者。

设计目标：

1. 收听通道「系统声音（排除本软件）」：采集其他应用输出，**本软件译文语音不会被再次送入模型**（避免自激回声）。
2. 用户能同时听到系统原声与本软件译文语音。
3. 用户可以不切系统默认设备就获得隔离采集（应用内自行切换，结束后恢复）。
4. 虚拟麦克风让会议软件把译文语音当作麦克风输入。
5. 失败必须显式报错，不静默降级到会自激的模式（与 Windows 语义一致）。

约束：

- 只用 `pactl` / `parec` 命令行和 `python-soundcard`（PulseAudio 后端）。兼容 PulseAudio 与 PipeWire（通过 `pipewire-pulse`）。
- 不修改用户持久配置（`default.pa`、`~/.config/pulse/*.pa`），只在会话期间 `load-module`，结束时 `unload-module` 并恢复默认 sink。
- 模块命名固定，便于崩溃残留清理。

## 2. PulseAudio 概念速查

| 对象 | 说明 |
| --- | --- |
| sink | 播放设备（扬声器/耳机/虚拟输出） |
| source | 采集设备（麦克风/监视器） |
| `<sink>.monitor` | 该 sink 上所有播放声音的监视源，可直接采集 |
| `module-null-sink` | 创建虚拟 sink（额外得到 `<sink_name>.monitor`） |
| `module-loopback` | 把一个 source 的声音实时转发到一个 sink |
| `module-remap-source` | 把某个 source 重新发布为一个普通 source（会议软件更容易列出） |
| 默认 sink | `pactl get-default-sink` / `pactl set-default-sink`；新播放流默认进这个 sink |

固定命名：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `translator_mix` | null sink | 系统声音混音池，采集点 |
| `translator_mix.monitor` | monitor source | 隔离采集的输入 |
| `translator_mic` | null sink | 译文语音送虚拟麦克风的落点 |
| `translator_mic_source` | remap source | 会议软件里显示的虚拟麦克风 |

## 3. 隔离采集（收听通道 · 系统声音）

### 3.1 启动序列（Python `system_capture.py`）

```bash
# 0) 记录现场
orig_default_sink=$(pactl get-default-sink)
[ -n "$orig_default_sink" ] || fail("未找到系统默认播放设备")

# 1) 虚拟混音 sink
mix_id=$(pactl load-module module-null-sink \
  sink_name=translator_mix \
  sink_properties=device.description=TranslatorSystemMix)

# 2) 回放：把混音池的声音送到原默认设备，用户仍能听到系统原声
loop_id=$(pactl load-module module-loopback \
  source=translator_mix.monitor sink="$orig_default_sink" \
  latency_msec=20 source_dont_move=true sink_dont_move=true)

# 3) 默认 sink 切到混音池，新播放流自动进入被采集的路由
pactl set-default-sink translator_mix

# 4) 已在播放的流迁入混音池（本软件自己的译文流除外，它显式绑定播放设备）
pactl list short sink-inputs | awk '{print $1}' | while read -r id; do
  pactl move-sink-input "$id" translator_mix || true
done

# 5) 采集（16 kHz、单声道、s16le，100 ms = 3200 字节/帧）
parec --device=translator_mix.monitor \
      --format=s16le --rate=16000 --channels=1 --raw --latency-msec=100
```

关键点：

- 本软件译文语音**必须**显式播放到用户选择的播放设备（`soundcard.get_speaker(id=<sink>)`），不能跟随默认 sink，否则会被采集。
- 步骤 4 可能把「正在启动的译文播放流」也迁移走；因此译文播放器要在迁移完成后再打开，或通过显式 sink 绑定（推荐后者）。
- 不要使用 `set-default-sink` 之外的系统级修改；loopback 的 `sink_dont_move/source_dont_move` 防止设备热插拔时被 PA 自动挪走。

### 3.2 关闭序列

```bash
# 1) 先停采集进程（SIGTERM，等待退出；读线程收尾）
# 2) 恢复默认 sink（原设备可能已拔掉 → 失败只告警）
pactl set-default-sink "$orig_default_sink"
# 3) 卸 loopback，再卸 null sink（卸载时其上的流会自动迁回默认设备）
pactl unload-module "$loop_id"
pactl unload-module "$mix_id"
# 4) 清空本地状态文件
```

### 3.3 状态文件与崩溃残留清理

Python 在启动采集时把 `{ "default_sink": "...", "modules": {"mix": id, "loopback": id}, "pid": <引擎进程号> }` 写入应用状态目录（`$XDG_STATE_HOME/simultaneous-translator/audio-session.json`，缺省 `~/.local/state/...`）。

应用/引擎下次启动或开始新会话前执行清理：

1. 读状态文件；若无，扫描 `pactl list short modules` 中 `sink_name=translator_mix` 或 `source`/`source_name` 相关条目。
2. **journal pid 仍存活时跳过清理**：同一台机器上可能有另一实例/测试进程正在采集，不能误拆。只有 pid 已退出（或状态文件损坏）才继续。
3. 若原默认 sink 仍存在且当前默认 sink 是 `translator_mix`，恢复之。
4. 卸载残留的 loopback / null-sink 模块（按 id，或按名字匹配；顺序先 loopback 后 null-sink）。
5. 删除状态文件。清理只处理 `translator_*mix*` 命名的模块，绝不碰 Rust 侧的 `translator_mic*`。

### 3.3.1 单实例限制

隔离采集是**进程内单实例**：同一个引擎进程同时只允许一个系统声音采集。两个通道都选「系统声音」时，
第二个通道会明确报错「系统声音采集已在另一通道运行，请勿同时启用两个系统声音通道」，且不破坏第一个通道。
多应用实例并存时，第二实例会因 `translator_mix` 已被占用而报中文错误（journal pid 存活检测保证不会误拆第一实例）。
单实例限制同样适用于「一个通道系统声音 + 另一个通道系统声音」以外的组合（回环/麦克风不受影响）。

### 3.4 采集进程实现（`scripts/system_capture.py`，Linux 重写）

- 通过 `subprocess.Popen(parec…)` 启动；读线程每次 `read(3200)`，`np.frombuffer(dtype="<i2")` 转 float32（/32768）得到 1600 点/帧，形状 `(1600, 1)`，与 Windows 版 `SystemCapture.record(1600)` 接口一致。
- `__enter__` 完成模块加载 + 进程启动 + 首帧到达（超时 8 s）后才返回，失败抛中文 `RuntimeError`。
- `record(numframes)` 只接受 1600（100 ms @16 kHz），与 Windows 一致；队列深度 3，满了丢最旧帧。
- `close()` 幂等：终止 parec → join → 执行关闭序列；异常也不能漏卸载模块。
- parec 缺失（`shutil.which("parec") is None`）或 `pactl` 缺失时，错误文案："未找到 PulseAudio 工具（pactl/parec），请安装 pulseaudio-utils 或 pipewire-pulse"。
- 不要用 `soundcard` 直接录 monitor：`parec` 的 raw 16k 单声道输出省掉重采样，且进程边界更容易隔离超时。

### 3.5 回环模式（指定播放设备）

- 不创建模块；`parec --device=<sink>.monitor` 直接采集（Linux 用 parec 直采，无模块、无状态文件）。
- `<sink>` 来自设备枚举（见 §5），必须是 PulseAudio sink 名；若用户选的设备不是 sink（如已经是 monitor），报错。
- 语义与 Windows 一致：此模式**不排除**本软件输出，且禁止与译文播放设备相同（保存设置/启动时校验）。

### 3.6 失败模式速查

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| 无 `pactl`/`parec` | `FileNotFoundError` | 明确中文错误，提示安装 pulseaudio-utils / pipewire-pulse |
| PulseAudio 服务不可达 | pactl 非零退出 | 报错并给出 stderr 尾部 |
| 无默认 sink | `pactl get-default-sink` 为空 | "未找到系统默认播放设备" |
| load-module 失败 | 非零退出/非数字输出 | 回滚已加载模块后报错 |
| parec 立即退出 | stdout EOF | "系统声音采集已中断…" + stderr 尾部 |
| 采集超时 | 8 s 内无首帧 | "隔离采集启动超时，请检查音频服务" |

## 4. 虚拟麦克风（发言通道译文 → 会议软件）

### 4.1 模块

```bash
pactl load-module module-null-sink \
  sink_name=translator_mic \
  sink_properties=device.description=TranslatorVirtualMicrophoneSink

pactl load-module module-remap-source \
  master=translator_mic.monitor \
  source_name=translator_mic_source \
  source_properties=device.description=Translator<NBSP>Virtual<NBSP>Microphone
```

> **实测约束（2026-10-19，PulseAudio 16.1）**：`pactl` 的 module args 由服务端按空格切分，
> 不支持引号/反斜杠转义，**含 ASCII 空格的 description 会导致 `Module initialization failed`**。
> 唯一可用的“空格”是不换行空格 U+00A0（UTF-8 编码 C2 A0）：`Translator\u00A0Virtual\u00A0Microphone`
> 能正常加载并显示为 “Translator Virtual Microphone”。Rust 实现里写 `\u{a0}`，测试中不得出现
> 带 ASCII 空格的参数。中文 description（如 `翻译虚拟麦克风`）同样可用。

会议软件（Zoom/Teams/Discord/浏览器）在麦克风列表里选 **“Translator Virtual Microphone”**
（内部 source 名为 `translator_mic_source`；若某应用只显示名字，会显示下划线形式）。

### 4.2 播放路由

- 发言通道选择「发送译文到其他应用」后，该通道的译文语音播放设备指向 `translator_mic` sink（`soundcard.get_speaker(id="translator_mic")`）。
- 与 Windows 一致：**本机不额外监听**该路译文（避免与虚拟麦克风形成二次回声）；收听通道仍走耳机/扬声器。
- 界面「连接译文输出」= 确保模块存在 + 把发言通道播放设备设为 `translator_mic`；「检测」= `pactl list short sources` 中存在 `translator_mic_source` 且其中 master 为 `translator_mic.monitor`。

### 4.3 生命周期

- `install_virtual_microphone`（Rust）：幂等创建。已存在则直接 Ok；先清理残留再创建。
- 停止同传**不卸载**（会议软件需要持续可用）；退出应用时卸载。
- 应用启动时清理残留（先检测是否已存在，存在视为可用不重建，避免把正在使用的模块卸掉）。
- `open_virtual_microphone_link`：打开 Linux 帮助文档（`packaging/` 或 GitHub 文档 URL），不再有驱动下载。

## 5. 设备枚举与 `soundcard` 映射

`devices` 命令返回结构不变（前端已按它渲染）：

```json
{ "speakers": [{ "id": "...", "name": "...", "channels": 2, "isDefault": true, "loopback": true }],
  "microphones": [{ "id": "...", "name": "...", "channels": 1, "isDefault": true, "loopback": false }] }
```

Linux 实现原则：

- **speakers**：来自 `pactl list short sinks`（PulseAudio sink 名 + description）。`id` 用 sink 名（`soundcard.get_speaker(id=...)` 在 PulseAudio 后端接受设备名）；`name` 用 description（中文界面显示友好名）；`channels` 从 `channel map`/`sample spec` 解析；`isDefault` 与 `pactl get-default-sink` 比对；`loopback=true`（每个 sink 的 monitor 都可回环采集）。
- **microphones**：来自 `pactl list short sources`，排除 `.monitor` 源；`loopback=false`。
- **系统声音伪设备**：不是设备项，由设置里的输入类型 `kind=system` 表达（沿用现有设置结构）。
- 设备热插拔：沿用现有逻辑，在设置页/启动时重新枚举；不订阅 PA 事件。
- `soundcard` 与 `pactl` 的 id 一致性必须在实现时实测：若 `sc.get_speaker(id=<sink name>)` 失败，则改为在 `pactl` 枚举结果中携带索引并建立 id→sink 映射（以实测为准，写入本文件）。

## 6. 与 Rust 侧的职责划分

| 功能 | 归属 | 说明 |
| --- | --- | --- |
| 隔离采集模块加载/卸载 + parec | Python `system_capture.py` | 只在同传会话期间存在 |
| 虚拟麦克风模块创建/检测/卸载 | Rust `virtual_microphone.rs` | 设置页即可创建，不依赖引擎运行 |
| 播放路由（译文送哪个 sink） | Python（soundcard 播放器） | sink 名由设置传入 |
| 设备枚举 / 音频测试 | Python `livetranslate.py` | UI 通过 `devices`/`audio_test` 命令 |
| 启动时清理 `translator_*` 残留 | Python（采集前）与 Rust（启动时）各自清理自己负责的模块 | 规则见 §3.3 / §4.3 |

## 7. 测试策略

### 单元测试（不需要音频服务）

- `pactl`/`parec` 命令构造与参数校验（纯函数）。
- 错误映射：非零退出、空输出、超时 → 中文错误。
- 状态文件写入/读取/清理；残留模块扫描解析（用固定 `pactl list short modules` 文本）。
- parec 帧读取：3200 字节 → `(1600,1) float32` 且值域正确。
- 关闭序列顺序：先停进程、再恢复默认 sink、再卸模块（用 mock 记录调用顺序）。

### 集成测试（WSLg PulseAudio，标记 `@pytest.mark.integration` 或环境变量开关）

要求真实 `pactl`/`parec`，步骤如下（缺 pulse server 时 skip）：

1. 记录当前默认 sink。
2. 创建一个测试用 null sink 作为“用户设备”并设为默认（测试结束后恢复，见清理断言）。
3. 加载隔离采集模块组（用 `tt_test_translator_mix` 等测试命名前缀，避免与真实应用冲突；实现允许测试注入前缀）。
4. 断言 `translator_mix.monitor` 存在；`timeout 2 parec … | head -c 3200 | wc -c` 得到 3200。
5. 关闭序列 → 断言：无 `translator_*` 模块残留、默认 sink 已恢复。
6. 虚拟麦克风：创建 → 断言 `translator_mic_source` 在 `pactl list short sources` 中 → 卸载 → 断言消失。
7. 异常路径：kill 掉 parec 后 `record()` 报错；`close()` 仍完成清理。

禁止：测试残留模块、测试改变用户持久配置、并发跑多个 PulseAudio 集成测试。

## 8. 与 Windows 行为的差异（需要在产品文案中说明）

| 能力 | Windows | Linux |
| --- | --- | --- |
| 排除本软件输出 | WASAPI 进程回环，系统级 | 虚拟混音 sink 路由，会话内生效 |
| 默认设备 | 不改默认设备（采集进程回环） | 会话期间临时切换默认 sink，结束自动恢复；异常退出下次启动清理 |
| 虚拟麦克风 | VB-CABLE 驱动（需安装） | PulseAudio 内置模块，一键创建/卸载，无需驱动 |
| 译文本机监听 | 虚拟麦克风模式下不监听 | 同 |
| 回环采集 | WASAPI loopback | `sink.monitor` |
