# 字幕悬浮窗契约（接口冻结 v1）

> 状态：**已冻结**。由 Agent 0 维护；Rust（窗口生命周期）与前端（渲染）双方按本文件实现。

---

## 1. 窗口标识与创建方式

| 项 | 值 |
|---|---|
| window label | `subtitle`（**固定，唯一**） |
| 创建方式 | **按需创建**（首次 `toggle_subtitle_window` 时），**不**写进 `tauri.conf.json` 的 `app.windows`，避免启动时无条件多一个 WebView |
| 复用规则 | 每次操作前先 `app.get_webview_window("subtitle")`；已存在则复用，**绝不重复创建** |
| URL | `WebviewUrl::App("index.html?window=subtitle".into())` |

前端判定当前上下文：

```ts
const params = new URLSearchParams(window.location.search);
const isSubtitleWindow = params.get("window") === "subtitle";
```

`desktop/src/main.tsx` 按此判定挂载 `<SubtitleWindow />` 或 `<App />`。**只此一处分支**。

---

## 2. 窗口属性（Rust `WebviewWindowBuilder`）

| 属性 | 值 | 理由 |
|---|---|---|
| `title` | `字幕悬浮窗` | 任务栏/可访问性 |
| `decorations(false)` | — | 无边框 |
| `transparent(true)` | — | 半透明背景 |
| `always_on_top(true)` | — | 跨应用置顶 |
| `skip_taskbar(true)` | — | 不占任务栏 |
| `resizable(true)` | — | 用户可调 |
| `shadow(false)` | — | 无边框下阴影会露出黑边 |
| `inner_size(880.0, 220.0)` | — | 初始尺寸 |
| `min_inner_size(420.0, 120.0)` | — | 最小可用尺寸 |
| `focused(false)` | — | 首次显示不抢主窗口焦点 |
| `visible(false)` 后显式 `show()` | — | 创建与显示解耦，避免闪白 |

> `transparent(true)` 要求前端根节点背景透明；CSS 见第 5 节。

---

## 3. 生命周期

| 场景 | 行为 |
|---|---|
| `toggle_subtitle_window` | 存在且可见 → `hide()`；否则创建（若不存在）+ `show()` + `set_always_on_top(true)`；随后更新 `RuntimeState.subtitleVisible` |
| `subtitle` 窗口 `CloseRequested`（非退出中） | `api.prevent_close()` + `hide()`；`subtitleVisible=false`；**不销毁共享会话** |
| 主窗口关闭到托盘 | 字幕窗口**保持原状**（不跟随隐藏） |
| `quit_application` | 关闭字幕窗口 → `cleanup_engine()` → `app.exit(0)` |
| 主窗口与字幕窗口同时收到关闭 | `quitting` 标志优先：退出中一律放行；非退出中一律 hide |
| 窗口内容刷新 / WebView 重载 | 通过 `getSnapshot()` 恢复字幕与状态，不依赖内存事件重放 |

---

## 4. 数据订阅（关键约束）

字幕窗口**不得**建立第二套翻译订阅协议。要求：

1. 复用既有 `translatorApi.subscribe()`（`translator-event`）与 `translatorApi.getSnapshot()`。
2. `app.emit()` 是广播语义，主窗口与字幕窗口都会收到同一份事件。
3. session id 过滤沿用 `desktop/src/tauri.ts` 既有逻辑，不得在字幕窗口另写一份。
4. 字体大小复用既有 `settings.subtitleSize`（`small | medium | large`），不新增设置项。
5. 运行时状态（托盘状态、静音、通道开关、错误）来自 `runtime-state` 事件 + `get_runtime_state`，
   **不**在字幕窗口重复推导。

> 明确禁止：字幕窗口自己 spawn 一个 sidecar 订阅、自己维护一套 revision 计数、
> 或把 `translator-event` 再包装成新的全局事件名。

---

## 5. UI 结构（`desktop/src/SubtitleWindow.tsx`）

```text
SubtitleWindow
├── 拖拽条（data-tauri-drag-region，显示状态点 + 运行状态文案 + 固定/关闭按钮）
├── 当前原文（partialTranscript）
├── 当前译文（partialTranslation，突出显示）
└── 错误提示（audio / network 区分文案，可关闭）
```

要求：

- **只显示字幕**：不出现设置入口、主控制栏、历史管理、会话控制按钮。
- 字幕窗口只显示当前会话的实时句子；历史会话和之前已完成的句子不在悬浮窗重复展示。
- 背景透明/半透明（默认 `rgba(15, 23, 42, 0.82)`），文字必须带足够对比度。
- 拖拽区使用 `data-tauri-drag-region`（依赖 capability `core:window:allow-start-dragging`）。
- 静音或通道关闭时用**图标 + 文字**体现，不允许只靠颜色。
- `subtitleSize` 映射：`small → 15px / medium → 19px / large → 24px`（译文行）。
- 小尺寸（420×120）下不得出现元素重叠；必要时隐藏拖拽条副标题。
- 无边框窗口需要可拖拽 + 可缩放；缩放依赖 `core:window:allow-start-resize-dragging`。

---

## 6. 样式约定

- 新增样式统一放 `desktop/src/styles.css` 末尾，类名以 `.subtitle-window` 前缀。
- 根节点透明：`html.subtitle-root, body.subtitle-root { background: transparent; }`
  （由 `SubtitleWindow.tsx` 在挂载时给 `document.documentElement` / `body` 加类，卸载时移除）。
- 主窗口样式**不得**因本次改动发生视觉回归。

---

## 7. 验收项

1. `Ctrl+Shift+O` 在主窗口可见、最小化、隐藏到托盘三种情况下都能切换字幕窗口。
2. 字幕窗口能跨应用置顶（覆盖在浏览器/编辑器上方）。
3. 字幕窗口隐藏、显示、关闭再打开**不影响**正在进行的翻译 session（无中断、无重复 session）。
4. 字幕窗口刷新后能恢复当前字幕与状态。
5. 反复 toggle 20 次不出现第二个 `subtitle` label 窗口（用 `webview_windows()` 数量验证）。
6. 主窗口与字幕窗口状态一致（同一 `runtime-state` revision）。
