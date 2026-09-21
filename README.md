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

## 设置与安全

- API Key 保存在当前 Windows 用户的凭据管理器中，普通设置文件不含密钥；密钥绑定接口协议与完整地址，修改地址需要重新填写对应密钥。
- 设置 schema 为第 8 版。旧版配置迁移为独立音色：保留发言端的音色选择，收听端改为系统音色；默认设备回环改为排除本软件的系统采集，保留显式选定的设备、通道及目标语言。旧服务商字段仅保留用于兼容，不参与启动请求。
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

## 打包

```powershell
cd desktop
npm run desktop:build
```

构建先生成 Python sidecar，再生成 Windows NSIS 安装程序，输出位于 `desktop/src-tauri/target/release/bundle/nsis`。

## 测试

```powershell
.venv\Scripts\python.exe scripts\test_tauri_bridge.py
.venv\Scripts\python.exe scripts\test_audio_isolation.py
cd desktop\src-tauri
cargo test
cd ..
npm run build
npm run test:audio
npm run test:languages
```

自动化用例覆盖模式配置、增量事件、语音解码、字幕配对、旧设置迁移与启动请求。真实接口连通性、麦克风采集和扬声器播放需要使用有效 API Key 在 Windows 上联调。

## 历史入口

`scripts/run.ps1` 为旧 Tk 排查入口，不属于本次 Tauri 单模型工作流。日常使用请运行 Tauri 桌面版。
