# 运行时通道控制契约（sidecar JSONL v1 增量）

> 状态：**已冻结**。由 Agent 0 维护；Python / Rust 双方按本文件实现。
> 兼容性要求：**纯增量**，既有 `start` / `stop` / `shutdown` / `probe.*` / `devices` / `ping` 的行为与字段一律不变。

---

## 1. 三种状态的区分（必须先理解再编码）

| 名称 | 存放位置 | 谁能改 | 语义 |
|---|---|---|---|
| **配置状态** `config.audio.<channel>.enabled` | `settings.json`（Rust） | 只有设置页保存 | 该通道是否被用户配置启用 |
| **运行时通道状态** `runtime.<channel>.enabled` | **仅内存**（Python session 对象） | 快捷键 / 托盘 / 主界面按钮 | 当前 session 是否真的接收该通道音频 |
| **发言静音状态** `speak_muted` | **仅内存**（Python session 对象） | `Ctrl+Shift+M` 等 | 发言通道仍然存在，但暂不向引擎提交麦克风音频 |

铁律：

1. 运行时开关**永不**写回设置文件。
2. session 停止后重新开始 → 运行时开关**恢复为配置默认值** `config.audio.<channel>.enabled`，`speak_muted = false`。
3. 配置中未启用的通道，运行时命令必须返回 `channel_not_configured` 错误，**不得**伪造「已开启」。
4. 关闭一个通道**不得**停止整个 realtime session（否则另一通道被误关）。
5. 恢复通道**不得**重新创建 session。

### 1.5 关闭发言通道必须同时解除静音（Agent 0 裁决，2026-10-07）

`set_runtime_channel{channel:"speak", enabled:false}` 在成功时，若 `speak_muted == true`，必须
**同时**把它置为 `false` 并补发一条 `runtime.mute{"muted":false}` 事件。

理由：

- 第 1 节把静音定义为「发言通道**仍然存在**，但暂不向引擎提交音频」。通道被关闭后，
  静音标志失去了作用对象，属于**幽灵状态**。
- 契约 §7 规定 `toggle_speak_mute` 的前置条件是 `speakEnabled`。若允许
  `speakMuted=true` 与 `speakEnabled=false` 并存，托盘上会出现「发言通道」未勾选、
  「静音发言」已勾选的矛盾显示，用户无法判断为什么没有声音。
- 若不解除，用户用 `Ctrl+Shift+S` 重新打开麦克风后会**仍然没有声音**，且原因不可见 ——
  这是本功能最容易被投诉的失效模式。

反向**不成立**：重新启用发言通道（`enabled:true`）**不得**改变 `speak_muted`。

事件顺序：sidecar 必须先发 `runtime.mute{"muted":false}`，再发 `runtime.channel{"enabled":false}`。
先解除静音再关通道，保证**任何中间态都是真实且契约合法的**，不会出现「通道已关 + 仍静音」的矛盾组合。

#### 1.5.0 更强保证：幂等关闭也要清掉幽灵静音（Agent 0 固化，2026-10-07）

实测（QA tier E，原始 JSONL 直连）确认的实现行为**强于**上文的最低要求，现予固化，禁止回退：

- 对**已经关闭**且 `changed:false` 的发言通道再次执行 `enabled:false` 时，**同样**要清掉可能存在的幽灵静音。
- 此时**只补发 `runtime.mute{"muted":false}`**，**不**补发 `runtime.channel` 事件 —— 后者符合第 4.2 节
  「仅在实际变化时发出」，通道值确实没变。

理由：任何能让 `speakEnabled=false && speakMuted=true` 并存的窗口都是本契约要消灭的对象，
与窗口多短无关。若未来有人把清理逻辑改成「只在 `changed` 时才执行」，即为**回退**，必须被 review 拦下。

#### 1.5.1 `set_speak_muted` 的拒绝口径边界（Agent 0 裁决，2026-10-07）

`set_speak_muted` 判定 `channel_not_configured` 用的是**配置状态**（`config.audio.speak.enabled`），
**不是**运行时状态。因此「运行时已关闭的发言通道仍可被置为静音」在 sidecar 层面是**允许**的，
且该行为有既有测试锁定（`test_mute_while_the_speak_channel_is_switched_off_is_still_allowed`）。

