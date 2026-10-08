# 测试矩阵（托盘 / 快捷键 / 运行时通道 / 字幕窗口）

> 维护者：Agent 4 / `qa-verifier`
> 契约依据：`docs/tray-shortcuts-contract.md`（简称 **T**）、`docs/runtime-channel-control.md`（**R**）、`docs/subtitle-window.md`（**S**）
> 状态口径：**通过 / 失败 / 阻断 / 未验证**。未实测的一律写「未验证」，不写「通过」。

---

## 1. 覆盖层级与自动化入口

| 层级 | 命令（工作目录） | 覆盖对象 | 归属 |
|---|---|---|---|
| L1 Rust 单测 | `cd desktop\src-tauri; cargo test` | `RuntimeState` 推导、动作去抖、旧 session 丢弃、设置迁移 | `rust-native` 自测 + 本文件复验 |
| L2 Python 单测 | `.venv\Scripts\python.exe scripts\test_tauri_bridge.py`、`scripts\test_audio_isolation.py`、`scripts\test_runtime_channels.py` | 请求校验、错误码、会话隔离、音频安全开关 | `python-bridge` 自测 + 本文件复验 |
| L3 跨模块集成 | `.venv\Scripts\python.exe scripts\test_runtime_integration.py` | **真实 sidecar 进程 + 真实 JSONL** 的完整链路；tier A 真实引擎 / tier B 离线桩 / **tier C 反向验证（D1/D2）** | **本文件（QA 独立实现）** |
| L4 前端类型/构建 | `cd desktop; npm run build` | TS 类型、打包 | `frontend` 自测 + 本文件复验 |
| L5 前端单测 | `cd desktop; npm run test:audio`、`npm run test:languages`、其余 node 测试 | 纯函数与 mock 控制器 | `frontend` 自测 + 本文件复验 |
| L6 浏览器自动化 | `node E:\Project\translation\_tray-shortcut-check.cjs` | 浏览器 mock 下的运行时状态 UI 接线 | **本文件（QA 独立实现）** |
| L7 静态契约核对 | `python E:\Project\translation\_tray-shortcuts-acceptance.py` | 三层字段/命令/事件名字面量 | Lead 提供，本文件记录局限 |
| L8 Windows 人工联调 | `docs/qa/manual-checklist.md` | 托盘、全局快捷键、置顶、真实音频/网络 | **人工，未自动化** |
| L9 安装版 | `npm run desktop:build` + NSIS 安装 | 打包后同一组行为 | **待 Lead 授权** |

> **L3 的边界（重要）**：L3 的 Tier B 用离线桩替换 `livetranslate.LiveTranslateChannel.run`
> （无麦克风、无 WebSocket），**其余全部是真实代码**：真实 `scripts/tauri_bridge.py`
> 源码经 `runpy` 执行、真实 `RealtimeSession` 状态机、真实请求分发与事件发射。
> Tier A 完全不使用桩（真实引擎），只覆盖不需要活跃 session 的路径。
> 因此 **L3 不能证明「关通道后麦克风帧真的不再进入引擎」**，该项只有 L2 与 L8 覆盖。

---

## 2. 维度定义

| 维度 | 取值 |
|---|---|
| 窗口状态 | 主窗口可见 / 主窗口最小化 / 主窗口隐藏到托盘 / 主窗口失焦（前台为其他应用） |
| 会话阶段 | `needs_configuration` / `idle` / `starting` / `listening` / `stopping` / `error` |
| 通道组合 | 仅收听 / 仅发言 / 收+发 / 静音中 / 关收听 / 关发言 |
| 音频设备 | 默认设备正常 / 无输入设备 / 设备被拔出 / 无输出设备 / 设备被独占 |
| 网络 | 正常 / 连接中 / 断线重连 / 鉴权失败 / 超时 |
| 字幕窗口 | 未创建 / 已创建隐藏 / 已显示 / 已显示且刷新 / 反复 toggle |
| 版本 | 开发版（`npm run dev` + `cargo`） / 安装版（NSIS 安装后） |

---

## 3. 矩阵 A：托盘 × 快捷键 × 窗口状态

