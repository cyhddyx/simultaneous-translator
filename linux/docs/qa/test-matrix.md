# Linux 测试矩阵（托盘 / 快捷键 / 运行时通道 / 字幕窗口 / 音频路由 / 打包）

> 维护者：build-verify（Linux 移植）。
> 来源：按 `windows/docs/qa/test-matrix.md`（Windows v1.0.2，QA 维护）改写：保留矩阵编号与判据语义，
> 将命令/平台事实替换为 Linux（WSL2 + X11 + PulseAudio/PipeWire），并新增 Linux 音频路由与打包矩阵。
> 契约依据：`docs/tray-shortcuts-contract.md`（**T**）、`docs/runtime-channel-control.md`（**R**）、
> `docs/subtitle-window.md`（**S**）、`docs/linux-audio-routing.md`（**A**）、`PORTING_CONTRACT.md`（**P**）。
> 状态口径：**通过 / 失败 / 跳过（原因）/ 未验证**。未实测的一律写「未验证」，不写「通过」。

---

## 1. 覆盖层级与自动化入口（Linux）

| 层级 | 命令（工作目录） | 覆盖对象 | 执行者 |
| --- | --- | --- | --- |
| L1 Python 单测 | `cd linux; $VENV/bin/python scripts/test_*.py` | JSONL 协议、通道状态机、pactl/parec 命令构造、帧解码、错误映射 | engine-port 自测 + build-verify 复跑 |
| L2 PulseAudio 集成 | `cd linux; PULSE_SERVER=... $VENV/bin/python scripts/test_*integration*.py` | 真实 `pactl`/`parec`：模块加载/卸载、默认 sink 恢复、采集、虚拟麦克风 | engine-port 自测 + build-verify 复跑 |
| L3 前端构建 | `cd linux/desktop; npm run build` | TS 类型 + Vite 生产构建 | ui-port 自测 + build-verify 复跑 |
| L4 前端单测 | `cd linux/desktop; node --experimental-strip-types --test tests/*.test.mjs` | 纯函数与 mock 控制器（运行时状态/字幕窗/历史/语言表/Linux 文案） | ui-port 自测 + build-verify 复跑 |
| L5 Rust | `cd linux/desktop/src-tauri; CARGO_TARGET_DIR=... cargo build`（`cargo test` 可选） | Rust 命令层、更新资产匹配、pactl 命令构造 | rust-port 自测 + build-verify 最终构建 |
| L6 打包验证 | `bash packaging/verify-deb.sh <deb>`、`verify-rpm.sh <rpm>` | 包结构/依赖/desktop/图标/第三方声明/sidecar 启动自检 | **build-verify** |
| L7 冒烟（未安装） | `timeout 15 xvfb-run -a dbus-run-session -- target/release/simultaneous-translator` | 主程序启动、WebKit 初始化、不崩溃 | **build-verify** |
| L8 安装冒烟 | `dpkg -i <deb>` → L7 → `dpkg -r` | 安装后 `/usr/bin` 布局与启动、卸载残留 | **build-verify** |
| L9 人工联调 | `docs/qa/manual-checklist.md` | 托盘/快捷键/置顶/真实音频路由/会议软件虚拟麦克风/XDG Portal | **人工，未自动化** |

> L2 的边界：真实 `pactl`/`parec` 链路可测，但「会议软件把虚拟麦克风当作输入」只能在真实会议软件中验证（L9）。
> L7/L8 用 Xvfb + WSLg PulseAudio，能证明「进程能启动不崩溃」，**不能**证明托盘图标可见、快捷键生效（L9）。

### 1.1 本轮执行结果（build-verify，最终源码）

| 层级 | 命令摘要 | 结果 | 证据 |
| --- | --- | --- | --- |
| L1 | `$VENV/bin/python scripts/test_*.py` | 见 `artifacts/logs/linux-verification.md` §1 | 同左 |
| L2 | PulseAudio 集成测试 | 见验证日志 §2 | 同左 |
| L3 | `npm run build` | 见验证日志 §3 | 同左 |
| L4 | `node --test tests/*.test.mjs` | 见验证日志 §4 | 同左 |
| L5 | `cargo build`（+ `cargo test`） | 见验证日志 §5 | 同左 |
| L6 | `verify-deb.sh` / `verify-rpm.sh` | 见验证日志 §6 与 `qa/packaging.md` | 同左 |
| L7/L8 | Xvfb 冒烟 / dpkg 安装冒烟 | 见验证日志 §7 | 同左 |
| L9 | 人工清单 | **未验证（需真实桌面）** | — |