**裁决：维持现状，不收紧。** 理由：

1. §1.3 的原文就是按**配置**状态定义的，两处口径一致，不存在实现偏差。
2. 该路径**从应用内不可达**：`toggle_speak_mute` 的三个入口（主界面按钮、托盘菜单、全局快捷键）
   全部汇聚到 Rust 的 `dispatch_action`，而它对 `ToggleSpeakMute` 的前置检查是
   **运行时** `speak_enabled`（`desktop/src-tauri/src/tray.rs` 的 `toggle_speak_mute`），
   不满足时直接返回 `Err("发言通道未启用，无法静音。")`，**不会**把命令下发给 sidecar。
3. §1.5 已保证「关闭通道必定清静音」，所以即便有原始 JSONL 客户端绕过 Rust 直接调用，
   也无法造出**持久**的幽灵态；最多是一个随后被 §1.5 清掉的瞬时窗口。

> 若未来要让 sidecar 也按**运行时**状态拒绝，属于契约变更，必须先改本节并通知三方重新验证。
> 在那之前，任何"顺手收紧"都算违反契约。

### 1.6 `sessionPhase` 的归属边界

`sessionPhase` 由 Rust 侧 sidecar `state` 事件驱动（`starting` / `listening` / `stopping` / `stopped`）。
**sidecar 没有「配置不完整」这一概念**，因此 Rust 不会、也不应该上报 `needs_configuration`。

前端在「`runtime.sessionPhase === "idle"` 且本地设置校验判定配置不完整」时，可以本地显示
`needs_configuration` 以把用户导向设置页。这是**唯一**允许前端覆盖 `sessionPhase` 的例外，
且**不构成**对 `trayStatus` 的推导（契约 tray-shortcuts §12.4 只禁止推导 `trayStatus`）。

---

## 2. 请求（Rust → Python）

### 2.1 `set_runtime_channel`

```json
{
  "type": "request",
  "id": "3f1c...uuid",
  "command": "set_runtime_channel",
  "params": {
    "session_id": "b7d2...uuid",
    "channel": "listen",
    "enabled": false
  }
}
```

- `channel` ∈ `"listen" | "speak"`；其他值 → `invalid_channel`。
- `enabled` 必须是 JSON 布尔；否则 → `invalid_params`。
- `session_id` 必须等于当前活跃 session；不匹配 → `session_mismatch`。

### 2.2 `set_speak_muted`

```json
{
  "type": "request",
  "id": "9a44...uuid",
  "command": "set_speak_muted",
  "params": {
    "session_id": "b7d2...uuid",
    "muted": true
  }
}
```

- `muted` 必须是 JSON 布尔；否则 → `invalid_params`。
- 若发言通道当前未启用 → `channel_not_configured`（静音只对存在的通道有意义）。

---

## 3. 响应（Python → Rust）

### 3.1 成功

```json
{ "type": "response", "id": "3f1c...", "ok": true,
  "result": { "session_id": "b7d2...", "channel": "listen", "enabled": false, "changed": true } }
```

```json
{ "type": "response", "id": "9a44...", "ok": true,
  "result": { "session_id": "b7d2...", "muted": true, "changed": true } }
```

- `changed`：本次调用是否真的改变了状态。**重复设置同一个值是幂等成功**，返回 `ok:true` 且 `changed:false`（不是错误）。
- `result` 里的 `channel` / `enabled` / `muted` 是**生效后**的值。

### 3.2 失败

```json
{ "type": "response", "id": "3f1c...", "ok": false,
  "error": { "code": "session_mismatch", "message": "会话已结束或已被替换。" } }
```

错误码（稳定，Rust 侧可据此映射提示文案）：

| code | 触发条件 |
|---|---|
| `invalid_params` | 参数缺失、类型错误 |
| `invalid_channel` | `channel` 不是 `listen` / `speak` |
| `no_active_session` | 当前没有活跃 session |
| `session_mismatch` | `session_id` 与当前 session 不一致 |
| `channel_not_configured` | 配置中该通道 `enabled=false` |
| `internal_error` | 其他未预期错误 |

