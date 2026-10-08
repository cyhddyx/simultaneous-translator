# 同传翻译（Tauri 桌面版）

面向 Windows x64 的实时同传工具，仅使用 `qwen3.8-livetranslate-flash-realtime`。语音理解、翻译和译文语音由同一个模型完成，不需要另配语音识别或文本翻译模型。

## 两种输出模式

- **语音转文字**：输入语音，实时显示原文和译文字幕。会话发送 `output_modalities: ["text"]`，不创建译文播放器。
- **语音转语音**：输入语音，播放译文语音，同时显示字幕。会话发送 `output_modalities: ["text", "audio"]`。

在“设置 → 常规”选择统一输出模式，也可在“设置 → 音频”给两个通道分别选择模式。保存后下次开始同传生效。

目标语言按[官方语种表](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)区分：文字模式支持 60 种，语音模式支持其中 29 种。粤语和希腊语等仅支持文字输出，不能播报；输入粤语仍可自动识别并翻译为普通话、英语等受支持的语音。旧设置中的不支持组合会保留并提示修正，阻止保存或启动，不会自动替换语言。界面、原生程序和翻译引擎共用 `scripts/translation_languages.json`，打包时一并包含。

| 通道 | 默认输入 | 默认状态 |
| --- | --- | --- |
| 收听通道（对方 → 我） | 系统声音（排除本软件） | 开启，语音转文字 |
| 发言通道（我 → 对方） | 麦克风 | 关闭，语音转文字 |

两个通道分别选择输入设备、目标语言和译文播放设备，可独立启用。输入为 16 kHz 单声道 PCM16，输出语音为 24 kHz PCM16。源语言由模型自动识别。

常规设置中的“对话方向”可选择双向对话、只收听或只发言。“我收到的译文语言”控制收听译文，“对方收到的译文语言”控制发言译文。例如分别选择简体中文和 English 后，对方的英语翻成中文给我听，我的中文翻成英语发给对方。两个方向分别建立同传会话，拥有各自的翻译目标、音色和输出设备；主界面同时显示两路目标语言。缺省的发言目标为 English，不会继承收听目标。

## 模型连接

默认地址：

```text
wss://maas.qianwenaiapi.com/api-ws/v1/realtime
```

程序自动附加 `?model=qwen3.8-livetranslate-flash-realtime`，并通过 `Authorization: Bearer <API Key>` 鉴权。在“设置 → 同传模型”填写该接口对应的 API Key，或者为默认地址配置 `DASHSCOPE_API_KEY` 环境变量。

客户端等待 `session.updated` 后开始采集，处理 3.8 的增量字幕、完整字幕和语音事件。文本模式与语音模式通过实际会话配置区分，不发送独立 ASR 模型参数。

音色按通道独立设置：发言默认“本人音色”，收听默认“系统音色”。发言复刻使用 `voice: "default"`、`enable_voice_clone: true` 和 `voice_clone_options.frequency: "once"`；收听可单独选择“对方音色”，使用 `frequency: "always"` 跟随输入语音重新复刻，避免整场对话固定为首次采到的说话人。系统音色明确发送 `enable_voice_clone: false`。复刻效果由模型决定，并不提供说话人身份验证。文字模式不发送复刻参数。

程序会核对服务端是否确认复刻开关与频率；接口未确认时显示错误，不静默回退成系统音色。配置确认并不等同于复刻已经完成，实际相似度仍需由说话人试听。

## 译文语音路由

应用将译文播放到选定的 Windows 播放设备。向会议软件发送译文时：

1. 在“设置 → 音频 → 发送译文到其他应用”点击“安装官方组件”。程序从 VB-Audio 官网下载标准版 VB-CABLE，核对文件和发布者签名后打开官方安装程序；按提示安装，必要时重启电脑。
2. 点击“检测并连接”或“连接译文输出”，保存设置并重新开始同传。程序自动启用发言通道、选择实际麦克风并把译文发送到 `CABLE Input`，保留发言目标语言。
3. 在会议、游戏或直播软件里，将麦克风选为 `CABLE Output (VB-Audio Virtual Cable)`。此设置通常只需要选一次。

发言译文此时送入虚拟麦克风，本机不额外监听播放；收听通道仍可使用耳机。程序不会改动 Windows 默认设备，也不会擅自修改其他软件的麦克风选择。已安装 VB-CABLE 时可以直接连接；安装取消、设备缺失或校验失败会显示错误，不会假装连接成功。若重命名过 VB-CABLE 设备，可使用下方通道的设备选择器手动指定。