| ID | 场景 | 预期（契约） | 覆盖 | 状态 |
|---|---|---|---|---|
| A-01 | 应用刚启动 | `RuntimeState` 初始值 = T §2 初始 JSON；`trayStatus=not_started` | L1 | 见 reverification |
| A-02 | 托盘图标与 tooltip | 托盘 id `main-tray`，tooltip `同传翻译 · <状态文案>`（T §9） | L7 + L8 | 未验证（需人工） |
| A-03 | 托盘菜单 9 个 item id | `tray-status/tray-start-stop/tray-speak-mute/tray-listen/tray-speak/tray-subtitle/tray-show/tray-settings/tray-quit`（T §9） | L7 | 见 reverification |
| A-04 | `tray-status` 文案五态 | 未启动/正在连接/正常翻译/音频异常/网络异常（T §3 表） | L1 + L5 | 见 reverification |
| A-05 | `trayStatus` 优先级 | `network_error > audio_error > connecting > translating > not_started`（T §3） | L1 | 见 reverification |
| A-06 | 同时音频+网络错误 | 主状态显示「网络异常」；`lastError` 保留最近一条；两个错误在错误区都可见（T §3） | L1 + L5 | 见 reverification |
| A-07 | 三入口同一 dispatcher | 托盘菜单 `on_menu_event`、快捷键回调、`dispatch_native_action` 都调用同一 `dispatch_action`（T §7） | L7 | 见 reverification |
| A-08 | 主窗口关闭（未退出） | `prevent_close()` + `hide()`，session **不中断**（T §10） | L1 + L8 | 未验证（需人工） |
| A-09 | 主窗口隐藏时托盘右键菜单 | 菜单可用，`显示主窗口` 能恢复且 `unminimize+focused`（T §9/§7） | L8 | 未验证（需人工） |
| A-10 | `启动/停止` 幂等 | `starting`/`stopping` 期间再次触发 → 返回当前状态，**不创建第二个 session**（T §7） | L1 + L3 | 见 reverification |
| A-11 | 快捷键去抖 | 同一 action 250ms 内重复触发被丢弃（T §8.4） | L1 | 见 reverification |
| A-12 | 只响应 Pressed | 忽略 `ShortcutState::Released`（T §8.2） | L7 + L8 | 部分（静态核对 + 人工） |
| A-13 | 单项注册失败不影响其他 | 失败项进 `shortcutFailures` 并给出可读提示（T §8.3） | L7 + L8 | 部分 |
| A-14 | 全局快捷键 5 个 | `Ctrl+Shift+Space/M/O/L/S`（T §8） | L7 + L8 | 部分（注册项静态核对；真实触发需人工） |
| A-15 | 主窗口隐藏/最小化/失焦时快捷键仍生效 | 全局快捷键天然满足（T §8.6） | L8 | 未验证（需人工） |
| A-16 | 退出路径注销快捷键 | `quit_application` → `unregister_all`（T §8.7） | L7 + L1 | 部分 |
| A-17 | 单实例第二次启动 | 显示、还原、聚焦主窗口（T §10） | L8 | 未验证（既有行为，回归项） |
| A-18 | `runtime-state` 事件广播 | `app.emit()`，主窗口与字幕窗口都收到；payload 就是 `RuntimeState` 本身（T §6） | L7 | 见 reverification |
| A-19 | 仅值变化时广播 | 前后比较，无变化不发（T §6） | L1 | 见 reverification |
| A-20 | 动作失败 | 返回 `Err(中文提示)` 且 `lastError` 更新（T §5/§7） | L3 + L1 | 见 reverification |

## 4. 矩阵 B：运行时通道 × 静音（L3 主战场）