---

## 2. 维度定义

| 维度 | Linux 取值 |
| --- | --- |
| 窗口/会话状态 | 主窗口可见 / 最小化 / 隐藏到托盘 / 失焦；X11 与 Wayland 两种会话 |
| 会话阶段 | `needs_configuration` / `idle` / `starting` / `listening` / `stopping` / `error` |
| 通道组合 | 仅收听 / 仅发言 / 收+发 / 静音中 / 关收听 / 关发言 |
| 音频设备 | PulseAudio sink/source 正常 / 无默认 sink / 无输入源 / 设备热插拔 / `pactl` 缺失 / PA 服务不可达 |
| 音频路由模式 | 隔离采集（`translator_mix`）/ 指定设备回环（`sink.monitor`）/ 虚拟麦克风（`translator_mic`）/ 麦克风输入 |
| 网络 | 正常 / 连接中 / 断线重连 / 鉴权失败 / 超时 |
| 字幕窗口 | 未创建 / 已创建隐藏 / 已显示 / 已显示且刷新 / 反复 toggle；X11 置顶 vs Wayland 限制 |
| 版本 | 开发版（`bash scripts/dev.sh`）/ 安装版（deb/rpm 安装后）/ AppImage（可选） |

---

## 3. 矩阵 A：托盘 × 快捷键 × 窗口状态（Linux）

| ID | 场景 | 预期（契约） | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| A-01 | 应用刚启动 | `RuntimeState` 初始值 = T §2 初始 JSON；`trayStatus=not_started` | L5 | 由 L5 覆盖 |
| A-02 | 托盘图标与 tooltip | 托盘 id `main-tray`，tooltip `同传翻译 · <状态文案>`（T §9）；**需要 AppIndicator 宿主** | L9 | 未验证（需真实桌面 + appindicator host） |
| A-03 | 托盘菜单 9 个 item id | `tray-status/tray-start-stop/tray-speak-mute/tray-listen/tray-speak/tray-subtitle/tray-show/tray-settings/tray-quit`（T §9） | L5（静态/单测） | 由 L5 覆盖 |
| A-04 | `tray-status` 文案五态 | 未启动/正在连接/正常翻译/音频异常/网络异常（T §3 表） | L4 + L5 | 由 L4/L5 覆盖 |
| A-05 | `trayStatus` 优先级 | `network_error > audio_error > connecting > translating > not_started`（T §3） | L5 | 由 L5 覆盖 |
| A-06 | 同时音频+网络错误 | 主状态显示「网络异常」；`lastError` 保留最近一条；两条错误都可见（T §3） | L5 | 由 L5 覆盖 |
| A-07 | 三入口同一 dispatcher | 托盘菜单、快捷键回调、`dispatch_native_action` 都调用 `dispatch_action`（T §7） | L5（静态） | 由 L5 覆盖 |
| A-08 | 主窗口关闭（未退出） | `prevent_close()` + `hide()`，session 不中断（T §10）；**无托盘宿主时降级为关闭即退出（P D7）** | L9 | 未验证（需人工） |
| A-09 | 主窗口隐藏时托盘右键菜单 | 菜单可用，`显示主窗口` 能恢复并聚焦（T §9/§7） | L9 | 未验证（需人工） |
| A-10 | `启动/停止` 幂等 | `starting`/`stopping` 期间再次触发返回当前状态，不创建第二个 session（T §7） | L5 | 由 L5 覆盖 |
| A-11 | 快捷键去抖 | 同一 action 250ms 内重复触发被丢弃（T §8.4） | L5 | 由 L5 覆盖 |
| A-12 | 只响应 Pressed | 忽略 `ShortcutState::Released`（T §8.2） | L5 + L9 | 部分（单测 + 人工） |
| A-13 | 单项注册失败不影响其他 | 失败项进 `shortcutFailures` 并给出可读提示（T §8.3）；Wayland 下通常全部失败 → 逐项报告 | L5 + L9 | 部分 |
| A-14 | 全局快捷键 5 个 | `Ctrl+Shift+Space/M/O/L/S`（T §8） | L9（X11） | 未验证（需真实桌面） |
| A-15 | 主窗口隐藏/最小化/失焦时快捷键仍生效 | 全局快捷键天然满足（T §8.6） | L9 | 未验证（需真实桌面） |
| A-16 | 退出路径注销快捷键 | `quit_application` → `unregister_all`（T §8.7） | L5 + L9 | 部分 |
| A-17 | 单实例第二次启动 | 显示、还原、聚焦主窗口（T §10） | L9 | 未验证（既有行为，回归项） |
| A-18 | `runtime-state` 事件广播 | `app.emit()`，主窗口与字幕窗口都收到（T §6） | L5 | 由 L5 覆盖 |
| A-19 | 仅值变化时广播 | 前后比较，无变化不发（T §6） | L5 | 由 L5 覆盖 |
| A-20 | 动作失败 | 返回 `Err(中文提示)` 且 `lastError` 更新（T §5/§7） | L5 | 由 L5 覆盖 |
| A-21 | **无 AppIndicator 宿主时降级**（Linux 特有） | 托盘创建失败只记录告警，不崩溃；降级为「关闭窗口即退出」并在设置页提示（P D7） | L5 + L7 | 部分（冒烟可证不崩溃） |
| A-22 | **Wayland 会话**（Linux 特有） | 全局快捷键/置顶受限时逐项报告失败，不崩溃、不阻塞主流程（P D8/D9） | L9 | 未验证（需 Wayland 桌面） |

