# 同传翻译（Tauri 桌面版）

面向 Windows x64 的桌面同传工具，提供两种翻译引擎：

- **管线翻译**：采集默认播放设备的 WASAPI 回环音频，通过 DashScope 进行流式识别，再调用用户选定的 Gemini Developer API 或 OpenAI 兼容服务生成译文，输出字幕。
- **实时同传**：接入 Qwen LiveTranslate 实时模型（`qwen3.5-livetranslate-flash-realtime` 等），一条 WebSocket 同时完成识别、翻译与语音合成，并按“对方 → 我”和“我 → 对方”两个方向分别采集与播放音频。

界面采用 Tauri + React，翻译引擎作为受 Rust 主进程管理的本地 sidecar 运行，网页层不具备任意命令执行权限。

## 实时同传

### 两个通道

| 通道 | 默认输入 | 作用 |
| --- | --- | --- |
| 收听通道（对方 → 我） | 系统声音（WASAPI 回环） | 把对方说的话翻译成我的语言，播放给我听 |
| 发言通道（我 → 对方） | 麦克风 | 把我说的话翻译成对方的语言，送到指定播放设备 |

两个通道各自独立连接模型、独立选择语言和播放设备，可单独启用。模型语音输出使用的采样率是 24 kHz，输入是 16 kHz，均为单声道 PCM，均由引擎按 100 ms 分片收发。

### 把译文“发出去”

应用只能把译文播放到某个 Windows 播放设备。要让它进入会议软件或通话的另一端，需要系统级虚拟声卡（例如 VB-CABLE、VoiceMeeter、网易虚拟音频设备）：

1. 安装虚拟声卡，它在系统中会同时出现一个播放设备和一个录音设备。
2. 在“设置 → 音频 → 发言通道”里，把**译文播放设备**指向该虚拟声卡的**播放端**。
3. 在会议软件里，把麦克风指向该虚拟声卡的**录音端**。

此时对方听到的就是你的英文译文。若希望会议软件也能听到你自己的原声，请使用 VoiceMeeter 之类的混音器，或直接把虚拟声卡设为系统默认设备后自行叠加。

双向同时开启时请佩戴耳机：否则“收听通道”播放的译文会被回环再次采集，形成回声。

### 音色与语言

- 音色留空表示使用服务默认音色，也可填写模型支持的具体音色名。
- 开启“音色克隆”后，译文会尽量保留说话人音色；克隆频率可选“不自动克隆 / 首次克隆后复用 / 每次重新克隆”。
- 语言下拉中的名称会映射为模型要求的语言代码（如“简体中文”对应 `zh`，“English”对应 `en`）。未识别的取值回退到 `en`，源语言“自动检测”对应 `auto`。

### 实时同传与管线翻译的差异

- 实时同传只需要一个 DashScope API Key；管线翻译需要 DashScope 识别 Key 加一个文本翻译服务商 Key。设置页会按当前引擎只要求所需的那一个。
- 实时同传没有本地翻译队列：翻译在模型侧完成，字幕由服务端事件直接生成。
- 实时同传的对齐依据是服务端事件序列：语音识别完成事件与翻译完成事件可能以任意顺序到达，引擎会把它们合并成同一条字幕，不会重复或丢失原文。

## 开发运行

前置条件：Windows 11、Node.js 22.12 或更高版本、Rust stable MSVC 工具链，以及 Python 虚拟环境。

1. 安装 Python 依赖（首次需要）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
   ```

2. 安装桌面端依赖并启动应用：

   ```powershell
   cd desktop
   npm install
   npm run desktop:dev
   ```

也可以在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-tauri.ps1
```

开发模式下，Rust 主进程直接启动 `scripts/tauri_bridge.py`。前端的开始、停止和设置操作仅调用 Tauri 自定义命令；音频数据和 API Key 不会暴露给 WebView。

## 设置与安全