成功与失败**都**必须回一个 response，且 `id` 与请求一致。

---

## 4. 事件（Python → Rust，全部经 `translator-event` 转发）

### 4.1 既有事件（**不修改**）

`state`、`asr.status`、`audio.device`、`audio.ready`、`channel.status`、
`source.partial`、`source.final`、`translation.partial`、`translation`、
`translation.dropped`、`translation.failed`、`error`。

### 4.2 新增：运行时通道 / 静音

```json
{ "type": "event", "event": "runtime.channel", "session_id": "b7d2...",
  "data": { "channel": "listen", "enabled": false, "configured": true } }
```

```json
{ "type": "event", "event": "runtime.mute", "session_id": "b7d2...",
  "data": { "muted": true } }
```

- 语义：**生效后**的运行时状态。仅在实际变化时发出（幂等重复不重复发）。
- 有效通道值发生变化（例如配置未启用而被强制关闭）也要发。

### 4.3 新增：健康状态

```json
{ "type": "event", "event": "network.status", "session_id": "b7d2...",
  "data": { "status": "degraded", "detail": "WebSocket 重连中（第 2 次）" } }
```

```json
{ "type": "event", "event": "audio.status", "session_id": "b7d2...",
  "data": { "status": "failed", "channel": "listen", "detail": "音频设备已断开" } }
```

- `status` ∈ `"connecting" | "ready" | "degraded" | "failed"`。
- `audio.status` 的 `channel` 可选（缺省表示整条音频链路）。
- 仅在状态**变化**时发出。

### 4.4 `error` 事件扩展（**增量字段，向后兼容**）

```json
{ "type": "event", "event": "error", "session_id": "b7d2...",
  "data": {
    "scope": "asr",
    "service": "network",
    "code": "websocket_closed",
    "message": "翻译服务连接已断开。",
    "recoverable": true
  } }
```

- **新增** `service` ∈ `"audio" | "network" | "configuration" | "system"`。
- `scope` **保留**（既有前端 fallback 仍可用），值域不变。
- `recoverable` 保留。
- session id 在 envelope 层（`session_id`），不重复放进 `data`。

#### 必须上报的场景 → service / code 对照表

| 场景 | service | code | recoverable |
|---|---|---|---|
| 音频设备启动失败 | `audio` | `audio_start_failed` | `false` |
| 音频设备中断 | `audio` | `audio_device_lost` | `true` |
| WebSocket 连接失败 | `network` | `websocket_connect_failed` | `true` |
| WebSocket 重连中 | `network` | `websocket_reconnecting` | `true` |
| 服务端鉴权失败 | `network` | `auth_failed` | `false` |
| 翻译服务超时 / 断开 | `network` | `translation_timeout` / `translation_disconnected` | `true` |
| 配置非法（语言、设备等） | `configuration` | 既有 code 保持 | `false` |
| 其他引擎内部错误 | `system` | 既有 code 保持 | 按实际情况 |

> 既有 code 名（如 `asr_error`、`audio_playback_failed`）**不得改名**；
> 只允许**补充**上表新增的 code。

#### 4.4.1 Agent 0 裁决记录（2026-10-07，Agent 2 提出）

三条均由 Agent 0 裁定，**不做进一步代码改动**：

**D1 — `audio_start_failed` 保留为「已声明、当前不发出」（接受偏差）**

理由：契约同一条同时规定了「既有 code 名不得改名」。既有 `audio_device_missing`、
`audio_device_failed`、`audio_startup_timeout` 已经覆盖「音频设备启动失败」这一场景，
且 `test_tauri_bridge.py` 既有断言锁定了 `audio_startup_timeout`。
本表第 4.4 节的要求是**场景必须被上报**，而该场景已由 `service="audio"` 的错误上报覆盖。
强行改名或重复发一条 error 会造成同一故障双报，干扰主界面与托盘状态。

**替代判据**：凡「音频设备启动失败」场景，判定条件为
`error.service == "audio"`，**不**要求 `code == "audio_start_failed"`。
`audio_start_failed` 作为保留名，不得被其它场景占用。