## 4. 矩阵 B：运行时通道 × 静音（判据与 Windows 一致，脚本改为 Linux 路径）

| ID | 场景 | 预期（契约） | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| B-01 | `set_runtime_channel` 关闭收听 | `ok:true, changed:true`，`result` 回显生效后状态（R §2.1/§3.1） | L1 | 由 L1 覆盖 |
| B-02 | 幂等重放同值 | `ok:true, changed:false`，不是错误（R §3.1） | L1 | 由 L1 覆盖 |
| B-03 | 事件 `runtime.channel` | `{channel, enabled, configured:true}`，仅真正变化时发（R §4.2） | L1 | 由 L1 覆盖 |
| B-04 | `set_speak_muted` 静音 | `ok:true, changed:true`，事件 `runtime.mute {muted:true}`（R §2.2/§4.2） | L1 | 由 L1 覆盖 |
| B-05 | 重复静音 | 第二次 `changed:false`，不重复发 `runtime.mute` | L1 | 由 L1 覆盖 |
| B-06 | 取消静音 | `changed:true`，通道仍在，无 `stopped` 事件 | L1 | 由 L1 覆盖 |
| B-07 | 关一个通道不停整个 session | 关闭收听期间发言通道仍可操作（R §1.4） | L1 | 由 L1 覆盖 |
| B-08 | 未配置通道 | `channel_not_configured`，不得伪造已开启（R §1.3/§2.2） | L1 | 由 L1 覆盖 |
| B-09 | `channel` 非法 | `invalid_channel`（R §2.1） | L1 | 由 L1 覆盖 |
| B-10 | `enabled` / `muted` 非布尔 | `invalid_params`（R §2.1/§2.2） | L1 | 由 L1 覆盖 |
| B-11 | 缺 `session_id` | `invalid_params`（R §2.1） | L1 | 由 L1 覆盖 |
| B-12 | 无活跃 session | `no_active_session`（R §3.2） | L1 | 由 L1 覆盖 |
| B-13 | 旧 session id | `session_mismatch`，不改状态、不发事件（R §3.2/§7） | L1 | 由 L1 覆盖 |
| B-14 | stop 后旧事件不发 | 停止后不再有该 session 的 `runtime.*` 事件（R §5/§7） | L1 | 由 L1 覆盖 |
| B-15 | 重启后运行时开关复位 | 重新 start → 通道回到 `config.audio.<channel>.enabled`，`speak_muted=false`（R §1.2） | L1 | 由 L1 覆盖 |
| B-16 | 运行时开关不写回设置 | 反复切换后 `settings.json` 不变（R §1.1/T §12.2） | L1 + L9 | 部分（L1 进程内断言；安装版需人工核对文件） |
| B-17 | 恢复通道不重建 session | 关闭→恢复期间无新 session（R §1.5/§6.3） | L1 | 由 L1 覆盖 |
| B-18 | 音频帧真的被拦截 | 关收听/静音后音频帧不再进入引擎（R §6.1/§6.2） | L1 + L9 | 部分（单测代码级；物理链路需人工听感） |
| B-19 | 音频回调无阻塞 IO | 采集回调内不做阻塞读（R §6.4） | 代码评审 | 未验证（仅人工审阅） |
| B-20 | 锁顺序无死锁 | 采集线程与主循环锁顺序一致（R §6.5） | L1 + L9 | 部分 |
| B-21 | `id` 回显 | 成功与失败都回 response 且 `id` 与请求一致（R §3） | L1 | 由 L1 覆盖 |
| B-22 | §1.5 关通道必清静音 | `set_runtime_channel{speak,false}` 成功时若 `speak_muted=true` 必须同时置 false 并补发 `runtime.mute{false}` | L1 | 由 L1 覆盖 |
| B-23 | §1.5 事件顺序 | 先 `runtime.mute{muted:false}`、后 `runtime.channel{speak,enabled:false}` | L1 | 由 L1 覆盖 |
| B-24 | §1.5 反向不成立 | `enabled:true` 不得改变 `speak_muted` | L1 | 由 L1 覆盖 |
| B-25 | §1.5.0 幂等关闭也清幽灵 | 重复 `enabled:false`（changed:false）同样清幽灵静音，只补发 `runtime.mute{false}`；该断言变红 = 回退 | L1 | 由 L1 覆盖 |
| B-26 | §1.5.1 原始 JSONL 可瞬时构造幽灵态 | 运行时已关闭的 speak 通道仍可 `set_speak_muted{true}` 成功（按配置状态判定） | L1 | 由 L1 覆盖 |
| B-27 | §1.5.1 幽灵态不可持久 | 绕过 Rust 也无法留下 `speakEnabled=false && speakMuted=true` 的持久组合 | L1 | 由 L1 覆盖 |
| B-28 | 入口①主界面按钮 | 发言通道运行时关闭时静音按钮必须禁用 | L4 | 由 L4 覆盖 |
| B-29 | 入口②托盘菜单 / ③全局快捷键 | 经 `dispatch_action` 前置检查，不满足直接 Err、不下发命令 | L5 + L9 | 部分（静态/单测 + 人工 M-32） |
| B-30 | 并发交错请求 | 交替翻转 6 次全部 `changed:true`；同值 6 次仅 1 次 changed；无事件风暴 | L1 | 由 L1 覆盖 |