| ID | 场景 | 预期（契约） | 覆盖 | 状态 |
|---|---|---|---|---|
| B-01 | `set_runtime_channel` 关闭收听 | `ok:true, changed:true`，`result` 回显生效后 `channel/enabled/session_id`（R §2.1/§3.1） | L3 | 见 reverification |
| B-02 | 幂等重放同值 | `ok:true, changed:false`，**不是错误**（R §3.1） | L3 | 见 reverification |
| B-03 | 事件 `runtime.channel` | `{channel, enabled, configured:true}`，仅在真正变化时发（R §4.2） | L3 | 见 reverification |
| B-04 | `set_speak_muted` 静音 | `ok:true, changed:true`，事件 `runtime.mute {muted:true}`（R §2.2/§4.2） | L3 | 见 reverification |
| B-05 | 重复静音 | 第二次 `changed:false`，且**不重复发** `runtime.mute` | L3 | 见 reverification |
| B-06 | 取消静音 | `changed:true`，通道仍在，**无 `stopped` 事件** | L3 | 见 reverification |
| B-07 | 关一个通道不停整个 session | 关闭收听期间发言通道仍可操作，`state` 不变 `stopped`（R §1.4） | L3 | 见 reverification |
| B-08 | 未配置通道 | `channel_not_configured`，**不得伪造已开启**（R §1.3/§2.2） | L3 | 见 reverification |
| B-09 | `channel` 非法 | `invalid_channel`（R §2.1） | L2 + L3 | 见 reverification |
| B-10 | `enabled` / `muted` 非布尔 | `invalid_params`（R §2.1/§2.2） | L2 + L3 | 见 reverification |
| B-11 | 缺 `session_id` | `invalid_params`（R §2.1） | L2 + L3 | 见 reverification |
| B-12 | 无活跃 session | `no_active_session`（R §3.2） | L2 + L3 | 见 reverification |
| B-13 | 旧 session id | `session_mismatch`，且**不改变任何状态、不发事件**（R §3.2/§7） | L3 | 见 reverification |
| B-14 | stop 后旧事件不发 | 停止后不再有该 session 的 `runtime.*` 事件（R §5/§7） | L3 | 见 reverification |
| B-15 | 重启后运行时开关复位 | 重新 start → 通道回到 `config.audio.<channel>.enabled`，`speak_muted=false`（R §1.2） | L3 | 见 reverification |
| B-16 | 运行时开关不写回设置 | 反复切换后 `settings.json` **不变**（R §1.1/T §12.2） | L2 + L8 | 部分（L2 进程内断言；安装版需人工核对文件） |
| B-17 | 恢复通道不重建 session | 关闭→恢复期间无新 session（无 `state: starting`，session_id 不变）（R §1.5/§6.3） | L3 | 见 reverification |
| B-18 | 音频帧真的被拦截 | 关收听/静音后麦克风帧不再进入引擎（R §6.1/§6.2） | L2 + L8 | **未验证**（L3 用离线桩，无法证明物理链路） |
| B-19 | 音频回调无阻塞 IO | 采集回调内不做阻塞读（R §6.4） | 代码评审 | **未验证**（仅人工审阅，无自动化） |
| B-20 | 锁顺序无死锁 | 采集线程与主循环锁顺序一致（R §6.5） | L2 + L8 | 部分 |
| B-21 | `id` 回显 | 成功与失败都回 response 且 `id` 与请求一致（R §3） | L3 | 见 reverification |
| B-22 | **§1.5 关通道必清静音** | `set_runtime_channel{speak,false}` 成功时若 `speak_muted=true`，必须同时置 false 并补发 `runtime.mute{false}` | L3-E | 见 reverification |
| B-23 | **§1.5 事件顺序** | 必须**先** `runtime.mute{muted:false}`、**后** `runtime.channel{speak,enabled:false}` | L3-E | 见 reverification |
| B-24 | **§1.5 反向不成立** | `enabled:true` **不得**改变 `speak_muted` | L3-E | 见 reverification |
| B-25 | **§1.5.0 幂等关闭也清幽灵**（QA 实测发现 → Lead 固化为契约、禁止回退） | 重复 `enabled:false`（changed:false）同样清掉幽灵静音，且只补发 `runtime.mute{false}`（无多余 channel 事件）。**该断言变红 = 回退** | L3-E | 见 reverification |
| B-26 | **§1.5.1 原始 JSONL 可瞬时构造幽灵态** | 运行时已关闭的 speak 通道仍可 `set_speak_muted{true}` 成功（按**配置**状态判定） | L3-E | 见 reverification |
| B-27 | **§1.5.1 幽灵态不可持久** | 绕过 Rust 也无法留下 `speakEnabled=false && speakMuted=true` 的持久组合 | L3-E | 见 reverification |
| B-28 | **§1.5.1 入口①主界面按钮** | 发言通道运行时关闭时静音按钮必须禁用（不可构造幽灵） | L6（浏览器不变量） | 见 reverification |
| B-29 | **§1.5.1 入口②托盘菜单 / ③全局快捷键** | 二者经 `dispatch_action` → `toggle_speak_mute` 的运行时前置检查，不满足直接 Err、不下发命令 | L7 静态 + **L8 人工 M-32（阻塞级）** | ⚠️ **未验证**（需真实桌面版） |
| B-30 | 并发交错请求 | 交替翻转 6 次全部 `changed:true`；同值 6 次仅 1 次 changed；无事件风暴 | L3-D | 见 reverification |

## 5. 矩阵 C：音频设备 × 会话阶段

