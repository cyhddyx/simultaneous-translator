# 同传翻译（Tauri 桌面版）

面向 Windows x64 的桌面同传工具。它采集默认播放设备的 WASAPI 回环音频，通过 DashScope 进行流式识别，再调用用户选定的 Gemini Developer API 或 OpenAI 兼容服务生成译文。界面采用 Tauri + React，翻译引擎作为受 Rust 主进程管理的本地 sidecar 运行，网页层不具备任意命令执行权限。

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

- DashScope 地址只接受 `wss://`；翻译服务地址只接受 `https://`。地址中的凭据、查询参数和片段会被拒绝。
- 翻译服务商可以选择 Gemini Developer API 或 OpenAI 兼容协议。每个服务商独立保存地址、API Key 和模型列表，并可指定一个当前使用的模型。
- 模型既可手动添加，也可尝试从服务商获取；部分中转服务不提供模型列表，此时手动模型仍可正常使用。
- `DASHSCOPE_API_KEY` 与默认 Gemini 服务商的 `GEMINI_API_KEY` 环境变量优先；在设置页填写的密钥会写入当前 Windows 用户的凭据管理器，而不是 JSON 设置文件。
- 已保存密钥会绑定到对应的接口协议和完整服务地址。修改服务地址或协议后必须重新输入密钥，避免旧密钥被意外发送到新的服务商或网关路径；已有地址绑定的旧版密钥会在首次启动时安全迁移。
- 旧版若仅通过环境变量向自定义中转地址提供密钥、且凭据管理器中没有地址绑定，升级后不会自动授权该地址。请在设置页为该服务商明确填写并保存一次 API Key；官方默认地址上的环境变量不受影响。
- 普通偏好设置保存在 Tauri 的应用配置目录中，不包含 API Key。
- 开发版与正式安装版使用彼此独立的设置文件和 Windows 凭据名称；本地调试时添加的服务商与 API Key 不会出现在安装版中。
- 旧版本若曾使用未启用 Windows 持久化后端的凭据组件，进程退出后密钥无法恢复。升级到新安装包后需要重新填写一次，之后会持久保存在 Windows 凭据管理器中。
- 每次开始同传都会生成独立会话 ID。停止后，旧会话的识别和翻译结果会被丢弃，避免重新开始后字幕串扰。
- 状态栏只在收到真实数据后才把服务标为“已连接”：DashScope SDK 在 WebSocket 握手完成前就会回调“已打开”，所以语音识别在识别出第一句话之前显示“连接中”，翻译服务在第一条译文返回之前同样显示“连接中”。完全静音时停留在“连接中”是正常的。
- 停止同传或关闭窗口时，应用会先请求引擎关闭识别流并等待最多 1 秒，之后才结束进程，避免把 DashScope 的识别任务遗留到服务端超时。
- 翻译请求使用流式响应（OpenAI 协议为 `stream: true`，Gemini 为 `:streamGenerateContent?alt=sse`）。超时因此只衡量“连接是否还在说话”：静默超过 12 秒才判定断流，整条响应另有 45 秒上限。慢模型不会仅因为生成时间长就失败。若中转服务忽略流式标志并返回完整响应体，引擎会自动按非流式解析，不会丢失译文。
- 翻译模型默认关闭思考模式：OpenAI 兼容协议在请求体中发送 `"thinking": {"type": "disabled"}`，Gemini 发送 `thinkingConfig.thinkingBudget = 0`。逐句字幕等不起一段思维链，而且思考模式会忽略温度设置。这个字段各家写法不同，若服务商以 400 或 422 拒绝，引擎会立即不带该字段重试一次，并在本次会话内不再发送，只在第一句话上浪费一次往返。
- 翻译队列有固定上限；连接或翻译失败会显示在应用内，而不会阻塞 UI。

默认采集 Windows 默认播放设备的回环声音，不使用麦克风。切换输出设备后，请停止并重新开始同传。

## 打包安装程序

发布命令会先自动构建 Python 翻译引擎 sidecar，再生成 NSIS 安装程序：

```powershell
cd desktop
npm run desktop:build
```

生成的安装程序位于 `desktop/src-tauri/target/release/bundle/nsis`。sidecar 会包含音频和模型客户端依赖，安装包体积会明显大于纯 Tauri 应用。若仅需要单独更新 sidecar，也可以运行 `scripts/build-tauri-sidecar.ps1`。

## 旧入口

`scripts/run.ps1` 仍可启动旧的 Tk 窗口，供兼容性排查使用；它不支持多服务商和自定义模型管理，并且仍会把两个 API Key 以明文写入 `%APPDATA%\SimultaneousTranslator\config.json`。新功能和日常使用应以 Tauri 桌面版为准。