## 5. 矩阵 C：音频设备与 Linux 音频路由

### 5.1 C 组：设备 × 会话阶段

| ID | 场景 | 预期 | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| C-01 | 设备正常 | 会话进入 `listening`，`audioHealth=ready`，`trayStatus=translating` | L2 + L9 | 部分 |
| C-02 | 无默认 sink / 无输入源 | `error.service=="audio"`，既有音频 code；`recoverable:false`；托盘「音频异常」 | L1 + L2 | 由 L1/L2 覆盖 |
| C-03 | 设备被拔出 / 中断 | `audio_device_lost`，recoverable=true；`audioHealth=failed` → `trayStatus=audio_error` | L1 + L9 | 部分（单测错误分类；真实插拔需人工） |
| C-04 | 打开设备超时 | `audio_startup_timeout`，会话被终止并回到 `not_started` | L1 + L9 | 部分 |
| C-05 | 无输出设备 / 被独占 | 播放失败上报，不影响翻译字幕 | L1 + L9 | 部分 |
| C-06 | 设备在 `starting` 阶段掉线 | 会话不卡死，最终 `error` 或 `idle`（不得停在 `connecting`） | L1 + L9 | 部分 |
| C-07 | 音频失败时同时发 `audio.status=failed` 且带 `channel` | 契约 R §4.3 | L1 + L2 | 由 L1/L2 覆盖 |
| C-08 | `input:"system"` 时 `input_device` 被忽略 | 按设计走 `SystemCapture`；只有 `loopback`/`microphone` 用 `input_device` | L1 | 由 L1 覆盖（易误判，见 known-issues） |

### 5.2 C-L 组：Linux 音频路由（`docs/linux-audio-routing.md`，Linux 特有）

