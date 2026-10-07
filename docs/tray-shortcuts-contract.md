# 托盘 / 全局快捷键 / 运行时状态契约（接口冻结 v1）

> 状态：**已冻结**。本文件由 Agent 0（技术负责人）维护。
> 任何跨模块字段变更必须先改本文件，再通知 Rust / Python / 前端 / QA 四个执行方。
> 冻结日期：2026-10-07。

---

## 1. 单一事实来源（Single Source of Truth）

| 事实 | 权威方 | 说明 |
|---|---|---|
| `trayStatus` | **Rust native `RuntimeState`** | 托盘图标、tooltip、菜单主状态、主界面状态文字都读它。前端**不得**自行推导主状态。 |
| `listenEnabled` / `speakEnabled` / `speakMuted` | **Python sidecar**（运行时有效值），Rust 缓存 | 前端只读 Rust 广播的值，不自行 toggle 本地布尔。 |
| `audioHealth` / `networkHealth` | **Python sidecar 事件 → Rust 汇总** | 由 sidecar 的 `audio.status` / `network.status` / `error.service` 驱动，**不**由 session phase 推断。 |
| `subtitleVisible` | **Rust native** | 由字幕窗口的实际 show/hide 结果决定。 |
| 字幕文本 / 会话详情 | 既有 `translator-event` | 本契约不改动既有 caption 协议。 |

> 硬性规则：**托盘菜单、全局快捷键、主界面按钮三者必须调用同一个 native action dispatcher**，
> 不允许任何一方各自实现 start/stop 或通道切换逻辑。

---

## 2. `RuntimeState`（Rust → 前端唯一运行时状态结构）

Rust 结构体 `RuntimeState`，`#[serde(rename_all = "camelCase")]`。

```ts
export type TrayStatus =
  | "not_started"    // 未启动
  | "connecting"     // 正在连接
  | "translating"    // 正常翻译
  | "audio_error"    // 音频异常
  | "network_error"; // 网络异常

/** 复用 desktop/src/types.ts 的 HealthStatus 取值。 */
export type RuntimeHealth = "unknown" | "connecting" | "ready" | "degraded" | "failed";

export interface ShortcutFailure {
  /** 规范化后的快捷键文本，例如 "Ctrl+Shift+Space"。 */
  accelerator: string;
  action: RuntimeAction;
  /** 注册失败原因，用于主界面提示。 */
  reason: string;
}

export interface RuntimeError {
  id: string;
  service: "audio" | "network" | "configuration" | "system";
  code: string;
  message: string;
  recoverable: boolean;
  sessionId: string | null;
}

export interface RuntimeState {
  /** 单调递增；前端丢弃 revision <= 当前值的更新。 */
  revision: number;
  trayStatus: TrayStatus;
  /** 复用既有 SessionPhase，Rust 侧由 sidecar state 事件维护。 */
  sessionPhase: "needs_configuration" | "idle" | "starting" | "listening" | "stopping" | "error";
  sessionId: string | null;
  audioHealth: RuntimeHealth;
  networkHealth: RuntimeHealth;
  /** 运行时有效值，不是设置文件里的值。 */
  listenEnabled: boolean;
  speakEnabled: boolean;
  speakMuted: boolean;
  subtitleVisible: boolean;
  /** 注册失败的快捷键；全部成功时为空数组。 */
  shortcutFailures: ShortcutFailure[];
  lastError: RuntimeError | null;
  /** RFC3339。 */
  updatedAt: string;
}
```

初始值（应用刚启动、尚未读取设置）：

```json
{
  "revision": 0,
  "trayStatus": "not_started",
  "sessionPhase": "idle",
  "sessionId": null,
  "audioHealth": "unknown",
  "networkHealth": "unknown",
  "listenEnabled": false,
  "speakEnabled": false,
  "speakMuted": false,
  "subtitleVisible": false,
  "shortcutFailures": [],
  "lastError": null,
  "updatedAt": "1970-01-01T00:00:00Z"
}
```

---

## 3. `trayStatus` 推导规则（Rust 内唯一实现）

优先级（高 → 低）：

```text
network_error  >  audio_error  >  connecting  >  translating  >  not_started
```

```rust
fn derive_tray_status(state) -> TrayStatus {
    if state.network_health == Failed { return NetworkError; }
    if state.audio_health   == Failed { return AudioError; }
    match state.session_phase {
        Starting | Stopping => Connecting,
        Listening if state.session_id.is_some() => Translating,
        _ => NotStarted,
    }
}
```

同时出现网络与音频错误时，托盘主状态显示「网络异常」，`lastError` 保留最近一条；
两个具体错误分别体现在主界面错误区，不互相覆盖。

状态文案（托盘 tooltip / 菜单首项 / 主界面共用，前端 `trayStatusLabel()` 必须与此一致）：

| trayStatus | 文案 |
|---|---|
| `not_started` | 未启动 |
| `connecting` | 正在连接 |
| `translating` | 正常翻译 |
| `audio_error` | 音频异常 |
| `network_error` | 网络异常 |

---

## 4. `RuntimeAction`（唯一动作模型）