| ID | 场景 | 预期 | 覆盖 | 状态 |
|---|---|---|---|---|
| C-01 | 设备正常 | 会话进入 `listening`，`audioHealth=ready`，`trayStatus=translating` | L3（桩）+ L8 | 部分 |
| C-02 | 无输入设备 | **判据（Lead 裁决 D1）**：`error.service == "audio"`，`code` 为**既有**音频码（`audio_device_missing` / `audio_device_failed`），**不要求** `audio_start_failed`；`recoverable:false`；托盘「音频异常」 | L3-C1（真实引擎）+ L8 | 见 reverification |
| C-03 | 设备被拔出 / 中断 | `audio_device_lost`，recoverable=true；`audioHealth=failed` → `trayStatus=audio_error` | L2 + L8 | 部分 |
| C-04 | 打开设备超时 | `audio_startup_timeout`，会话被终止并回到 `not_started` | L2 + L8 | 部分 |
| C-05 | 无输出设备 / 被独占 | 播放失败上报，不影响翻译字幕 | L2 + L8 | 部分 |
| C-06 | 设备在 `starting` 阶段掉线 | 会话不卡死，最终 `error` 或 `idle`（不得停在 `connecting`） | L2 + L8 | 部分 |
| C-07 | 音频失败时同时发 `audio.status=failed` 且带 `channel` | 契约 R §4.3 | L3-C1（真实引擎）+ L3-C3 | 见 reverification |

> C 组「部分」= Python 单测覆盖错误分类逻辑，但**真实硬件插拔只有人工可做**（L8）。
> `input: "system"` 时 `input_device` **按设计被忽略**（走 SystemCapture），
> 因此用假设备 id 制造音频失败必须用 `input: "microphone"` 或 `"loopback"` —— 实测记录见 known-issues KI-05。

## 6. 矩阵 D：网络 × 会话阶段

| ID | 场景 | 预期 | 覆盖 | 状态 |
|---|---|---|---|---|
| D-01 | WebSocket 连接失败 | `network/websocket_connect_failed, recoverable:true` → `trayStatus=network_error`（R §4.4 表） | L3-C1 + L1 | 见 reverification |
| D-02 | 部分通道故障（sibling 存活） | **判据（Lead 裁决 D2）**：`network.status{status:"degraded"}`；**不得**触发 `trayStatus=network_error`；**不得**发 `websocket_reconnecting`（引擎无重连逻辑） | L3-C2 | 见 reverification |
| D-02b | 全通道故障 | `network.status{status:"failed"}` → 触发 `network_error` | L3-C3 + L1 | 见 reverification |
| D-03 | 鉴权失败 | `network/auth_failed, recoverable:false` | L2 + L8 | 部分 |
| D-04 | 翻译超时/断开 | `translation_timeout` / `translation_disconnected` | L2 | 见 reverification |
| D-05 | 断线期间 UI | 主界面错误区显示，托盘显示「网络异常」，字幕窗口仍显示历史字幕 | L5 + L8 | 部分 |
| D-06 | 网络恢复 | `network.status{status:ready}`，`networkHealth` 复位，`trayStatus` 回落 | L1 + L2 | 见 reverification |
| D-07 | `network.status` 仅变化时发 | 重复同值不发（R §4.3） | L2 | 见 reverification |
| D-08 | 不存在 `websocket_reconnecting` 事件 | 全场景 grep 原始事件流，0 命中（D2 偏差的**负面**断言） | L3-C1/C2/C3 | 见 reverification |


## 7. 矩阵 E：字幕窗口

| ID | 场景 | 预期 | 覆盖 | 状态 |
|---|---|---|---|---|
| E-01 | 首次 toggle 创建 | label 固定 `subtitle`，URL `index.html?window=subtitle`，**不写进 tauri.conf.json** | L7 | 见 reverification |
| E-02 | 重复 toggle 不重复创建 | 反复 20 次后 `webview_windows()` 中只有 1 个 `subtitle`（S §7.5） | L7 + L8 | 部分（静态 + 人工） |
| E-03 | 窗口属性 | 无边框/透明/置顶/不占任务栏/可缩放/无阴影/初始 880×220/最小 420×120/不抢焦点（S §2） | L7 + L8 | 部分 |
| E-04 | 关闭按钮 = 隐藏 | `prevent_close()+hide()`，`subtitleVisible=false`，**不销毁会话**（S §3） | L7 + L8 | 部分 |
| E-05 | 主窗口关到托盘时字幕保持原状 | 不跟随隐藏（S §3） | L8 | 未验证 |
| E-06 | `Ctrl+Shift+O` 三态可切换 | 主窗口可见 / 最小化 / 隐藏到托盘（S §7.1） | L8 | 未验证 |
| E-07 | 跨应用置顶 | 覆盖在浏览器/编辑器上方（S §7.2） | L8 | 未验证 |
| E-08 | 不影响进行中的 session | toggle 前后 session_id 不变、无重复 session（S §7.3） | L3（sidecar 侧）+ L8 | 部分 |
| E-09 | 刷新后恢复 | 依赖 `getSnapshot()` 恢复字幕与状态（S §3/S §7.4） | L5 + L8 | 部分 |
| E-10 | 主/字幕窗口状态一致 | 同一 `runtime-state` revision（S §7.6） | L5 + L8 | 部分 |
| E-11 | 单一订阅协议 | 字幕窗口复用 `translatorApi.subscribe()` + `getSnapshot()`，不另建协议（S §4） | L7 + L6 | 见 reverification |
| E-12 | 只显示字幕 | 无设置入口/控制栏/历史管理/会话按钮（S §5） | L6 | 见 reverification |
| E-13 | 字号映射 | `small→15px / medium→19px / large→24px`（S §5） | L5 + L6 | 见 reverification |
| E-14 | 小尺寸不重叠 | 420×120 下无元素重叠（S §5） | L6 | 见 reverification |
| E-15 | 静音/关通道有图标+文字 | 不允许只靠颜色（S §5） | L6 | 见 reverification |
| E-16 | 拖拽区 | `data-tauri-drag-region` + capability `allow-start-dragging`（S §5） | L7 + L6 | 见 reverification |
| E-17 | transparent 根节点类 | `html.subtitle-root, body.subtitle-root { background: transparent }`（S §6） | L6 | 见 reverification |
| E-18 | 主窗口无视觉回归 | 主窗口样式不因本次改动变化（S §6） | L4 + L8 | 部分 |