| ID | 场景 | 预期（A 文） | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| C-L01 | 隔离采集启动序列 | `translator_mix` null-sink 加载 → loopback 到原默认 sink → 切换默认 sink → parec 采集 | L2 | 见 §1.1 |
| C-L02 | 隔离采集：本软件译文不被回采 | 译文显式播放到用户所选 sink，不跟随默认 sink（A §3.1 关键点） | L2 + L9 | 部分（需真实听感/回采验证） |
| C-L03 | 采集参数 | `parec --format=s16le --rate=16000 --channels=1 --raw --latency-msec=100`；每帧 3200 B → `(1600,1)` float32 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L04 | 关闭序列顺序 | 先停 parec → 恢复默认 sink → 卸 loopback → 卸 null-sink → 清状态文件 | L1（mock 顺序）+ L2 | 由 L1/L2 覆盖 |
| C-L05 | 异常路径仍清理 | parec 被杀/异常时 `close()` 仍卸载模块、恢复默认 sink、删状态文件 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L06 | 崩溃残留清理 | 下次启动扫描状态文件/`pactl list short modules`，只处理 `translator_*` 模块并恢复默认 sink | L1 + L2 | 由 L1/L2 覆盖 |
| C-L07 | 不修改用户持久配置 | 不写 `default.pa` / `~/.config/pulse/*.pa`；只在会话内 load/unload | L2（文件哈希/目录对比） | 见 §1.1 |
| C-L08 | 回环模式（指定播放设备） | 不创建模块，`parec --device=<sink>.monitor`；禁止与译文播放设备相同 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L09 | 虚拟麦克风创建/检测 | `translator_mic` null-sink + `translator_mic_source` remap-source；`pactl list short sources` 可见 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L10 | 虚拟麦克风幂等 | 已存在直接 Ok 不重建；残留先清理；启动时存在视为可用不卸载 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L11 | 虚拟麦克风生命周期 | 停止同传不卸载；退出应用卸载；会议软件可选 "Translator Virtual Microphone" | L2 + L9 | 部分（模块存在性可自动测；会议软件需人工） |
| C-L12 | 缺 `pactl`/`parec` | 明确中文错误「未找到 PulseAudio 工具（pactl/parec），请安装 pulseaudio-utils 或 pipewire-pulse」 | L1 | 由 L1 覆盖 |
| C-L13 | PA 服务不可达 | 报错并给出 stderr 尾部；不崩溃、不静默降级 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L14 | 无默认 sink | 「未找到系统默认播放设备」 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L15 | 设备枚举映射 | `devices` 返回结构不变；speakers 来自 sinks（id=sink 名）、microphones 来自 sources（排除 `.monitor`）、`isDefault` 与 `get-default-sink` 一致 | L1 + L2 | 由 L1/L2 覆盖 |
| C-L16 | PipeWire（`pipewire-pulse`）兼容 | 命令只用 `pactl`/`parec`，未用 PA 私有接口；纯 PipeWire（无 pipewire-pulse）不保证 | L9 | 未验证（需 PipeWire 环境） |
| C-L17 | 音频测试向导 | 播放/麦克风/回环三种测试路径在 PulseAudio 下可用，错误提示中文 | L1 + L2 + L9 | 部分（存在性/命令可测；听感需人工） |

## 6. 矩阵 D：网络 × 会话阶段

| ID | 场景 | 预期 | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| D-01 | 临时 WebSocket 连接失败 | `network.status=connecting`，原会话内自动恢复，不发送终止错误 | L1 | 由 L1 覆盖 |
| D-02 | 部分通道永久故障（sibling 存活） | `network.status=degraded`，sibling 继续；临时断线只重连受影响通道 | L1 | 由 L1 覆盖 |
| D-02b | 全通道故障 | `network.status{status:"failed"}` → 触发 `network_error` | L1 | 由 L1 覆盖 |
| D-03 | 鉴权失败 | `network/auth_failed, recoverable:false` | L1 + L9 | 部分 |
| D-04 | 翻译超时/断开 | `translation_timeout` / `translation_disconnected` | L1 | 由 L1 覆盖 |
| D-05 | 断线期间 UI | 临时断线显示「正在连接」，字幕保留；永久故障仍显示错误 | L1 + L4 + L9 | 部分 |
| D-06 | 网络恢复 | `network.status{status:"ready"}`，`networkHealth` 复位，`trayStatus` 回落 | L1 | 由 L1 覆盖 |
| D-07 | `network.status` 仅变化时发 | 重复同值不发（R §4.3） | L1 | 由 L1 覆盖 |
| D-08 | 重连与停止 | 正常关闭、异常断线、`session.finished` 后恢复字幕；停止取消等待；鉴权/配置错误不循环重试 | L1 | 由 L1 覆盖 |