```ts
export type RuntimeAction =
  | "start_or_stop_session"      // 开始 / 停止同传
  | "toggle_speak_mute"          // 临时静音 / 取消静音发言通道
  | "toggle_listen_channel"      // 开启 / 关闭收听通道
  | "toggle_speak_channel"       // 开启 / 关闭发言通道
  | "toggle_subtitle_window"     // 显示 / 隐藏字幕悬浮窗
  | "show_main_window"           // 显示主窗口（不切换任何开关）
  | "quit_application";          // 真正退出应用
```

Rust 侧 action 枚举的 serde 名与上表字符串**完全一致**（snake_case，无前缀）。

---

## 5. Tauri 命令（前端 → native）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_runtime_state` | 无 | `RuntimeState` | 启动 / 刷新后拉取初始状态。 |
| `dispatch_native_action` | `{ action: RuntimeAction }` | `RuntimeState` | 统一动作入口。 |

两者错误类型均为 `Result<_, String>`，字符串为**可直接展示给用户的中文提示**。

`dispatch_native_action` 语义：

- 返回**动作执行后**的最新 `RuntimeState`（revision 已自增）。
- 动作被幂等保护拒绝时**不报错**，返回当前状态；前端据返回值判断是否真的发生了变化。
- 真正的失败（例如 engine 启动失败）返回 `Err(中文信息)`，同时 `RuntimeState.lastError` 更新。
- 前端**不需要**再等待 `runtime-state` 事件来更新界面；命令返回值即权威快照。

---

## 6. Tauri 事件（native → **所有窗口**，含字幕窗口）

| 事件名 | payload | 说明 |
|---|---|---|
| `runtime-state` | `RuntimeState`（就是第 2 节结构本身，不是 envelope） | 任意字段变化时广播。 |
| `translator-event` | 既有协议，**不变** | sidecar 事件，既有前端逻辑继续消费。 |

- `runtime-state` 用 `app.emit()` 广播（不是 `emit_to`），主窗口与字幕窗口都能收到。
- 前端必须按 `revision` 丢弃过期更新。
- 只在**值真正变化**时广播（Rust 侧比较前后 `RuntimeState`），避免刷爆 Windows 托盘。

---

## 7. Action Dispatcher 契约（Rust）

```rust
fn dispatch_action(app: &AppHandle, action: RuntimeAction) -> Result<RuntimeState, String>
```

- `dispatch_action` 是**唯一**动作实现，以下三处必须调用它：
  1. 托盘菜单 `on_menu_event`
  2. 全局快捷键回调
  3. Tauri 命令 `dispatch_native_action`
- **幂等 / 防重入**：dispatcher 内部持有一把动作互斥锁（`Arc<Mutex<()>>` 或 `AtomicBool`）。
  - 正在 `starting` / `stopping` 时收到 `start_or_stop_session`：直接返回当前状态，**不**创建第二个 session。
  - 同一次按键因 Windows 重复消息触发两次时，第二次必须被去抖窗口（250ms）吞掉。
- dispatcher **不得**阻塞 Tauri 事件线程：涉及 sidecar IO 的动作放到后台线程 / `spawn_blocking`。
- 每个动作的语义：

| action | 前置条件 | 行为 | 失败时 |
|---|---|---|---|
| `start_or_stop_session` | — | 有 session → 走既有 `stop_translation` 路径；无 session → 走既有 `start_translation` 路径（含设置校验） | `Err` + `lastError` |
| `toggle_speak_mute` | 有活跃 session 且 `speakEnabled` | 向 sidecar 发 `set_speak_muted`（见 runtime-channel-control.md） | `Err` + `lastError` |
| `toggle_listen_channel` | 有活跃 session 且设置中 listen 启用 | 向 sidecar 发 `set_runtime_channel{channel:"listen"}` | `Err` + `lastError` |
| `toggle_speak_channel` | 有活跃 session 且设置中 speak 启用 | 向 sidecar 发 `set_runtime_channel{channel:"speak"}` | `Err` + `lastError` |
| `toggle_subtitle_window` | — | 见 subtitle-window.md | `Err` |
| `show_main_window` | — | `show()` + `unminimize()` + `set_focus()` | `Err` |
| `quit_application` | — | 置 `quitting=true` → `cleanup_engine()` → 关闭字幕窗口 → `app.exit(0)` | 不返回 |

**无活跃 session 时**：`toggle_*` / `start_or_stop` 之外的通道类动作返回
`Err("请先开始同传，再使用通道控制。")`；托盘与快捷键不得因此崩溃。

---

## 8. 全局快捷键

| 快捷键 | action | 说明 |
|---|---|---|
| `Ctrl+Shift+Space` | `start_or_stop_session` | 开始 / 停止同传 |
| `Ctrl+Shift+M` | `toggle_speak_mute` | 临时静音 / 取消静音发言通道 |
| `Ctrl+Shift+O` | `toggle_subtitle_window` | 显示 / 隐藏字幕悬浮窗 |
| `Ctrl+Shift+L` | `toggle_listen_channel` | 开启 / 关闭收听通道 |
| `Ctrl+Shift+S` | `toggle_speak_channel` | 开启 / 关闭发言通道 |

