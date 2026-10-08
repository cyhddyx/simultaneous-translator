# 音频设备测试向导设计

## 目标

在桌面应用的“设置 → 音频”中提供一个独立的设备测试向导，帮助用户验证播放设备、麦克风和播放设备回环链路是否可用。测试必须在本机完成，不调用翻译模型、不需要 API Key、不保存录音，也不修改已保存的音频设置。

## 范围

向导包含三个测试：

1. 播放测试音
2. 麦克风测试
3. 回环测试

设备来源复用现有的 `list_audio_devices` 结果。向导只允许一次运行一个测试。正在进行实时同传时，向导中的开始按钮不可用，并提示用户先停止同传；这样可以避免临时探测进程和实时引擎争用音频设备。

## 方案

采用独立的本地音频探测协议。React 通过 Tauri 命令调用 Rust，Rust 按现有设备查询方式启动一次性 Python sidecar，sidecar 使用 `soundcard` 打开 Windows 音频端点并返回结果。探测过程不经过 WebView 的 Web Audio API，也不启动完整同传会话。

### 组件边界

- `desktop/src/SettingsDialog.tsx`：在音频设置区域增加向导入口，并传入当前设备列表和实时会话状态。
- `desktop/src/AudioDeviceTestWizard.tsx`：负责向导 UI、测试步骤状态、设备选择、进度和结果展示；不直接调用 Tauri，只使用 `translatorApi`。
- `desktop/src/audioDeviceTest.ts`：保存测试种类、结果类型和纯状态/展示辅助函数，供 UI 和 Node 测试复用。
- `desktop/src/tauri.ts`：增加 `translatorApi.runAudioTest`，统一浏览器 mock 与 Tauri 实现。
- `desktop/src-tauri/src/lib.rs`：增加 `run_audio_test` Tauri 命令，复用 `ProbeManager.audio_gate` 和 `run_probe_request`。
- `scripts/tauri_bridge.py`：处理 `audio_test` JSONL 请求，验证参数并返回统一结果。
- `scripts/livetranslate.py`：实现播放、麦克风录制和 WASAPI loopback 的一次性本地探测。

## 用户流程

### 入口

“设置 → 音频”的设备区域新增“打开设备测试向导”按钮。设备列表加载失败时仍允许打开向导，但没有可选设备时，测试按钮显示对应的缺失设备提示。

### 选择与执行

向导按测试类型提供三个入口。进入某一测试后：

- 播放测试音选择一个扬声器；默认选中系统默认播放设备。
- 麦克风测试选择一个麦克风；默认选中系统默认麦克风。
- 回环测试选择一个扬声器；默认选中系统默认播放设备，回环输入由该扬声器自动映射。

点击开始后锁定选择器和其他测试入口，显示“测试中”。测试完成后显示成功、未检测到信号或失败，并允许重试或返回选择其他测试。关闭按钮在空闲和完成状态可用，测试进行时先请求取消；若底层命令无法中断，则等待当前一次性探测返回后关闭。

### 测试定义

#### 播放测试音

- Python 生成固定采样率的短单声道正弦音（约 1 秒，频率固定为 440 Hz，振幅限制在安全范围）。
- 使用选定的 `soundcard` speaker 播放，正常结束即为成功。
- 结果包含设备 ID、实际耗时和说明文本；播放打开或写入失败作为可读错误返回。

#### 麦克风测试

- 使用选定的 `soundcard` microphone，以 16 kHz、单声道录制约 3 秒。
- 录音只保存在内存中，转为单声道后计算 `peak` 和 `rms`，随后释放 recorder。
- `peak` 达到固定检测阈值时标记 `detected: true`，否则返回“未检测到明显声音”；设备打不开、录制异常或没有有效采样作为失败。

#### 回环测试

- 使用选定扬声器对应的 WASAPI loopback microphone。
- 在同一探测线程中播放固定测试音，同时录制 loopback 约 1 秒。
- 对录到的采样计算 `peak` 和 `rms`；检测到超过阈值的信号才标记成功。
- 如果 loopback 端点不存在、播放失败或录音失败，返回失败及具体阶段说明。

## 协议

### 请求

Rust 发送 JSONL 命令 `audio_test`，参数结构如下：

```json
{
  "kind": "playback | microphone | loopback",
  "device_id": "optional Windows endpoint id"
}
```

`device_id` 必须是最近一次设备枚举返回的对应类型设备 ID。空 ID 表示使用系统默认设备。Python 端再次验证 `kind` 和设备存在性，不依赖前端校验。

### 成功结果

```json
{
  "ok": true,
  "kind": "playback",
  "device_id": "endpoint-id",
  "device_name": "Speakers",
  "duration_ms": 1024,
  "peak": 0.41,
  "rms": 0.18,
  "detected": true,
  "detail": "播放测试音成功"
}
```

`peak`、`rms` 在播放测试中可以为 `0`，`detected` 对播放测试表示播放操作成功；麦克风和回环测试使用它们表示是否检测到音频信号。

### 失败结果

设备不存在、参数非法或音频 API 异常通过既有 JSONL 错误信封返回，错误码统一为 `audio_test_failed` 或 `invalid_audio_test_request`，错误消息不得包含 API Key 或完整敏感路径。Rust 将 sidecar 错误原样转换为 Tauri `Err(String)`，前端用现有 `errorMessage` 逻辑展示。

## 并发与生命周期

- Rust 使用 `ProbeManager.audio_gate` 串行化设备枚举和设备测试。
- 每次测试启动一个临时 sidecar，请求完成后由 `run_probe_request` 关闭它，不复用实时翻译 sidecar。
- 前端用请求序号或 Abort-like 的本地状态标记忽略过期结果，关闭向导后旧结果不能覆盖下一次测试。
- 浏览器 mock 不访问真实设备：按测试类型等待短暂延迟后返回确定性的成功结果，方便开发预览和 UI 测试。

## 错误处理与文案

- 没有设备：显示“未找到可用的播放设备/麦克风”。
- 设备被占用或打开失败：显示底层错误并提示关闭占用设备后重试。
- 麦克风或回环无明显信号：这是测试完成但未通过，使用警告状态，不伪装成底层异常。
- 正在同传：显示“请先停止同传，再进行设备测试”。
- 探测锁被占用：显示“已有音频检测正在进行，请稍后重试”。

## 测试策略

- Python：为测试参数校验、固定音频波形生成、峰值/RMS/阈值判断和三种探测结果写单元测试；使用 fake speaker/microphone/recorder，测试不访问真实硬件。
- Rust：测试 `run_audio_test` 的命令注册和参数 JSON 映射，沿用现有 probe helper 测试风格。
- TypeScript：为 `audioDeviceTest.ts` 的 kind 校验、默认设备选择、结果状态归类和过期请求处理写 Node 测试。
- 前端构建：运行 `npm run build`，确认向导组件、图标和样式类型检查通过。
- Windows 人工验证：在真实设备上分别执行播放、麦克风和回环测试；断开设备、静音麦克风及正在同传时检查错误文案。

## 非目标

- 不保存或回放用户麦克风录音。
- 不改变系统默认输入/输出设备。
- 不修改音频通道设置，不自动启用或禁用收听/发言通道。
- 不验证 API Key、网络、翻译模型或虚拟麦克风安装状态。