## 7. 矩阵 E：字幕悬浮窗（X11 / Wayland）

| ID | 场景 | 预期 | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| E-01 | 首次 toggle 创建 | label 固定 `subtitle`，URL `index.html?window=subtitle`，不写进 tauri.conf.json | L5 | 由 L5 覆盖 |
| E-02 | 重复 toggle 不重复创建 | 反复 20 次后只有 1 个 `subtitle` | L5 + L9 | 部分 |
| E-03 | 窗口属性 | 无边框/透明/置顶/不占任务栏/可缩放/无阴影/初始 880×220/最小 420×120/不抢焦点（S §2） | L5 + L9 | 部分 |
| E-04 | 关闭按钮 = 隐藏 | `prevent_close()+hide()`，`subtitleVisible=false`，不销毁会话（S §3） | L5 + L9 | 部分 |
| E-05 | 主窗口关到托盘时字幕保持原状 | 不跟随隐藏（S §3） | L9 | 未验证（需人工） |
| E-06 | `Ctrl+Shift+O` 三态可切换 | 主窗口可见/最小化/隐藏到托盘（S §7.1） | L9 | 未验证（需人工） |
| E-07 | 跨应用置顶 | **X11：置顶生效**；Wayland：由合成器决定，失败不阻塞主流程（P D9） | L9 | 未验证（需真实桌面） |
| E-08 | 不影响进行中的 session | toggle 前后 session_id 不变、无重复 session（S §7.3） | L1 + L9 | 部分 |
| E-09 | 刷新后恢复 | 依赖 `getSnapshot()` 恢复字幕与状态（S §3/S §7.4） | L4 + L9 | 部分 |
| E-10 | 主/字幕窗口状态一致 | 同一 `runtime-state` revision（S §7.6） | L4 + L9 | 部分 |
| E-11 | 单一订阅协议 | 字幕窗口复用 `translatorApi.subscribe()` + `getSnapshot()`（S §4） | L5 + L4 | 由 L4/L5 覆盖 |
| E-12 | 只显示字幕 | 无设置入口/控制栏/历史管理/会话按钮（S §5） | L4 | 由 L4 覆盖 |
| E-13 | 字号映射 | `small→15px / medium→19px / large→24px`（S §5） | L4 | 由 L4 覆盖 |
| E-14 | 小尺寸不重叠 | 420×120 下无元素重叠（S §5） | L4 + L9 | 部分 |
| E-15 | 静音/关通道有图标+文字 | 不允许只靠颜色（S §5） | L4 | 由 L4 覆盖 |
| E-16 | 拖拽区 | `data-tauri-drag-region` + capability `allow-start-dragging`（S §5） | L5 + L4 | 由 L4/L5 覆盖 |
| E-17 | transparent 根节点类 | `html.subtitle-root, body.subtitle-root { background: transparent }`（S §6） | L4 | 由 L4 覆盖 |
| E-18 | 主窗口无视觉回归 | 主窗口样式不因移植变化（S §6） | L3 + L9 | 部分 |
| E-19 | **Wayland 无边框窗口拖动**（Linux 特有） | 合成器决定是否可拖动/置顶；失败记录但不阻塞（P D9） | L9 | 未验证（需 Wayland 桌面） |

## 8. 矩阵 F：打包与安装（Linux）