## 8. 矩阵 F：开发版 vs 安装版

| ID | 场景 | 预期 | 覆盖 | 状态 |
|---|---|---|---|---|
| F-01 | 开发版全部自动化 | L1–L6 全绿 | L1–L6 | 见 reverification |
| F-02 | `npm run desktop:build` 产物 | NSIS 安装包路径与文件名 | L9 | **未验证（待授权）** |
| F-03 | 安装 | 安装成功、开始菜单/桌面快捷方式 | L9 | **未验证（待授权）** |
| F-04 | 升级安装（旧版→新版） | 设置保留、无残留旧文件 | L9 | **未验证（待授权）** |
| F-05 | 卸载 | 无残留 `translator-bridge` 进程、无残留安装目录 | L9 | **未验证（待授权）** |
| F-06 | 安装版托盘可用 | 同上 A-02/A-09 | L9 | **未验证（待授权）** |
| F-07 | 安装版快捷键可用 | 同上 A-14/A-15 | L9 | **未验证（待授权）** |
| F-08 | 安装版字幕窗口可用 | 同上 E 组 | L9 | **未验证（待授权）** |
| F-09 | 安装版 sidecar 打包 | `translator-bridge-x86_64-pc-windows-msvc.exe` 存在且 `ping` 正常 | L9 | **未验证（待授权）** |
| F-10 | 退出无残留进程 | 退出后任务管理器无 `translator-bridge*` | L8 + L9 | **未验证** |

---

## 9. 明确不覆盖（Non-goals）

1. **真实音频链路的物理效果**（B-18/B-19）：离线桩无法证明「麦克风帧真的没被送进引擎」；
   自动化只能证明状态机与事件正确。需人工听感 + Python 单测代码级验证。
2. **真实 WebSocket 服务端行为**（D 组）：无可用密钥/无稳定性保证，不纳入自动化回归。
3. **多显示器 / DPI 缩放 / 高对比度主题**下的字幕窗口渲染。
4. **macOS / Linux**：本项目仅 Windows。
5. **性能与长稳**：连续数小时运行的 session 泄漏、内存增长。
6. **同一快捷键被其他软件占用**的真实冲突（只能人工制造）。
7. **驱动级音频问题**（VB-Cable 安装/独占/采样率不匹配）。

## 10. 矩阵规模统计

| 组 | 条目数 | 可自动化 | 仅人工 | 待授权 |
|---|---|---|---|---|
| A 托盘/快捷键/窗口状态 | 20 | 12 | 6 | 2 |
| B 运行时通道/静音 | 21 | 17 | 3 | 1 |
| C 音频设备 | 6 | 0（纯硬件） | 6 | 0 |
| D 网络 | 7 | 4 | 3 | 0 |
| E 字幕窗口 | 18 | 8 | 8 | 2 |
| F 版本 | 10 | 0 | 1 | 9 |
| **合计** | **82** | **41** | **27** | **14** |

> 每条的实际「通过/失败/阻断/未验证」结论见 `docs/qa/reverification.md`（模块就绪后逐项跑）。
> 未实测的条目在本文件中一律标记「未验证」，不得据推测改写为「通过」。