**D2 — `websocket_reconnecting` 保留为「已声明、当前不发出」（接受偏差）**

理由：当前引擎**没有重连逻辑**——握手或接收失败即终止 session，不存在「重连中」这一真实状态。
为一个不存在的状态发事件属于伪造数据，会污染托盘状态。

**替代判据**：网络健康由 `network.status` 承载：
`degraded`（同一 session 中部分通道故障、sibling 仍存活）与 `failed`（全通道故障）。
依据契约第 3 节，只有 `failed` 会把 `trayStatus` 推成 `network_error`，`degraded` 不会。
`websocket_reconnecting` 保留给未来真正实现重连的版本。

**D3 — `recoverable` 取值修正：批准**

`realtime_voice_clone_unsupported`、`realtime_output_mismatch` 由 `true` 改为 `false`。
按本表「配置非法 → `false`」的口径，二者都是需要改设置才能恢复的配置类问题。

已核验无副作用：`recoverable` 在 Rust 侧**只**被存入 `RuntimeError`，源码中不存在
任何依赖 `recoverable` 的自动重启/重试分支；前端只用它决定是否显示「重试」入口，
配置类错误隐藏重试入口正是期望行为。

---

## 5. Rust 侧映射（Agent 1 按此实现）

`forward_engine_payload` 保持原样转发（sidecar 原始 JSON 直接进 `translator-event`），
另外在转发点旁路更新 `RuntimeState`：

| sidecar 事件 | RuntimeState 更新 |
|---|---|
| `state{state:"starting"}` | `sessionPhase=starting` |
| `state{state:"listening"}` | `sessionPhase=listening` |
| `state{state:"stopping"}` | `sessionPhase=stopping` |
| `state{state:"stopped"}` | `sessionPhase=idle`, `sessionId=null`, `audioHealth=unknown`, `networkHealth=unknown`, 通道状态复位 |
| `runtime.channel` | `listenEnabled` / `speakEnabled` |
| `runtime.mute` | `speakMuted` |
| `audio.status` | `audioHealth = status` |
| `network.status` | `networkHealth = status` |
| `error` | `lastError`；`service=="audio"` → `audioHealth=failed`；`service=="network"` → `networkHealth=failed`；`service=="configuration"/"system"` → 只记 `lastError` |

**session id 校验（硬性）**：所有事件在更新 `RuntimeState` 前必须比对
`payload.session_id` 与 `RuntimeState.sessionId`；不一致的事件直接丢弃，
防止旧 session 的事件覆盖新 session。

---

## 6. 音频侧安全开关（Python 实现要点）

1. **收听通道关闭**：停止向收听 session 送音频（在采集回调入口处丢弃该通道的帧），
   不关闭 realtime 连接、不停止另一通道。
2. **发言静音**：停止向发言 session 送麦克风音频，或在送入引擎前丢弃音频帧。
3. 恢复时**不重建** session。
4. 开关使用 `threading.Event` / `bool` + 轻量锁；**音频回调内不得做阻塞 IO**。
5. 音频采集线程与 bridge 主循环的锁顺序必须一致，避免死锁（参照既有 `_session_lock` 用法）。

---

## 7. 测试要求（Agent 2 自测 + Agent 4 复验）

- 参数校验：缺 `session_id` / `channel` 非法 / `enabled` 非布尔 → 对应错误码。
- `session_mismatch`：用旧 session id 调用必须失败且**不改变**任何状态。
- 幂等：连续两次 `set_speak_muted {muted:true}` → 第一次 `changed:true`，第二次 `changed:false`，都 `ok:true`。
- 静音后恢复：`muted:true` → `muted:false`，通道仍在。
- 单通道关闭时另一通道继续工作。
- 停止 session 后旧事件不发 / 不改变状态。
- `error` 事件的 `service` 分类正确。

测试文件：`scripts/test_tauri_bridge.py`（新增用例）、新增 `scripts/test_runtime_channels.py`。
运行方式（本机无 pytest）：

```powershell
cd E:\Project\translation\simultaneous-translator
.venv\Scripts\python.exe scripts\test_tauri_bridge.py
.venv\Scripts\python.exe scripts\test_runtime_channels.py
```