| ID | 场景 | 预期 | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| F-01 | `npx tauri build --bundles deb` | 退出码 0，产出 `.deb` | L6 | 见 `qa/packaging.md` |
| F-02 | `npx tauri build --bundles rpm` | 退出码 0，产出 `.rpm` | L6 | 见 `qa/packaging.md` |
| F-03 | 包内主程序 | `/usr/bin/simultaneous-translator` 存在、可执行、ELF x86-64 | L6 | 见 `qa/packaging.md` |
| F-04 | 包内 sidecar | `/usr/bin/translator-bridge` 与主程序同目录、可启动（ping ok） | L6 | 见 `qa/packaging.md` |
| F-05 | `.desktop` 中文显示名 | `Name=同传翻译`、`Name[zh_CN]=同传翻译`、Exec/Icon 正确 | L6 | 见 `qa/packaging.md` |
| F-06 | 图标 | hicolor 多尺寸 PNG，含 32x32/128x128 | L6 | 见 `qa/packaging.md` |
| F-07 | 依赖声明 | Depends/Requires 含 webkit2gtk-4.1、gtk3、appindicator（librsvg2 为构建期依赖，非必需） | L6 | 见 `qa/packaging.md` |
| F-08 | 第三方声明 | `THIRD_PARTY_NOTICES.md` 随包安装，无 VB-CABLE 残留 | L6 | 见 `qa/packaging.md` |
| F-09 | 安装 | `dpkg -i` 成功；`/usr/bin` 两文件就位；应用可启动（L8） | L8 | 见 `qa/packaging.md` |
| F-10 | 卸载 | `dpkg -r` 成功；无残留进程；用户配置保留（正确行为） | L8 | 见 `qa/packaging.md` |
| F-11 | 升级安装 | 旧版本 → 新版本覆盖安装，配置保留 | L8 | 未验证（单版本轮次） |
| F-12 | rpm 安装 | Fedora/openSUSE 安装（Debian 系不安装，只验证元数据/解包） | L9 | 未验证（需 RPM 发行版） |
| F-13 | 更新检查资产匹配 | Linux 资产名 `_linux_amd64.deb/.rpm/.AppImage` + `SHA256SUMS.txt`；下载校验失败阻止安装（P D10） | L5 + L9 | 部分 |
| F-14 | AppImage（可选） | 构建成功、可执行、含主程序+sidecar | L6（可选） | 未验证（默认不构建） |
| F-15 | 打包版本号 | 三处版本一致，产物文件名版本正确 | L6 | 见 `qa/packaging.md` |

## 9. 矩阵 G：开发版 vs 安装版

| ID | 场景 | 预期 | 覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| G-01 | 开发版自动化全绿 | L1–L5 全绿 | L1–L5 | 见 §1.1 |
| G-02 | 安装版同一组行为 | 安装后行为与开发版一致 | L8 + L9 | 部分 |
| G-03 | 安装版托盘/快捷键/字幕窗 | 同 A/E 组 | L9 | 未验证（需人工） |
| G-04 | 安装版音频路由 | 同 C-L 组；`/usr/bin/translator-bridge` 打包引擎能跑 | L8 + L9 | 部分（冒烟可证引擎可启动） |

## 10. 明确不覆盖（Non-goals）

1. **真实会议软件集成**（Zoom/Teams/Discord 选择虚拟麦克风）：需真实桌面与会议软件，人工 L9。
2. **真实 API Key 的长时翻译/静默保活**：无稳定密钥与网络保证，不纳入自动化。
3. **Wayland 合成器差异矩阵**（GNOME/KDE/sway 各自行为）：只记录「X11 通过 + Wayland 已知限制」。
4. **多显示器 / DPI 缩放 / 高对比度主题**下的渲染细节。
5. **纯 PipeWire 无 `pipewire-pulse` 环境**：不保证可用（契约 §10）。
6. **AppImage 发行版兼容性**（FUSE、openSUSE 等）：默认不发布 AppImage。
7. **性能与长稳**（数小时 session 泄漏、内存增长）。
8. **驱动级音频问题**（采样率不匹配、硬件独占）。

## 11. 矩阵规模统计

| 组 | 条目数 | 可自动化 | 仅人工/未验证 |
| --- | --- | --- | --- |
| A 托盘/快捷键/窗口状态 | 22 | 15 | 7 |
| B 运行时通道/静音 | 30 | 27 | 3 |
| C 音频设备 | 8 | 5 | 3 |
| C-L Linux 音频路由 | 17 | 13 | 4 |
| D 网络 | 9 | 7 | 2 |
| E 字幕窗口 | 19 | 13 | 6 |
| F 打包与安装 | 15 | 12 | 3 |
| G 开发版/安装版 | 4 | 3 | 1 |
| **合计** | **124** | **95** | **29** |

> 每条的最终「通过/失败/跳过/未验证」结论见 `artifacts/logs/linux-verification.md`（本轮实测）
> 与 `qa/packaging.md`（打包/安装专项）。未实测的条目在本文件中保持「未验证」，不得据推测改写为「通过」。