VB-CABLE 是 VB-Audio 的 Donationware（捐赠软件），专业或组织使用需遵守其付费许可要求。组件按需从官网下载，保留原名称与原安装程序，应用内提供官网、授权及捐赠／购买入口；不包含收费的 A+B / C+D 组件。详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [厂商授权条款](https://vb-audio.com/Services/licensing.htm)。

使用指定播放设备的回环模式时，采集和译文播放应使用不同的音频路由。默认隔离采集模式允许共用播放设备。麦克风与扬声器同时使用时建议佩戴耳机，减少声学回声。

默认收听来源为“系统声音（排除本软件）”：使用 Windows 进程回环接口，采集其他应用在所有播放设备上的声音，并排除翻译引擎进程及其子进程的输出，双方译音都不会被本机再次送入模型。该功能需要 Windows build 20348 及以上版本（包含 Windows 11），无需附加驱动。采集组件不支持或启动失败时明确报错，不回退到会回采的设备模式。原来的“指定播放设备（回环采集）”仍可选，但禁止与任一译文输出使用同一设备。其他软件转播的回声及扬声器传入实体麦克风的声音不属于进程排除范围。

## 托盘、快捷键与运行时控制

关闭主窗口不会结束程序：翻译继续运行，程序收起到系统托盘。托盘 tooltip 与菜单首项显示当前状态（未启动 / 正在连接 / 正常翻译 / 音频异常 / 网络异常）。

左键单击托盘图标显示主窗口；右键单击打开托盘菜单。

全局快捷键的出厂默认值如下，可在“设置 → 快捷键”中录制和修改。修改后立即生效，重启后保留。

| 默认快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+Space` | 开始 / 停止同传 |
| `Ctrl+Shift+M` | 临时静音 / 取消静音发言通道 |
| `Ctrl+Shift+O` | 显示 / 隐藏字幕悬浮窗 |
| `Ctrl+Shift+L` | 开启 / 关闭收听通道 |
| `Ctrl+Shift+S` | 开启 / 关闭发言通道 |

托盘菜单提供同一套控制：当前状态、开始/停止同传、静音发言、收听通道、发言通道、字幕悬浮窗、显示主窗口、设置、退出应用。托盘、快捷键与主界面按钮共用同一个动作分发器，三者状态一致；正在启动或停止时重复触发不会创建第二个会话，250ms 内的重复按键会被忽略。快捷键由主程序注册，设置页只保存按键组合；某一项被其他软件占用时只影响该项，主界面会提示是哪一项注册失败。

同传进行中可以直接静音发言、开关收听与发言通道，不必停止会话。这些开关只作用于当前会话，**不写回设置文件**；重新开始同传后恢复为设置里的通道配置。关闭发言通道会同时解除静音，避免出现“通道已关却仍然静音、重新打开后没有声音”的状态。

## 字幕悬浮窗

用默认快捷键 `Ctrl+Shift+O`（可自定义）或托盘菜单打开：无边框、半透明、跨应用置顶、不占任务栏，可拖动、可缩放，只显示字幕本身（当前原文与译文、最近 3 条记录、错误提示），字号跟随设置里的“字幕大小”。

窗口按需创建并复用同一个实例，反复开关不会产生第二个窗口；隐藏或关闭悬浮窗、把主窗口收起到托盘，都不会中断正在进行的同传。

## 设置与安全

- API Key 保存在当前 Windows 用户的凭据管理器中，普通设置文件不含密钥；密钥绑定接口协议与完整地址，修改地址需要重新填写对应密钥。
- 设置 schema 为第 9 版。全局快捷键与应用设置一起保存；旧版配置自动补入原有五个默认组合键。旧版配置迁移为独立音色：保留发言端的音色选择，收听端改为系统音色；默认设备回环改为排除本软件的系统采集，保留显式选定的设备、通道及目标语言。旧服务商字段仅保留用于兼容，不参与启动请求。
- 从旧官方接口切换到新的默认接口时，旧密钥不会跨地址自动复用，请配置新接口的密钥。原有自定义实时接口地址会保留。
- 开发版与安装版使用独立的设置文件和凭据名称。
- 每次开始都会生成独立会话，停止后丢弃旧会话结果。退出时先请求关闭同传会话，再结束本地引擎。
- 前端只调用 Tauri 自定义命令，音频数据和 API Key 不暴露给 WebView。

## 开发运行

前置条件：Windows 11、Node.js 22.12 或更高版本、Rust stable MSVC 工具链，以及 Python 虚拟环境。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
cd desktop
npm install
npm run desktop:dev
```

也可从项目根目录运行 `scripts/run-tauri.ps1`。开发模式由 Rust 主进程启动 `scripts/tauri_bridge.py`；实时客户端使用 `websockets`，已包含在项目依赖和打包配置中。

## 安装与打包

只想使用、不打算改代码，请直接下载 [Releases](https://github.com/cyhddyx/simultaneous-translator/releases) 里的 `simultaneous-translator_x.y.z_x64-setup.exe`，不需要编译源码。

### 程序由两部分组成，缺一不可

| 组成 | 来源 | 发行版中的位置 |
| --- | --- | --- |
| Tauri 主程序 | Rust，前端产物内嵌其中 | `simultaneous-translator.exe` |
| Python 翻译引擎 | PyInstaller 打包 `scripts/tauri_bridge.py` | `translator-bridge.exe`，必须与主程序同目录 |

**引擎不是仓库里的文件。** `desktop/src-tauri/binaries/*.exe` 已被 `.gitignore` 排除，`build.rs` 也只调用 `tauri_build::build()`。因此 `cargo build`、`npx tauri build`、`npm run build` 都不会生成它。跳过这一步直接打包，程序能启动，但一开始同传就报“已打包的翻译引擎缺失。请重新安装应用。”，设置里的音频设备列表同样读不出来（设备枚举也要启动引擎）。

### 正确顺序（在项目根目录执行）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1   # 1. 建 .venv，安装 requirements.txt
cd desktop
npm install                                                    # 2. 安装前端依赖与 Tauri CLI
npm run desktop:build                                          # 3. 先生成 sidecar，再构建前端，最后 tauri build
```

`npm run desktop:build` 内部依次执行 `scripts/build-tauri-sidecar.ps1`（PyInstaller 6.22.2）与 `npx tauri build`；`tauri.conf.json` 的 `beforeBuildCommand` 负责前端 `npm run build`。请始终从这个命令入手，不要单独运行 `npx tauri build` 或 `cargo build`。

产物：

| 路径 | 用途 |
| --- | --- |
| `desktop/src-tauri/binaries/translator-bridge-x86_64-pc-windows-msvc.exe` | 打包用的中间产物，`externalBin` 会把它复制为安装目录下的 `translator-bridge.exe`，不要单独分发 |
| `desktop/src-tauri/target/release/bundle/nsis/同传翻译_<版本>_x64-setup.exe` | 可安装、可分发的安装包 |

改动 `scripts/*.py`（翻译引擎）之后必须重新运行 `npm run desktop:build`，否则安装包里的引擎仍是旧版本。

### 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 程序能打开，但开始同传、或在设置里读取音频设备时报“已打包的翻译引擎缺失。请重新安装应用。” | 发行版要求 `translator-bridge.exe` 与主程序同目录；直接运行 `target/release` 下的 exe，或只复制主程序，都会缺 | 使用 `npm run desktop:build` 产出的 NSIS 安装包；手工做免安装版时把 `simultaneous-translator.exe` 与 `translator-bridge.exe` 放在同一目录 |
| 开发模式报“未找到开发用 Python 引擎。请先运行 scripts\install.ps1。” | 缺 `.venv` 或 `scripts/tauri_bridge.py` | 先执行 `scripts\install.ps1` |
| `tauri build` 报找不到 external binary `translator-bridge-x86_64-pc-windows-msvc.exe` | 跳过了 sidecar 生成步骤 | 改用 `npm run desktop:build` |
| sidecar 生成成功，但启动后立刻退出并提示缺少 `dashscope`、`soundcard` 或 `websockets` | `.venv` 依赖不完整 | 重跑 `scripts\install.ps1` |

### 运行环境

- Windows 11 x64；进程级系统声音采集要求 Windows build 20348 及以上。
- WebView2 运行时，Windows 11 已内置。
- 从源码构建另需：Node.js 22.12 或更高版本、Rust stable MSVC 工具链，以及本机可用的 `python`（`scripts/install.ps1` 用它创建 `.venv`）。

## 测试

```powershell
.venv\Scripts\python.exe scripts\test_tauri_bridge.py
.venv\Scripts\python.exe scripts\test_audio_isolation.py
.venv\Scripts\python.exe scripts\test_runtime_channels.py
.venv\Scripts\python.exe scripts\test_runtime_integration.py
cd desktop\src-tauri
cargo test
cd ..
npm run build
npm run test:audio
npm run test:languages
npm run test:runtime
npm run test:subtitle
```

自动化用例覆盖模式配置、增量事件、语音解码、字幕配对、旧设置迁移与启动请求，以及运行时通道与静音状态机、字幕窗口挂载、字幕记录。`test_runtime_integration.py` 会真实启动 sidecar 进程、走完整 JSONL 协议（离线运行，不申请音频设备、不发起网络请求），可用 `--tier a|b|c|d|e` 分层执行。真实接口连通性、麦克风采集和扬声器播放需要使用有效 API Key 在 Windows 上联调；托盘菜单、全局快捷键与悬浮窗置顶等交互需要人工验收。

## 历史入口

`scripts/run.ps1` 为旧 Tk 排查入口，不属于本次 Tauri 单模型工作流。日常使用请运行 Tauri 桌面版。