实现要求（全部为验收项）：

1. 插件：`tauri-plugin-global-shortcut = "2"`，在 `Builder` 上 `.plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(...).build())`。
2. **只响应 `ShortcutState::Pressed`**，忽略 `Released`。
3. 逐个注册（`register_all` 循环单项注册），**单项失败不影响其他项**；失败项写入
   `RuntimeState.shortcutFailures`（含 `accelerator` / `action` / `reason`），并在主界面给出可读提示。
4. 每个 action 维护 `last_fired: Instant`，250ms 内的重复触发直接丢弃。
5. 快捷键回调**只做一件事**：调用 `dispatch_action`。不在回调里写业务逻辑。
6. 主窗口隐藏、最小化、失焦时快捷键必须仍然生效（全局快捷键天然满足，需人工验证）。
7. 应用退出前 `unregister_all`；`quit_application` 路径必须成对注销。
8. 快捷键文本常量（用于 UI 展示与失败提示）：`Ctrl+Shift+Space`、`Ctrl+Shift+M`、`Ctrl+Shift+O`、`Ctrl+Shift+L`、`Ctrl+Shift+S`。

---

## 9. 系统托盘

- 托盘 id：`main-tray`；tooltip：`同传翻译 · <状态文案>`。
- 图标：复用既有 `icons/32x32.png`（`include_bytes!`），**不新增打包资源**。
  五种状态通过 tooltip + 菜单首项文本 + 菜单勾选体现（计划允许此简化，避免图标资源缺失风险）。
- 菜单 item id（稳定，不得随意改名）：

| id | 类型 | 文本 | 行为 |
|---|---|---|---|
| `tray-status` | 普通（disabled） | `<状态文案>` | 无 |
| `tray-start-stop` | 普通 | `开始同传` / `停止同传` | `start_or_stop_session` |
| `tray-speak-mute` | CheckMenuItem | `静音发言` | `toggle_speak_mute` |
| `tray-listen` | CheckMenuItem | `收听通道` | `toggle_listen_channel` |
| `tray-speak` | CheckMenuItem | `发言通道` | `toggle_speak_channel` |
| `tray-subtitle` | CheckMenuItem | `字幕悬浮窗` | `toggle_subtitle_window` |
| `tray-show` | 普通 | `显示主窗口` | `show_main_window` |
| `tray-settings` | 普通 | `设置` | `show_main_window` + 向前端发 `open-settings` 事件 |
| `tray-quit` | 普通 | `退出应用` | `quit_application` |

- 更新策略：持有 `TrayHandle`（托盘 + 各菜单项句柄），**只更新变化项**，不重建菜单。
- 主窗口关闭到托盘、菜单在窗口隐藏时可用，均为验收项。

---

## 10. 生命周期

| 事件 | 行为 |
|---|---|
| 主窗口 `CloseRequested`（`quitting == false`） | `api.prevent_close()` + `window.hide()`；翻译 session **不中断** |
| 主窗口 `CloseRequested`（`quitting == true`） | 放行 |
| 字幕窗口 `CloseRequested`（`quitting == false`） | `api.prevent_close()` + `hide()`；`subtitleVisible=false` |
| 托盘 `退出应用` / 快捷键以外的退出 | `quitting=true` → `cleanup_engine()` → `unregister_all()` → `app.exit(0)` |
| 进程退出 | sidecar 必须被 kill（既有 `cleanup_engine` 路径） |
| 单实例第二次启动 | 既有行为：显示、还原、聚焦主窗口 |

`quitting` 是 `RuntimeState` 之外的 native 标志（`Arc<AtomicBool>`），**不**进入 `RuntimeState`（前端不需要知道）。

---

## 11. 权限与能力（capabilities）

- 新增 `desktop/src-tauri/capabilities/subtitle-window.json`，`windows: ["subtitle"]`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "subtitle-window",
  "description": "Capabilities for the subtitle overlay window.",
  "windows": ["subtitle"],
  "permissions": [
    "core:event:default",
    "core:window:allow-start-dragging",
    "core:window:allow-close",
    "core:window:allow-set-always-on-top",
    "core:window:allow-start-resize-dragging"
  ]
}
```

- 既有 `default.json`（`windows: ["main"]`）保持不变，仅在其权限内按需补充
  `core:window:allow-hide` / `core:window:allow-show` **仅当**前端真的调用；否则不加。
- **刻意决策（偏离原计划，已批准）**：**不**把 `global-shortcut:*` 权限授予任何 WebView。
  五个快捷键全部在 Rust 侧注册，前端无注册能力，避免 WebView 劫持/注销快捷键。
  若后续确需前端管理快捷键，必须回到本文件重新评审。

---

## 12. 明确禁止

1. 托盘菜单、快捷键、主界面各自实现 start/stop。
2. 把 `speakMuted` 或运行时通道开关写回 `settings.json`。
3. 前端把 mock 运行时状态当作正式实现（mock 仅用于浏览器开发与单测）。
4. 前端自行推导 `trayStatus`。
5. 静音时调用 `stop` 关闭整个 session。
6. 跨模块私自改字段名、事件名、命令名。