- DashScope 地址只接受 `wss://`（含实时同传的 `/api-ws/v1/realtime`）；翻译服务地址只接受 `https://`。地址中的凭据、查询参数和片段会被拒绝，模型名由引擎以 `?model=` 形式附加。
- 翻译服务商可以选择 Gemini Developer API 或 OpenAI 兼容协议。每个服务商独立保存地址、API Key 和模型列表，并可指定一个当前使用的模型。
- 模型既可手动添加，也可尝试从服务商获取；部分中转服务不提供模型列表，此时手动模型仍可正常使用。
- `DASHSCOPE_API_KEY` 与默认 Gemini 服务商的 `GEMINI_API_KEY` 环境变量优先；在设置页填写的密钥会写入当前 Windows 用户的凭据管理器，而不是 JSON 设置文件。实时同传密钥独立保存，与语音识别密钥互不影响。
- 已保存密钥会绑定到对应的接口协议和完整服务地址。修改服务地址或协议后必须重新输入密钥，避免旧密钥被意外发送到新的服务商或网关路径；已有地址绑定的旧版密钥会在首次启动时安全迁移。
- 旧版若仅通过环境变量向自定义中转地址提供密钥、且凭据管理器中没有地址绑定，升级后不会自动授权该地址。请在设置页为该服务商明确填写并保存一次 API Key；官方默认地址上的环境变量不受影响。
- 普通偏好设置保存在 Tauri 的应用配置目录中，不包含 API Key。设置文件 schema 已升级到第 5 版；旧文件会以“管线翻译”载入，升级不会静默改变音频处理方式。
- 开发版与正式安装版使用彼此独立的设置文件和 Windows 凭据名称；本地调试时添加的服务商与 API Key 不会出现在安装版中。
- 旧版本若曾使用未启用 Windows 持久化后端的凭据组件，进程退出后密钥无法恢复。升级到新安装包后需要重新填写一次，之后会持久保存在 Windows 凭据管理器中。
- 每次开始同传都会生成独立会话 ID。停止后，旧会话的识别和翻译结果会被丢弃，避免重新开始后字幕串扰。
- 状态栏只在收到真实数据后才把服务标为“已连接”：DashScope SDK 在 WebSocket 握手完成前就会回调“已打开”，所以语音识别在识别出第一句话之前显示“连接中”，翻译服务在第一条译文返回之前同样显示“连接中”。完全静音时停留在“连接中”是正常的。实时同传模式下“同传通道”状态块分别显示两个通道的进度。
- 停止同传或关闭窗口时，应用会先请求引擎关闭识别流或发送 `session.finish`，等待最多 3 秒（实时同传会等服务端回 `session.finished`，否则最后一句会被丢弃），之后才结束进程。
- 翻译请求使用流式响应（OpenAI 协议为 `stream: true`，Gemini 为 `:streamGenerateContent?alt=sse`）。超时因此只衡量“连接是否还在说话”：静默超过 12 秒才判定断流，整条响应另有 45 秒上限。慢模型不会仅因为生成时间长就失败。若中转服务忽略流式标志并返回完整响应体，引擎会自动按非流式解析，不会丢失译文。
- 翻译模型默认关闭思考模式：OpenAI 兼容协议在请求体中发送 `"thinking": {"type": "disabled"}`，Gemini 发送 `thinkingConfig.thinkingBudget = 0`。逐句字幕等不起一段思维链，而且思考模式会忽略温度设置。这个字段各家写法不同，若服务商以 400 或 422 拒绝，引擎会立即不带该字段重试一次，并在本次会话内不再发送，只在第一句话上浪费一次往返。
- 连接层失败会换一条新连接重试，而不是直接丢掉这句字幕。整个会话复用同一个连接池，中转、代理或网关关闭空闲的 keep-alive 连接后，下一句翻译会立即失败在 `[SSL: UNEXPECTED_EOF_WHILE_READING]` 或被截断的响应体上。这类失败最多重试 3 次，且只在该句已耗时 8 秒之内才继续重试；仍然失败才显示“与翻译服务的网络连接中断”，并附上原始错误。HTTP 状态码错误、流内返回的错误对象和静默超时不重试，重试它们只会拖慢排在后面的句子。设置页的“检测”按钮只报告第一次尝试的结果，以便如实反映当前网络状况。
- 翻译队列有固定上限；连接或翻译失败会显示在应用内，而不会阻塞 UI。

管线翻译默认采集 Windows 默认播放设备的回环声音，不使用麦克风。切换输出设备后，请停止并重新开始同传。

## 实时同传的构建与打包说明

- 实时客户端基于 `websockets`（`requirements.txt` 已声明）。打包脚本为它加入了 `websockets.asyncio.client` / `websockets.asyncio.server` 的 hidden import。
- 实时同传的音频设备列表由 sidecar 通过 WASAPI 枚举，设置页打开时各执行一次独立的短进程查询，不影响正在进行的会话。
- 模型名可自行修改。旧的 `qwen3-livetranslate-flash-realtime` 与新的 `qwen3.5` / `qwen3.8` 在会话配置上存在差异（`modalities` 与 `output_modalities`），引擎会先按模型名选择写法，被服务端拒绝时自动改用另一种，仍失败才报错。
- 译文语音输出的采样率按服务约定固定为 24 kHz。若某个模型版本改变了输出编码，需要同步修改 `scripts/livetranslate.py` 中的 `OUTPUT_SAMPLE_RATE`。

## 打包安装程序

发布命令会先自动构建 Python 翻译引擎 sidecar，再生成 NSIS 安装程序：

```powershell
cd desktop
npm run desktop:build
```

生成的安装程序位于 `desktop/src-tauri/target/release/bundle/nsis`。sidecar 会包含音频和模型客户端依赖，安装包体积会明显大于纯 Tauri 应用。若仅需要单独更新 sidecar，也可以运行 `scripts/build-tauri-sidecar.ps1`。

## 测试

```powershell
# 引擎：协议解析、字幕配对、通道回收（离线）
.venv\Scripts\python.exe scripts\test_tauri_bridge.py

# 桌面端：设置迁移与请求构造
cd desktop\src-tauri
cargo test
```

## 旧入口

`scripts/run.ps1` 仍可启动旧的 Tk 窗口，供兼容性排查使用；它不支持多服务商、自定义模型管理和实时同传，并且仍会把两个 API Key 以明文写入 `%APPDATA%\SimultaneousTranslator\config.json`。新功能和日常使用应以 Tauri 桌面版为准。
