# 独立复验报告

> 复验者：Agent 4 / `qa-verifier`（**未参与任何被测代码的实现**）
> 复验时刻：2026-10-07 19:03 – 19:19 (+08:00)
> 口径：**通过 / 失败 / 阻断 / 未验证**。凡未亲自执行过的一律写「未验证」，不写「通过」。

---

## 0. 复验声明（先读这一段）

**独立性**：本报告的每一条结论都来自 QA 自己编写的测试入口，不是复述实现方的自测输出：

| 证据来源 | 是否由 QA 实现 | 说明 |
|---|---|---|
| `scripts/test_runtime_integration.py`（L3，96 条） | ✅ 是 | 真进程 + 真 JSONL，五个 tier（A/B/C1-C3/D/E） |
| `_tray-shortcut-check.cjs`（L6，33 条） | ✅ 是 | 真实构建产物上的浏览器自动化 |
| `scripts/test_tauri_bridge.py` 等（L2） | ❌ 否（实现方） | QA 只做**未删断言**核对 + 独立执行 |
| `cargo test`（L1） | ❌ 否（实现方） | QA 只做独立执行 + 用例覆盖审查 |
| `_tray-shortcuts-acceptance.py`（L7） | ❌ 否（Lead） | 作为第二条静态路径记录，局限见 §7 |

**「非粉饰」自查**：我在这轮复验中修掉了**自己**的两处假绿——
1. 4 条「不该有事件」的负面断言原本在**前置命令失败**时也会 PASS（空转的绿），已改为 `BLOCKED`；
2. 竞态断言原本期望「交替翻转里一半 changed」，实为**每次都在翻转**（6/6 才对），是我算错而非产品缺陷，已修正并补了「同值连发只 1 次 changed」的对照。

---

## 1. 受测版本（可复核）

| 文件 | SHA256 前 16 位 |
|---|---|
| `scripts/tauri_bridge.py` | `06BEFA88B2B4E842` |
| `scripts/livetranslate.py` | `9184113FF3D00577` |
| `scripts/test_runtime_channels.py` | `2A563B762EDB8041` |
| `scripts/test_runtime_integration.py`（QA 自建） | `0CB62F57CBB4C1DA` |
| `desktop/src-tauri/src/lib.rs` | `9E208EF0EEEE6A96` |
| `desktop/src-tauri/src/tray.rs` | `8B1CD14A0187BCFC` |
| `desktop/src-tauri/build.rs` | `31E0E8C3082909E6` |
| `desktop/src/main.tsx` | `377204ECBA3035D2` |
| `_tray-shortcut-check.cjs`（QA 自建，仓库根） | `DBA9689E7638ABCE` |

**证据时效核对（19:27 复查）**：所有被测源文件的最后修改时间都**早于**我的对应复验运行时间
（前端最新 19:17:40 < 我 19:19 重建/19:22 浏览器复验；Python 最新 19:17:41 < 我 19:24 集成复跑；
Rust 最新 build.rs 19:22:08 < 我 19:25 `cargo test` / 19:26 `cargo build`）→ **无陈旧证据**。


基线 commit：`56348ee391efa01d4792392ff56672c0e460fbe1`（未产生新 commit，改动均在 working tree）。
工具链：rustc/cargo 1.98.0、node v24.18.0、npm 11.16.0、Python 3.14.2。
改动前基线见 `docs/qa/baseline.md`（Rust 29 pass、Python 70+11、前端 build + 9）。

---

## 2. 结果总览

| 层 | 命令 | 实测结果 | 结论 |
|---|---|---|---|
| L3 跨模块集成 | `.venv\Scripts\python.exe scripts\test_runtime_integration.py` | **PASS 96 / FAIL 0 / BLOCKED 0**（16.63s，7 个 tier） | ✅ 通过 |
| L2 Python 单测 | `test_tauri_bridge.py` | **Ran 86 → OK** | ✅ 通过 |
| L2 Python 单测 | `test_audio_isolation.py` | **Ran 18 → OK** | ✅ 通过 |
| L2 Python 单测 | `test_runtime_channels.py` | **Ran 36 → OK** | ✅ 通过 |
| L4 前端构建 | `npm run desktop:build` 内的 `beforeBuildCommand`（Lead 排他） | exit 0；产出 dist 哈希已核验 | ✅ **通过**（QA 验证产物并绑定哈希，**刻意未自行 build**，见 §14） |
| L5 前端单测 | `node --experimental-strip-types --test tests/*.test.mjs` | **pass 38 / fail 0**（基线 9 条逐字仍在） | ✅ 通过（19:52 对新源码重跑） |
| L6 浏览器自动化 | `node _tray-shortcut-check.cjs --url http://127.0.0.1:4173/` | **PASS 33 / FAIL 0 / SKIP 1**（对**打包后**的 dist） | ✅ 通过（19:52 重跑） |
| L7 静态契约核对 | `python _tray-shortcuts-acceptance.py` | **PASS 68 / WARN 0 / FAIL 0** | ✅ 通过（仅静态，见 §7） |
| L1 Rust 单测 | `cargo fmt -- --check` + `cargo test`（**QA 独立复跑**） | **fmt exit 0**；**49 tests: 48 passed / 0 failed / 1 ignored** | ✅ 通过 |
| L8 人工联调 | `docs/qa/manual-checklist.md`（32 条，含阻塞级 M-32） | 未执行 | ⚠️ **未验证** |
| L9 安装包 | `npm run desktop:build` | 未授权、未执行 | ⚠️ **未验证** |

> 受测版本在最终一轮复跑时再次核对：`tauri_bridge.py` = `06BEFA88B2B4E842`、
> `livetranslate.py` = `9184113FF3D00577`（与首轮一致 → Python 侧已稳定）。
> 前端在 19:17 后仍有改动，故在 19:19 重新 `npm run build` 并重跑全部前端与浏览器断言（37 / 33 均为最新源）。


---

## 3. L3 跨模块集成测试（核心证据）

### 3.1 tier 分布

| tier | 场景 | 条数 | 结果 |
|---|---|---|---|
| A | 真实引擎（无桩）：ready / ping / 协议错误 / 参数校验 / 无 session 错误码 / 非法 start / stop 幂等 / devices / shutdown | 20 | ✅ 全过 |
| B | 离线桩全链路：start → set_runtime_channel → 幂等 → set_speak_muted → 取消静音 → stop → 旧 session 拒绝 → 重启复位 → 未配置通道 | 32 | ✅ 全过 |
| C1 | **真实引擎**音频失败（D1 反向验证） | 6 | ✅ 全过 |
| C2 | 部分通道故障 → degraded（D2 反向验证） | 5 | ✅ 全过 |
| C3 | 音频故障分类（service=audio + audio.status） | 5 | ✅ 全过 |
| D | 有活跃 session 时的严格参数校验 + 并发竞态 + stop 幂等 | 17 | ✅ 全过 |
| E | **§1.5/§1.5.1 幽灵态与事件顺序（原始 JSONL 绕过 Rust）** | 11 | ✅ 全过 |

结果文件：`docs/qa/integration-result.json`（含每条断言的原文与证据）。

### 3.2 关键实测摘录

**（a）契约 R §3.1 幂等语义**（tier B，真实进程）
```
关闭收听通道 → {"ok":true,"result":{"session_id":"…","channel":"listen","enabled":false,"changed":true}}
重放同一值   → {"ok":true,"result":{…,"enabled":false,"changed":false}}     ← 幂等成功，不是错误
事件         → {"event":"runtime.channel","data":{"channel":"listen","enabled":false,"configured":true}}
重放后        无第二条 runtime.channel 事件
```

**（b）旧 session 拒绝且零副作用**（tier B）
```
session2 活跃时用 session1 的 id 调用 → {"ok":false,"error":{"code":"session_mismatch",…}}
之后 0.4s 内无任何 runtime.channel / runtime.mute 事件（状态未被污染）
```

**（c）重启复位**（tier B，契约 R §1.2）
```
session2 上 set_runtime_channel{listen,false} → changed:true   ← 证明已复位为「配置默认开启」
session2 上 set_speak_muted{false}            → changed:false  ← 证明 speak_muted 已复位为 false
```

**（d）未配置通道不得伪造已开启**（tier B，契约 R §1.3/§2.2）
```
仅启用收听通道的 session：set_speak_muted{true} → channel_not_configured
                          set_runtime_channel{speak,true} → channel_not_configured
```

**（e）严格参数校验**（tier D，有活跃 session，优先级无歧义）
```
channel="both"        → invalid_channel
channel 缺失          → invalid_params
enabled="yes" / =1    → invalid_params
muted="true"          → invalid_params
session_id="not-a-uuid" → session_mismatch
session_id 缺失       → invalid_params
随机 UUID             → session_mismatch
以上 8 次之后通道仍为默认开启（状态未被污染）
```

**（f）并发竞态**（tier D）
```
交错连发 6 次（true/false 交替）→ 6/6 响应，值序列 [True,False,True,False,True,False]，
                                  6 次全部 changed:true（每次都在翻转）
同值连发 6 次（全部 true）      → 仅第 1 次 changed:true，其余 changed:false
                                  runtime.mute 事件总数 = 7（6 次翻转 + 1 次置 true）→ 无事件风暴
stop 两次                       → 第二次 {"already_stopped":true}
全程 stdout 100% 合法 JSON（0 条非 JSON 行）
```

---

## 4. 反向验证（Lead 指定的 D1 / D2 / D3）

### 4.1 D1：`audio_start_failed` 偏差 —— **证伪型验证通过（偏差真实存在）**

**方法**：**不用桩**，真实 `scripts/tauri_bridge.py` + 真实 `livetranslate`。
speak 通道 `input=microphone` + 不存在的 `input_device=qa-no-such-device-0000`，
WS 指向 `wss://127.0.0.1:9`（确保不会产生任何外网流量）。

**实测原始事件**：
```json
{"v":1,"type":"event","event":"error","session_id":"5fc67eba-…","data":{
  "scope":"audio","service":"audio","code":"audio_device_failed",
  "message":"发言通道音频设备打开失败：no device with id qa-no-such-device-0000",
  "recoverable":false}}
{"v":1,"type":"event","event":"audio.status","session_id":"5fc67eba-…","data":{
  "status":"failed","channel":"speak",
  "detail":"发言通道音频设备打开失败：no device with id qa-no-such-device-0000"}}
```
**结论**：
- 发出的 code 是**既有** `audio_device_failed`，**不是** `audio_start_failed` → **D1 偏差是真实发生的**，不是实现方的猜测；
- `service == "audio"` 成立 → Lead 的新判据可用；
- 同一故障同时产生 `audio.status{status:failed,channel:"speak"}`，符合契约 R §4.3。

> 附带发现（非缺陷）：`input: "system"` 时 `input_device` 按设计被忽略（走 `SystemCapture`），
> 因此假设备 id 必须配 `input: "microphone"` / `"loopback"` 才能制造音频失败。见 known-issues KI-05。

### 4.2 D2：`websocket_reconnecting` 不存在 + degraded 语义 —— **验证通过**

**方法**：故障注入（把 speak 通道的 run 换成「按网络失败上报」，listen 保持健康），
但**错误分类、事件发射、`network.status` 聚合全部走真实代码**（`_report_failure` → `RealtimeSession._aggregate_network`）。

**实测原始事件**：
```json
{"v":1,"type":"event","event":"network.status","session_id":"c5750092-…","data":{
  "status":"degraded","detail":"QA 注入：发言通道连接失败"}}
```
**断言结果（全部通过）**：
| 断言 | 结果 |
|---|---|
| 部分通道故障 → `network.status=degraded` | ✅ 发出 |
| `websocket_reconnecting` 出现次数 | ✅ **0**（tier C1/C2/C3 全程 grep 原始事件流） |
| sibling 存活时是否误发 `network.status=failed` | ✅ 未发 |
| 单通道故障是否终止整个 session（`state=stopped`） | ✅ 未终止 |
| 全部通道音频失败 → `audio.status=failed` 且带 `channel` | ✅ 发出（tier C3） |

**结论**：D2 的替代判据（用 `network.status` 的 degraded/failed 承载网络健康）**在真实事件流里成立**，
且「引擎无重连逻辑」与「从不发 reconnecting」一致 → 保留为「已声明、当前不发出」是**正确取舍**，不是遗漏。

### 4.3 D3：`recoverable` 无自动重启依赖 —— **独立复核通过（第二双眼睛）**

我**独立**执行（不依赖 Lead 的结论）：
```powershell
grep -rn "recoverable" desktop/src-tauri/src
```
结果（生产代码中 `.recoverable` 字段**读取次数 = 0**）：
- 声明：`tray.rs:184`（`RuntimeError` 结构体字段）
- 构造：`tray.rs:362`、`tray.rs:573`（内部错误，固定 `true`）
- 解析：`tray.rs:462-463`（从 sidecar 事件 JSON 取 `recoverable`，缺省 `false`）
- 存储：`tray.rs:480`
- **读取**：仅 `tray.rs:1656`、`tray.rs:1680` —— 两处都是 `#[test]` 里的断言，**非生产控制流**
- `lib.rs:1830` 是 JSON 字面量（构造，不是分支）

重启类标识符独立检索：
```powershell
grep -E 'restart|retry|respawn|relaunch|auto_recover|recover_' desktop/src-tauri/src/tray.rs desktop/src-tauri/src/lib.rs
→ 0 命中
```
前端消费点（纯展示语义，与 Lead 结论一致）：
- `App.tsx:802`：`row.severity === "error" && row.recoverable && !active` → 决定是否显示重试入口
- `App.tsx:837`：`visibleError.recoverable && !active` → 同上
- `runtime.ts:404/424/449`：仅把 `recoverable` 透传进展示行

**结论**：D3 的 `recoverable: true → false` 是**纯展示语义变更**，无自动重启副作用。**同意批准。**

### 4.4 §1.5 / §1.5.1 幽灵态对抗性验证（Lead 追加指定）

> 要求：证明应用内**无法**造出 `speakEnabled=false && speakMuted=true`；
> 并证明即使绕过 Rust 直连 sidecar，也留不下**持久**幽灵态。

#### （a）第 2 条 —— 原始 JSONL 直连 sidecar：**实测（已完成）**

新增 tier E（11 条断言全部通过），全部经**原始 JSONL 绕过 Rust**：

| 断言 | 实测证据 | 结论 |
|---|---|---|
| §1.5 前置：先静音 | `{"ok":true,"result":{"muted":true,"changed":true}}` | ✅ |
| §1.5 关闭已静音的通道 | `{"ok":true,"result":{"channel":"speak","enabled":false,"changed":true}}` | ✅ |
| **§1.5 事件顺序** | 事件序列严格为 `[["runtime.mute",false], ["runtime.channel:speak",false]]` → **先静音后关通道**，与契约 §1.5 完全一致 | ✅ |
| §1.5 静音确实被清除 | 随后 `set_speak_muted{muted:false}` → `changed:false`（若仍是 true 会返回 true） | ✅ |
| **§1.5 反向不成立** | 重新启用通道后 `enable.changed=false` 且 `mute.changed=false` → 启用**没有**清掉静音 | ✅ |
| **§1.5.1 幽灵可瞬时构造** | 运行时已关闭的 speak 通道上 `set_speak_muted{muted:true}` → `{"ok":true,"result":{"muted":true,"changed":true}}`；`changed:true` 证明此前确为 false，即「通道已关 + 已静音」确实并存过 | ✅ 与裁决一致 |
| **§1.5.1 不可持久** | 收尾 `set_speak_muted{muted:false}` → `changed:false` → 幽灵已被清除，未残留 | ✅ |

**QA 发现（已被 Lead 固化为契约 §1.5.0，禁止回退）**：连**幂等**关闭（`enabled:false` 且 `changed:false`）也会清掉幽灵静音，
且**只**补发一条 `runtime.mute{false}`、**不**补发 channel 事件。
我最初假设「幂等关闭不会清理」，实测**推翻了我的假设**；契约原文（§1.5「在成功时」）本来也允许，
Lead 已据此新增 **§1.5.0「更强保证：幂等关闭也要清掉幽灵静音」**，并写明
「若未来有人把清理逻辑改成『只在 `changed` 时才执行』，即为**回退**，必须被 review 拦下」。
→ tier E 对应断言已改名为 `§1.5.0 …`，**该断言变红即为回退**。

#### （b）第 1 条 —— 真实桌面版三入口：**部分实测 + 部分推理（未在真实桌面版复现）**

| 入口 | 证据类型 | 结论 |
|---|---|---|
| ① 主界面「静音」按钮 | **实测（浏览器，真实构建产物）** | ✅ `_tray-shortcut-check.cjs` 的 §1.5.1 不变量在 3 个观测点全部通过：`发言通道：已关闭 → 静音按钮 disabled=true`（无 session / session 进行中 / 停止后） |
| ① 主界面（源码保证） | 静态 | `App.tsx:699` 静音按钮 `disabled={!runtimeReady \|\| actionPending \|\| !active \|\| !speakOn}` —— `speakOn=false` 时不可点击 |
| ② 托盘菜单「静音发言」 | **推理（静态读码）** | `tray.rs:970 on_tray_menu_event` → `tray-item "tray-speak-mute"` → `RuntimeAction::ToggleSpeakMute` → `tray.rs:987 dispatch_action`（**唯一入口**）→ `tray.rs:1023` → `toggle_speak_mute` |
| ③ 全局快捷键 `Ctrl+Shift+M` | **推理（静态读码）** | `tray.rs:951 on_global_shortcut`（只响应 `Pressed`）→ `tray.rs:966 dispatch_action` → 同上 |
| 共同守卫 | 静态 | `toggle_speak_mute`（`tray.rs`）：`if !state.speak_enabled { return Err("发言通道未启用，无法静音。") }` —— 读的是**运行时** `speak_enabled`，不满足**直接返回 Err，不下发命令** |

**因此（推理结论）**：三入口在代码结构上都会在 Rust 侧被运行时前置检查拦住，
应用内无法构造幽灵组合。

**但必须明确标注**：
- **未在真实桌面版（开发版或安装版）实测** ② 与 ③。原因是它们依赖真实托盘/全局快捷键，
  且需要 cargo 构建（cargo 令牌当前在 rust-native 手上）。
- **安装版是否复现过：没有。** 安装包尚未构建（§10），因此**安装版结论完全缺失**。
- 该验证已作为**阻塞级**人工项 **M-32** 写入 `manual-checklist.md`：
  只要任一入口能造出幽灵组合即为阻塞缺陷。在 M-32 执行前，本条结论是
  **「静态推理：不可达；运行时：未验证」**，不得写成「通过」。

> 附带发现（**已被 Lead 修正**）：契约 §1.5.1 原引用的错误文案是
> 「…未在设置中启用，请先在设置中开启。」，而 `tray.rs` 实际返回
> **「发言通道未启用，无法静音。」**。已按我的实测反馈改契约（现为实际文案），
> 静态检查器在契约更新后重跑：**PASS 68 / WARN 0 / FAIL 0**（无回归）。

#### （c）稳定性

tier 全量（tier A–E）**连续跑 3 次**，结果完全一致：`PASS 96 / FAIL 0 / BLOCKED 0`
（17.7s / 17.3s / 17.2s）→ 无抖动、无随机失败、无端口/进程残留导致的偶发红。

---

## 5. L2 Python 单测（独立执行 + 未删断言核对）

| 文件 | 基线 | 现在 | 结果 | 被删除的用例 |
|---|---|---|---|---|
| `scripts/test_tauri_bridge.py` | 70 | **86** | Ran 86 → **OK** | **0** |
| `scripts/test_audio_isolation.py` | 11 | **18** | Ran 18 → **OK** | **0** |
| `scripts/test_runtime_channels.py` | （不存在） | **36** | Ran 36 → **OK** | — |

**「删断言换绿」核对**（用基线 commit 直接对比测试函数名集合）：
```powershell
git show 56348ee:scripts/test_tauri_bridge.py   → 70 个 test_ 函数，removed=0，added=16
git show 56348ee:scripts/test_audio_isolation.py → 11 个 test_ 函数，removed=0，added=7
```
→ 只有新增，**没有任何既有用例被删除或改名**。

> 中间过程记录（诚实披露）：19:12 时 `test_runtime_channels.py` 曾有 2 条失败
> （`test_a_finished_session_mismatches_instead_of_mutating_a_new_one`、
> `test_malformed_params_never_reach_the_runtime_state[params=None]`），
> 19:18 复跑已全绿。详见 `known-issues.md` KI-02 / KI-04。

---

## 6. L4 / L5 前端（构建 + 单测 + 未删断言）

### 6.1 构建
```
> tsc -b && vite build
✓ 1839 modules transformed.
dist/index.html                   0.45 kB
dist/assets/index-*.css          50.90 kB
dist/assets/index-*.js          311.81 kB
✓ built in 920ms        → exit 0
```
基线 1836 modules → 现在 1839，`tsc -b` 无类型错误。

### 6.2 单测：37 pass / 0 fail
```
node --experimental-strip-types --test tests/*.test.mjs
ℹ tests 37   ℹ pass 37   ℹ fail 0
```
新增 3 个测试文件：`runtime-mock.test.mjs`、`runtime-state.test.mjs`、`subtitle-window.test.mjs`。
（19:19 前端最后一次改动后复跑：35 → 37，仍 0 失败。）

### 6.3 基线 9 条**原始测试名**（改动后仍原样运行，逐条列出）

`tests/virtual-microphone.test.mjs`（基线 5 条，现在仍 5 条 `test(...)` 调用）：
```
✔ requires the complete standard pair; does not match paid A+B devices
✔ connects only outgoing speech, retains language and does not mutate settings
✔ retains an explicitly selected microphone
✔ replaces cable microphone and prevents default loopback / listening playback feedback
✔ rejects missing hardware and recording-channel feedback
```

`tests/translation-languages.test.mjs`（基线 4 条，现在仍 4 条 `test(...)` 调用）：
```
✔ speech and text expose the official 29 and 60 target languages
✔ saved labels, aliases and codes resolve without changing settings
✔ each enabled direction validates its own mode and target
✔ unknown and automatic targets never silently become English
```
**「数字变大但原有断言被替换」的怀疑排除依据**：
`git show 56348ee:<file> | grep -c "^test("` 与当前文件对比 → 两个文件分别是 **5→5**、**4→4**，
且上面 9 条名字逐字仍在输出中。9 + 26（新增三文件）= 35。

---

## 7. L6 浏览器自动化（真实构建产物）

命令：`node E:\Project\translation\_tray-shortcut-check.cjs --url http://127.0.0.1:4173/`
（先 `npm run build`，再用 `npx vite preview` 提供**构建产物**，不是 dev server）

结果：**PASS 33 / FAIL 0 / SKIP 1**（exit 0）。截图：`qa-runtime-bar.png`、`qa-subtitle-window.png`、`qa-subtitle-window-small.png`。

| 组 | 断言 | 结果 |
|---|---|---|
| 运行时状态栏 | 渲染、初始文案「未启动」、4 个开关、aria-label 与契约一致 | ✅ |
| 无 session 禁用规则 | 通道/静音禁用（`title` 给出原因）、字幕窗开关仍可用 | ✅ |
| **§1.5.1 不变量** | 发言通道关闭时静音开关必须禁用 —— 3 个观测点（无 session / session 中 / 停止后）全部成立 | ✅ |
| 开始/停止 | 开始 → 「正常翻译」、「停止同传」；停止 → 「未启动」、开关重新禁用 | ✅ |
| 通道控制 | 收听通道 toggle 往返、`aria-pressed` 与文案一致 | ✅ |
| 字幕悬浮窗 | `?window=subtitle` 挂载、`subtitle-root` 透明类、body 透明、无设置入口、无会话控制栏 | ✅ |
| 字幕悬浮窗 | `data-tauri-drag-region`、置顶/关闭按钮、字号 19px（medium） | ✅ |
| 字幕悬浮窗 | 420×120 无横向溢出（0px）、顶层元素两两不重叠（0 对） | ✅ |
| 错误面 | 主窗口/字幕窗口均无 `pageerror` | ✅ |
| 静音链路 | **SKIP**：启用发言通道后应用回到 `配置同传`，浏览器内不可达 → 转人工 M-09/M-21 | ⚠️ 未验证 |

**已知非阻塞现象**：浏览器隐式请求 `/favicon.ico` 返回 404（项目无 `public/` 目录、`index.html` 未声明图标）。
**这是改动前就存在的**（基线构建产物同样只有 html/css/js 三个文件），在 Tauri WebView 中无影响。
断言已显式排除并在脚本内注明，未当作通过。

---

## 8. L7 Lead 的静态契约检查器（第二条路径）

```
python E:\Project\translation\_tray-shortcuts-acceptance.py
→ PASS 68  WARN 0  FAIL 0   (exit 0)
```
覆盖：Rust 13 个 `RuntimeState` 字段、7 个动作、9 个菜单 id、状态字面量、命令注册、事件名、
Cargo 依赖、窗口 label、capabilities 不得泄漏 `global-shortcut`；TS 字段/动作/状态/字面量与三处 API 接线；
Python 2 个命令 / 4 个事件 / 6 个错误码 / 4 个 service。

### ⚠️ 它的局限（必须与 PASS 一起读）

1. **纯静态文本匹配**：只证明「字面量出现在文件里」，**不证明行为正确**。
   例如它能确认 `dispatch_action` 被 3 处调用，但不能证明托盘点击真的走到了它。
2. **可能误报（假绿）**：注释、字符串常量、甚至被 `#[cfg(test)]` 包裹的代码都能让匹配通过。
3. **可能漏报（假红）**：重命名局部变量、格式化换行、宏生成的符号会导致匹配失败，
   而实际行为完全正确。
4. **无运行时证据**：不覆盖事件顺序、幂等、竞态、并发、错误码优先级。
5. **结论**：它的 PASS **不能替代**本报告 §3/§6/§7 的真实执行结果；
   它的 FAIL 也只能作为**线索**，必须人工复核后才能定性为缺陷。
   本轮 68/0/0 只说明「三层字面量与契约一致」，是**必要不充分**条件。

---

## 9. L1 Rust 单测 —— ✅ **通过（独立复跑）**

**我的独立运行**（19:25，承接 Lead 释放的 cargo 令牌；**刻意不跑 `cargo clean`**，
保留 target 热态 → 我跑的是**增量**路径，Lead 跑的是**干净重建**路径，两者互为补充）：

```
cargo fmt -- --check
  → FMT_EXIT=0                       （无输出＝无格式问题）

cargo test                            （incremental，未 clean）
  running 49 tests
  test result: ok. 48 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.16s
  TEST_EXIT=0
```
- `src\main.rs` / `src\bin\translator-audio-capture.rs` / doc-tests 各 0 test。
- 唯一告警：`#[warn(linker_messages)]`（Windows 链接器 stdout 提示，非代码问题）。
- `ignored` 1 条：`virtual_microphone::tests::prepare_official_installer_without_installing`（基线即 ignore，需下载驱动）。

**门槛核对（与我记录的基线逐名对比，不是只看数量）**：
```
baseline=29 个通过用例名  current=48 个通过用例名
REMOVED（基线名字不再出现）= 0
ADDED = 19，全部属于 tray::tests::*
```
→ **基线 29 条无一条被删除或改名**，49 = 30（既有）+ 19（新增）成立。
（注：`prepare_official_installer_without_installing` 因是 `ignored`、输出行不是 `... ok`，
在自动比对里被算作 added，属正则口径问题，实际它就是基线那条 ignored 用例。）

### 9.1 四类必查覆盖（逐条列出函数名与断言要点，不只看数量）

| 契约要求 | 测试函数 | 断言要点（我读码确认） |
|---|---|---|
| **trayStatus 优先级** | `tray_status_follows_the_contract_priority` | `default→NotStarted`；`Starting/Stopping→Connecting`；`Listening+session_id→Translating`；`audio_health=Failed→AudioError`；再叠加 `network_health=Failed→NetworkError`（**并断言此时 audio 仍为 Failed**，即网络优先级确实更高）；**`Listening` 但 `session_id=None` → `NotStarted`**（不允许显示「正常翻译」） |
| **`degraded` 不得升级为错误态**（D2 的 Rust 侧边界） | `degraded_health_never_becomes_an_error_tray_status` | `network.status=degraded→Translating`；`audio.status=degraded→Translating`；`ready`/`connecting` 同样不升级；**只有 `failed` → `NetworkError`**；且 `failed` 后回到 `degraded` 能**降级回去** |
| **旧 session 事件被丢弃** | `stale_session_events_are_dropped` | 用 `old-session` 的 `state`/`runtime.channel`/`network.status` 事件全部返回 `false` 且 `state == before`（深比较，证明**零变化**）；会话已结束后到达的 `runtime.mute` 同样被丢弃且状态仍等于 `default()` |
| **250ms 去抖** | `debounce_swallows_repeats_inside_the_window` | 首次 true；**+249ms → false**（吞掉）；**+250ms（=DEBOUNCE_WINDOW）→ true**；不同 action 的 `last_fired` 互相独立（字幕窗 toggle 在同一时刻仍可触发） |
| **快捷键 → action 映射表** | `shortcut_table_matches_the_frozen_accelerators` | 精确断言 5 元组顺序表（Space/M/O/L/S 与 5 个 action 一一对应）；每个绑定解析出的 hotkey **id 互不重复**（否则按下无法映射回动作）；每个绑定都含 Ctrl+Shift |

其余 14 条新增测试（同样逐条读过，摘要）：
`runtime_state_default_matches_the_frozen_initial_payload`（初始 JSON 冻结）、
`tray_status_values_and_labels_match_the_contract`（5 个 serde 名 + 文案）、
`runtime_health_and_error_service_serde_names_match_the_contract`（health/service/phase 字面量）、
`runtime_action_serde_names_match_the_contract`（7 个 action 名）、
`revision_and_timestamp_only_advance_on_real_change`（仅真变化才 +revision）、
`session_start_initializes_channels_and_failure_clears_session_id`、
`session_state_events_drive_phase_and_reset_on_stop`（stopped 时复位 health/channel）、
`runtime_channel_health_and_mute_events_update_state`、
`error_events_classify_service_and_never_infer_health_for_system_errors`（**system/configuration 错误不得推断 health**）、
`non_runtime_events_and_responses_do_not_touch_state`、
`runtime_channel_responses_apply_effective_values_and_readable_errors`（含 `changed:false` 幂等、错误码→中文文案映射）、
`session_gate_is_held_while_a_session_action_is_running`（防重入闸门）、
`shortcut_failure_serializes_for_the_frontend`、
`rfc3339_timestamps_are_utc_and_well_formed`。

### 9.2 `0xc0000139` 根因 —— **接受 rust-native 的纠正，更正我此前的判断**

| | 内容 |
|---|---|
| **我原先的判断（错误）** | 并发构建产生陈旧 `.dll.lib`：exe 按旧导入库链接、运行时加载新 DLL |
| **纠正后的根因** | **Tauri `tray-icon` 在 Windows 的平台坑**：`muda` 导入 `TaskDialogIndirect`，该符号只在 Common-Controls **v6** 程序集里；`tauri-build` 只把 v6 清单链进 **bin** 目标（`rustc-link-arg-bins`），库的**单元测试 harness 不是 bin 目标**，于是加载 `comctl32.dll` 的 **v5 shim** → `STATUS_ENTRYPOINT_NOT_FOUND` |
| **对方证据** | 全新 `cargo clean -p` 后**仍失败**（排除陈旧产物说）；手工移除外部 `.manifest` 后**立即复现**失败 |
| **修复** | `build.rs` 增 `cargo:rustc-link-search=native=<OUT_DIR>`；`lib.rs` 加 `#[cfg(all(test, windows))] #[link(name="resource", kind="static")] extern "C" {}` |

**我的独立佐证（⛔ 不是独立复现）**：
```
OUT_DIR\resource.lib                              → 存在（13216 bytes，19:24:59）
test harness simultaneous_translator_lib-*.exe    → 二进制内嵌字符串包含：
   Microsoft.Windows.Common-Controls  = True
   TaskDialogIndirect                 = True
   comctl32                           = True
   6.0.0.0                            = True
```
→ 现在跑起来的测试 harness **确实带上了 v6 清单**，与「修复清单缺失」这一因果链一致。
**诚实标注**：我**没有**用「移除清单→复现失败」的方式独立复现根因（那需要改文件、会破坏工作树），
所以根因判断对我而言是**被佐证（corroborated）**，而非**被我独立复现**。

**对我此前说法的更正**（写入报告，避免误导）：
> 原文：「之前任何 cargo test 全绿结论不可信」。
> **更正为**：基线 29 项是**改动前的旧 exe** 跑出来的，那次运行**是有效的**；
> 之后的 `0xc0000139` 与并发构建无因果关系。串行化要求**仍然保留**
> （避免 target 争用造成的其它类型不一致），但它**不是**本次故障的根因。

### 9.3 `build.rs` 与 `#[link]` 审计（Lead 指定的第二双眼睛）

**改动内容**（`git diff` 已核对）：
- `tauri_build::build()` **未改动**（仅补了 `;`），文档注释新增。
- 新增（`#[cfg(windows)]` 下）：仅当 `<OUT_DIR>/resource.lib` 存在时输出
  `cargo:rustc-link-search=native=<OUT_DIR>`；否则输出一条 `cargo:warning`（**不是硬错误**）。
- `lib.rs`：`#[cfg(all(test, windows))] #[link(name = "resource", kind = "static")] extern "C" {}`。

**结论：只影响 test harness，对发布 bin/cdylib 无副作用。** 依据：

| # | 论据 | 强度 |
|---|---|---|
| 1 | `cfg(test)` **只在 `--test` 编译时为真**。`cargo build` / `--release` 下该 attribute **根本不会被编译**，bin/cdylib 的链接行与改动前逐字相同 | 语言语义，确定 |
| 2 | 测试 harness **不是 bin 目标**，不经过 `rustc-link-arg-bins`，因此不会与 bin 的 resource.lib 重复；资源编译器拒绝重复，若重复会直接报错（实测没报） | 结构 + 实测 |
| 3 | `rustc-link-search` 只添加**搜索目录**，不链接任何东西；bin 仍按原路径拿到 resource.lib | 语义，确定 |
| 4 | `OUT_DIR` 内只有 `resource.lib` 一个 `.lib`，不存在同名/歧义库被意外解析的风险 | 实测（目录清单） |
| 5 | 缺 `resource.lib` 时降级为 warning，不阻断构建 | 读码 |
| 6 | **实测**：`cargo build --lib --bins` → `BUILD_EXIT=0`，产出 `simultaneous-translator.exe`（16,336,384 B，19:26:23）与 `simultaneous_translator_lib.dll`（173,056 B，19:25:16），**无重复资源错误** | 实测 |

**残余风险（未消除）**：**release** 配置下的 bin/cdylib 链接尚未验证（需要 `npm run desktop:build`）。
该步骤由 Lead 排他执行，属 §10 待办；因此第 1–5 条对 release 同样成立（`cfg(test)` 与 profile 无关），
但**发布产物本身尚未实测**。

### 9.4 Rust 侧仍然**未验证**的部分（cargo 不能证明的）

`cargo test` 证明的是**单元逻辑**。以下仍无实测证据，必须靠人工 M 组：
托盘图标/tooltip/菜单真实渲染（M-01~M-06）、隐藏时菜单可用（M-03）、
**真实全局快捷键**注册与触发（M-09~M-14）、跨应用置顶（M-15）、
窗口 show/hide 与 `prevent_close`（M-08/M-17）、sidecar 进程清理（M-07/M-31）、
**三入口幽灵组合（M-32，阻塞级）**。

---

## 10. L9 安装包 —— ✅ **构建产物 + 安装/升级/卸载已验证；GUI 部分未验证**

完整逐项记录见 **`docs/qa/packaging.md`**（P-01~P-44，含实际命令、返回码、实测输出）。

### 10.1 已验证（实测）

| 组 | 结论 | 关键证据 |
|---|---|---|
| P-01~P-09 构建产物 | ✅ 通过 | 安装包 68,304,417 B，SHA256 `2f10382c69cda161d9194f9da7b6fb13e4a967b1bedca2d5cb6c36cb31dee5eb`（QA 独立算出，与 Lead 一致）；`capabilities/subtitle-window.json` 与契约逐字一致且**无 `global-shortcut` 泄漏**；未新增图标资源 |
| P-06 sidecar 打包 | ✅ 通过（独立复现并加强） | 打包 exe 的 `ready` 含两个新命令；`ping`/`devices` ok；未知命令 → `unknown_command`；无 session → `no_active_session`；**非法 channel → `invalid_channel`（证明参数校验先于 session 校验）**；shutdown exit 0；stdout 零非 JSON 行、stderr 空 |
| 安装（静默 `/S`） | ✅ 通过 | exit 0 / 6.8s，未提权；`DisplayVersion` **0.3.0 → 0.3.1**；快捷方式重建 |
| **sidecar 字节级随包** | ✅ 通过 | 安装目录 `translator-bridge.exe` 66,090,911 B，SHA256 `F6406CBCAD948804` = `binaries\…` 产物**完全一致** |
| 首次启动 + **契约 §10** | ✅ 通过 | 进程常驻；`CloseMainWindow()` → 6s 后进程**仍存活**、窗口标题变空 → **关闭主窗口=隐藏到托盘，不退出** |
| **P-14 无控制台黑框** | ✅ 通过 | 主程序 PE `Subsystem=2 (WINDOWS_GUI)`；侧车 `Subsystem=3` 但 `lib.rs:1999 CREATE_NO_WINDOW` |
| 配置迁移（读取路径） | ✅ 通过 | 安装前后 + 启动前后，两份 settings **逐字节未变** |
| 卸载 | ✅ 通过 | exit 0 / 0.7s；目录/注册表/快捷方式/进程全部清理；**用户配置被正确保留** |
| 环境复原 | ✅ 完成 | 备份原样还原，SHA256 与备份一致；系统回到安装前状态 |

### 10.2 未验证（安装版 GUI 与受限路径）

| 项 | 为什么 | 谁能做 |
|---|---|---|
| P-13 托盘图标 / P-30 右键菜单 / P-33 五个全局快捷键 / P-34 字幕窗置顶 / **P-36 = M-32 三入口幽灵组合（阻塞级）** | **需一台没有其它输入焦点的桌面**；合成全局快捷键是系统级输入，会干扰用户当前会话（Lead 已明确否决在该桌面上做合成输入） | 人工 `manual-checklist.md` §0.1 |
| P-23 单实例（双击两次） | 需 GUI | 人工 |
| P-44 卸载后重装 | 本轮未做二次重装 | 可单独执行 |
| P-41 **强判据**（有活跃 session 时优雅退出 → 侧车消失） | 空闲态侧车未启动，本轮「无残留」属**平凡成立**；优雅退出需托盘菜单 | 人工 M-07/M-31 |
| 配置迁移的**保存路径** | 需从 UI 保存设置才会触发规范化写回 | 人工 |

> **不可逆差异（如实披露）**：`%LOCALAPPDATA%\…\EBWebView` 由 970 文件/140.40 MB 增至 **977 文件/140.51 MB**
> （启动一次应用产生的 WebView2 缓存）。按 Lead 指示未整份复制该目录，故**无法逐文件回滚**；不属安装残留。

---

## 11. 逐项验收结论（task-4 交付物）

| # | 交付物 | 状态 | 证据 |
|---|---|---|---|
| 1 | `docs/qa/baseline.md` 改动前基线 | ✅ 完成 | Rust 29 pass / Python 70+11 OK / build exit 0 / node 9 pass |
| 2 | `docs/qa/test-matrix.md` 测试矩阵 | ✅ 完成 | 7 个维度，按 Lead 裁决更新 D1/D2 判据 + 新增 §1.5/§1.5.1（B-22~B-30） |
| 3 | `scripts/test_runtime_integration.py` | ✅ 完成并全绿 | **96 条**，tier A/B/C/D/E，真进程真 JSONL |
| 4 | 独立复验 Python（未删断言） | ✅ 完成 | 86/18/36 OK，removed=0 |
| 5 | 独立复验 Rust | ✅ **完成** | `cargo fmt -- --check` exit 0；`cargo test` 49 = 48 pass + 1 ignored；基线 29 条 removed=0；四类必查覆盖逐条核对（§9.1）；build.rs/`#[link]` 审计（§9.3） |
| 6 | 独立复验前端 | ✅ 完成 | build exit 0，37 pass，9 条基线用例逐字仍在 |
| 7 | `docs/qa/manual-checklist.md` | ✅ 完成（待人工执行） | 32 条（含阻塞级 M-32），每条含可判定通过标准与结果栏 |
| 8 | `docs/qa/known-issues.md` | ✅ 完成 | 8 条，全部可复现；无推测项 |
| 9 | `_tray-shortcut-check.cjs` | ✅ 完成并全绿 | 33 PASS / 0 FAIL / 1 SKIP |
| 10 | NSIS 安装包验证 | ✅ **完成（GUI 项除外）** | 构建产物 + sidecar 字节级随包 + 静默安装/升级/卸载 + 契约 §10 + 无控制台黑框 + 配置零改写 + 环境复原；GUI 项列 §10.2 待人工 |

### 契约验收项（按维度）

| 契约 | 验收焦点 | 结论 |
|---|---|---|
| `runtime-channel-control.md` R §1.2 复位 | 重启后通道/muted 复位 | ✅ 通过（集成 tier B） |
| R §1.3/§2.2 未配置通道 | `channel_not_configured`，不伪造 | ✅ 通过 |
| R §1.4 关一个不停整个 | 无 `state=stopped` | ✅ 通过 |
| R §2/§3 参数与错误码 | 8 种非法输入 → 正确 code | ✅ 通过（tier D 严格） |
| R §3.1 幂等 `changed` | 重复值 `changed:false` | ✅ 通过（含并发） |
| R §4.2 事件字段 | `runtime.channel{channel,enabled,configured}` / `runtime.mute{muted}` | ✅ 通过 |
| R §4.3 健康事件 | `audio.status`(带 channel) / `network.status`(degraded/failed) | ✅ 通过（含真实引擎） |
| R §4.4 错误分类 | `service` ∈ 4 值；D1/D2 code 偏差已裁决 | ✅ 通过 + ⚠️ 已接受偏差 |
| R §5 旧 session 丢弃 | sidecar 侧不改变状态；**Rust 侧未验证** | ⚠️ 部分（Rust 阻断） |
| R §6 音频安全开关 | 状态机通过；**物理帧拦截未验证** | ⚠️ 部分 |
| `runtime-channel-control.md` R §1.5 关通道清静音 | 清除 + **事件顺序**（先 mute 后 channel） | ✅ 通过（tier E，原始 JSONL） |
| R §1.5 反向 | 重新启用不得改变 `speak_muted` | ✅ 通过 |
| R §1.5.1 拒绝口径边界 | 绕过 Rust 可瞬时构造幽灵态；**无法持久** | ✅ 通过（实测）；应用内三入口 ⚠️ **未验证**（M-32 阻塞级） |
| `tray-shortcuts-contract.md` T §2/§3 | 字段/顺序/优先级与 serde 名 | ✅ 通过（**cargo test**，见 §9.1） |
| T §5/§6 Tauri 命令与事件 | 命令接线、`runtime-state` 仅真变化才广播、仅值变化才 +revision | ✅ 通过（单元级） |
| T §7 dispatcher 幂等/防重入 | 会话闸门 + 去抖 | ✅ 通过（单元级）；真实入口触发仍需人工 |
| T §8 全局快捷键 | 5 项映射表、id 唯一、Ctrl+Shift、去抖 250ms | ✅ 通过（单元级）；**真实按键注册/触发未验证**（M-09~M-14） |
| T §9/§10 托盘与生命周期 | 菜单 id/文案/状态派生 | ✅ 静态 + 单元级；**真实托盘行为未验证**（M-01~M-08、M-31） |
| `subtitle-window.md` S §1/§5/§6 | 分支挂载/结构/透明/字号/小尺寸 | ✅ 通过（浏览器构建产物） |
| S §3/§7 窗口生命周期与置顶 | hide/show/置顶/不影响 session | ⚠️ 静态通过；需人工 M-15~M-20 |

---

## 12. 明确覆盖不到的面（不粉饰）

1. **Rust 任何运行期行为** —— cargo 阻断（§9）。所有「Rust 侧通过」目前**都不存在实测证据**。
2. **托盘的真实显示与交互**：图标、tooltip、右键菜单、勾选态同步、隐藏时菜单可用性（人工 M-01~M-06）。
3. **真实全局快捷键**：真实按键、与被占用软件的冲突、最小化/隐藏/失焦时是否仍生效（M-09~M-14）。
   浏览器自动化只能证明 UI 侧接线，**不能证明全局快捷键注册成功**。
4. **字幕窗口的真实窗口行为**：跨应用置顶、无边框拖拽/缩放、`skip_taskbar`、多显示器/DPI（M-15~M-19）。
   浏览器里 `?window=subtitle` 的断言只覆盖**渲染与结构**，不覆盖 Tauri 窗口属性。
5. **真实音频链路的物理效果**：关收听/静音后麦克风帧是否真的不再进入引擎（R §6.1/§6.2）。
   集成测试用离线桩，**结构上无法证明**；只有代码审阅 + Python 单测 + 人工听感。
6. **真实网络异常**：真实 WebSocket 断线/重连/鉴权失败（D 组只有注入与单测）。
7. **安装版**（§10）。
8. **长稳/性能**：数小时运行的泄漏与内存增长。
9. **`recoverable` 的用户可见效果**：只在代码层确认无自动重启；「重试按钮是否该出现」属 UI 体验，未做用户级验证。

---

## 13. 结论

- **Rust 单测：✅ 通过（QA 独立复跑）**——`cargo fmt -- --check` exit 0；
  `cargo test` = 49 tests（48 pass / 0 failed / 1 ignored）；基线 29 条 **removed=0**；
  四类必查覆盖（trayStatus 优先级含 degraded 边界、旧 session 丢弃、250ms 去抖、快捷键映射表）逐条核对属实。
- **Python / 前端 / 跨模块集成三层：实测全绿**（96 + 140 + 37 + 33 条断言级证据），
  且**未发现任何被自测粉饰的假绿**（删断言 = 0：Rust removed=0、Python removed=0、前端 9 条基线名逐字仍在）。
- **D1/D2/D3 三条裁决：全部完成反向验证**，其中 D1 的真实引擎证据与 D2 的 degraded 证据
  都是**证伪型**（先尝试推翻，再接受）；D3 由我独立复核（`.recoverable` 生产代码零读取 + 无 restart 标识符）。
- **§1.5 / §1.5.1：第 2 条（原始 JSONL）已实测通过**，且我实测发现的「幂等关闭也清幽灵」
  已被 Lead 固化为 **§1.5.0（禁止回退）**；第 1 条（应用内三入口）**只完成
  入口①的浏览器不变量 + ②③的静态推理**，真实桌面版与安装版**均未复现**（阻塞级人工项 M-32）。
- **人工联调（32 条）与安装版（L9）：未验证**，清单已就绪，随时可执行。

## 14. 证据时效性记录：L4/L5/L6 一度失效，**已对新 dist 重跑消解**（保留原始证据，不删除）

> 本节是本轮最有价值的流程教训之一，**保留原始证据与失效判定**，不做「看起来更干净」的删改。

### 14.1 事实时间线（全部为实测时间戳）

| 时间 | 事件 |
|---|---|
| 19:17:40 | 前端源码最后一次改动（我当时的验证基准） |
| **19:19:29–19:19:31** | 我执行 `npm run build`，产出 `dist/`（本轮 L4/L5/L6 的证据基准） |
| 19:19–19:22 | 我跑 node 测试（**37 pass**）与浏览器自动化（**33 PASS / 0 FAIL / 1 SKIP**） |
| ~19:27 | Lead 宣布代码冻结并启动排他打包 |
| **19:28:35 / 19:28:52 / 19:28:57 / 19:29:28** | `runtime.ts` / `tauri.ts` / `App.tsx` / `runtime-mock.test.mjs` **再次被改动**（Lead 授权的 task-8：托盘「设置」缺失监听者的修复） |
| 19:29–19:34 | QA 发现并上报「源码与 dist 不一致」；**`desktop/dist/` 仍停留在 19:19:31** |

### 14.2 失效判定（我主动作废自己的结论）

- **L4 / L5 / L6 的结论只对 19:17:40 之前的前端源码有效**，对 19:28 之后的源码**不再有效**。
  因此在上表 §2 中这三行已标注 **⚠️ 已被 19:28 源码变更作废，待重跑**。
- 依据：`desktop/dist/` 的构建时间戳为 **19:19:31**，**早于** 19:28 的源码改动
  → 该 dist **不包含** task-8 的修复，用它做的任何前端/浏览器结论都不能代表当前源码。

### 14.3 原始证据（保留，供追溯）

| 项 | 值 |
|---|---|
| 验证基准源码 | 19:17:40 之前的 `desktop/src/**`（`main.tsx` = `377204ECBA3035D2`） |
| 被验证的 dist（19:19:31） | `index.html` = `766E10000C17641B`；`index-B88iHQZn.css` = `62D0D76DABD306FC`；`index-Dxm9bthK.js` = `CC6EE45BADAC7441` |
| L4 结果 | exit 0，1839 modules |
| L5 结果 | 37 pass / 0 fail（基线 9 条逐字仍在，见 §6.3） |
| L6 结果 | 33 PASS / 0 FAIL / 1 SKIP（含 3 条 §1.5.1 不变量） |

**作废后的源码状态**（待重跑时作为新基准）：
`App.tsx` = `832952A05F2D789D`（19:28:57）、`tauri.ts` = `EA3E5307F9A6F764`（19:28:52）、
`runtime.ts` = `0C66668A75BD7B87`（19:28:35）、`tests/runtime-mock.test.mjs` = `B046C7387C7E75C2`（19:29:28）。

### 14.4 处置（**已执行完毕**，Lead 裁决后更新）

1. Lead 已明确：**19:28 的修复必须进入发布物**。✅ 已进入（见下）。
2. **关键事实（Lead 指出，我接受）**：`tauri.conf.json` 的 `build.beforeBuildCommand` 就是 `npm run build`
   → **排他打包内部本来就会重建 `desktop/dist/`**，Tauri 随后把它嵌进二进制。
   因此**不需要**（也**不可以**）由 QA 再跑一次 `npm run build`：
   并发写 `dist/` 会造成「一半是我写的、一半是打包写的」的混合产物，且**事后无法区分**，
   正是 KI-11 那类问题。**QA 的并发请求已被 Lead 否决，我接受并已按此执行。**
3. ✅ **已执行的消解**：打包（19:44:35→19:50:08，exit 0）内部的 `beforeBuildCommand`
   在 **19:47:27** 重建了 `dist/`，QA **未**自己 build。
4. ✅ **重跑结果（绑定打包后的 dist，即「安装包内的前端」）**：

| 项 | 值 |
|---|---|
| `dist/index.html` | 450 B，19:47:27，`1CC6F563DB257529` |
| `dist/assets/index-B88iHQZn.css` | 51,128 B，`62D0D76DAB306FC` |
| **`dist/assets/index-CuYVL2m9.js`** | **313,037 B，`4A2D770530D616FA`**（19:19 那版是 `index-Dxm9bthK.js`/312,583 B → JS 哈希与体积均变化，与 task-8 增量一致） |
| 前端源码时间点 | `App.tsx` 19:28:57 / `tauri.ts` 19:28:52 / `runtime.ts` 19:28:35（此后无新改动） |
| **L5 重跑** | **38 pass / 0 fail**（较上次 +1：`the mock open-settings channel subscribes and unsubscribes without throwing` = task-8 的回归断言；基线 9 条逐字仍在，5→5 / 4→4） |
| **L6 重跑** | **33 PASS / 0 FAIL / 1 SKIP**（preview 已确认提供新 `index-CuYVL2m9.js`） |
| **L3 重跑** | **96 PASS / 0 FAIL / 0 BLOCKED**（确认后端未回归） |

5. 产物追溯采用 **三元组**：**源码时间点 + `dist` 哈希 + 安装包 SHA256**
   = 19:28:57 前源码 ＋ `4A2D770530D616FA` ＋ `2f10382c69cda161d9194f9da7b6fb13e4a967b1bedca2d5cb6c36cb31dee5eb`。
6. 已同步记录为 `known-issues.md` **KI-11**（状态：**FIXED/CLOSED**，见 KI 文件）。

> 教训：**「构建产物验证通过」必须绑定到「具体源码时间点/哈希」**。
> 否则冻结后再改一行源码，先前所有前端与浏览器结论都会在无人察觉的情况下失效。
> 本次是因为 QA 主动比对 mtime 才发现，不是靠流程保证 —— 这一点值得写进后续迭代的检查表。

---

## 15. 最终结论（定稿）

> 定稿时点：2026-10-07 20:15 (+08:00)。代码已冻结；L4/L5/L6 在 19:28 的 task-8 修复后
> **已对新 dist 重跑消解**（详见 §14）。本节是**唯一**的结论段；
> 前面各节是证据。**「通过」只用于我真的执行过、且证据有效期内的项。**

### 15.1 已实测通过项（**证据三元组**）

> **源码时间点**：前端 19:28:57 前 ｜ Rust `lib.rs` `9E208EF0EEEE6A96`、`tray.rs` `8B1CD14A0187BCFC`、`build.rs` `31E0E8C3082909E6` ｜ Python `tauri_bridge.py` `06BEFA88B2B4E842`、`livetranslate.py` `9184113FF3D00577`
> **dist（安装包内前端）**：`index.html` `1CC6F563DB257529`、`index-B88iHQZn.css` `62D0D76DAB306FC`、**`index-CuYVL2m9.js` `4A2D770530D616FA`**
> **安装包 SHA256**：**`2f10382c69cda161d9194f9da7b6fb13e4a967b1bedca2d5cb6c36cb31dee5eb`**（68,304,417 B）

| 层 | 结论 | 关键数字 | 证据 |
|---|---|---|---|
| L1 Rust 单测 | ✅ 通过 | `fmt` exit 0；`cargo test` **49 = 48 pass + 0 fail + 1 ignored**；基线 29 条 **removed=0**、added 19 | §9、§9.1 |
| L2 Python 单测 | ✅ 通过 | **86 + 18 + 36** 全 OK；基线 **removed=0** | §5 |
| L3 跨模块集成（QA 自建） | ✅ 通过 | **96 PASS / 0 FAIL / 0 BLOCKED**（7 tier）；连跑 3 次稳定 | §3、§3.2(c) |
| L4 前端构建 | ✅ 通过 | 打包内 `beforeBuildCommand` 重建 dist（19:47:27），QA 核验产物哈希并绑定；**刻意未自行 build**（避免并发写 dist，§14.4） | §14.4 |
| L5 前端单测 | ✅ 通过 | **38 pass / 0 fail**（基线 9 条名逐字仍在：5→5、4→4） | §14.4 |
| L6 浏览器自动化（QA 自建） | ✅ 通过 | **33 PASS / 0 FAIL / 1 SKIP**（对**打包后**的 dist） | §7、§14.4 |
| L7 静态契约核对（Lead 提供） | ✅ 通过（**仅为必要不充分条件**） | 68 / 0 / 0，局限见 §8；源码冻结后复跑仍一致 | §8 |
| 反向验证 D1 | ✅ 证伪型通过 | 真实引擎发出 `audio_device_failed` + `service=audio`，**无** `audio_start_failed` | §4.1 |
| 反向验证 D2 | ✅ 证伪型通过 | `network.status=degraded` 真实发出；**0 次** `websocket_reconnecting`；sibling 存活不终止会话 | §4.2 |
| 反向验证 D3 | ✅ 独立复核通过 | 生产代码 `.recoverable` **零读取**；无 restart/retry 标识符 | §4.3 |
| §1.5 / §1.5.0 / §1.5.1（sidecar 侧） | ✅ 实测通过 | 事件顺序 `[mute:false, channel:false]`；幂等关闭也清幽灵；幽灵态不可持久 | §4.4(a) |
| build.rs / `#[link]` 审计 | ✅ 通过 | 六条依据 + `cargo build --lib --bins` exit 0 | §9.3 |
| **L9 安装/升级/卸载** | ✅ **通过（GUI 项除外）** | 静默安装 exit 0 / 6.8s；0.3.0→0.3.1；sidecar **字节级随包**；**契约 §10 实测成立**；无控制台黑框；配置**逐字节未变**；卸载 exit 0 / 0.7s；**系统已复原** | §10、`packaging.md` |

### 15.2 **未验证**项（单列，**不得**在任何汇总里写成通过）

| # | 未验证项 | 为什么没做 | 谁做 / 前置条件 |
|---|---|---|---|
| U-1 | **真实托盘行为**：图标显示、tooltip 随状态变化、勾选态同步、隐藏时右键菜单可用、`显示主窗口` 恢复焦点 | Agent 无法操作 Windows 通知区域；且状态变化需要真实会话驱动 | 人工 M-01~M-06 ／ **需一台没有其它输入焦点的桌面** |
| U-2 | **真实全局快捷键**：5 键注册成功、与被占用软件冲突、最小化/隐藏/失焦时仍生效、退出后注销 | 合成全局快捷键是**系统级输入**，会投递到无法预测的焦点上下文并可能触发其它软件的同名快捷键 → Lead 明确否决在活跃桌面上做 | 人工 M-09~M-14 ／ 同上前置条件 |
| U-3 | **窗口生命周期的人工确认**：托盘「退出应用」结束 sidecar、单实例、退出时正在翻译 | 需托盘菜单与真实会话；本次只验证了「关闭主窗口不退出」这一条（已通过） | 人工 M-07/M-08/M-31 ／ 同上 |
| U-4 | **字幕窗真实窗口属性**：跨应用置顶、无边框拖拽/缩放、`skip_taskbar`、真实 show/hide、刷新恢复 | 浏览器只能证明**渲染与结构**，不能证明 Tauri 窗口属性 | 人工 M-15~M-20 ／ 同上 |
| U-5 | **应用内三入口幽灵组合**（§1.5.1） | 入口②③需真实托盘+快捷键；安装版亦未测 | 人工 **M-32（阻塞级）** ／ 同上 |
| U-6 | **真实音频链路的物理效果**：关通道/静音后麦克风帧是否真的不再进入引擎 | 离线桩在结构上无法证明物理链路 | Python 侧代码审阅 + 人工听感 M-23 |
| U-7 | **真实网络异常**：真实断线/重连/鉴权失败 | 无可用密钥与稳定复现手段；本轮只用故障注入与单测 | 人工 M-24~M-26 |
| U-8 | **安装版 GUI 项**：P-13 托盘图标、P-30 右键菜单、P-33 快捷键、P-34 字幕窗置顶、**P-36 = M-32** | 同 U-1~U-5，且同样受「活跃桌面」限制 | 人工 `manual-checklist.md` §0.1 |
| U-8b | **安装版受限路径**：P-23 单实例（需双击两次）、P-44 卸载后重装（本轮未做）、**P-41 强判据**（有活跃 session 时走托盘优雅退出 → 侧车消失）、配置迁移的**保存路径** | 分别需要 GUI / 二次重装 / 托盘退出 / UI 保存；空闲态侧车未启动，故本轮「无残留」属**平凡成立** | 人工 |
| U-10 | **长稳/性能**：数小时运行的泄漏、内存增长 | 超出本轮范围 | 后续独立测试 |

> 已消解：U-9（release 链接）由本次打包间接回答 —— `npm run desktop:build` exit 0，
> 产出可安装、可启动的 release 产物，无重复资源错误。

### 15.3 三条更正与两条附注（防止误读）

**更正**
1. `0xc0000139` 根因**不是**并发构建产物不一致，而是 Common-Controls v6 清单未链进库的测试 harness（§9.2）。
2. 基线 Rust 29 项来自**改动前的旧 exe**，**那次运行是有效的**——我此前「先前全绿不可信」的说法已更正。
3. 我最初假设「幂等关闭不会清幽灵静音」，被自己的实测推翻（已固化为契约 §1.5.0）。

**附注**
4. 本轮我修掉了**自己**两处假绿（负面断言空转、竞态期望算错），说明见开头的「非粉饰自查」。
5. 「启用发言通道后落回 `needs_configuration`」是**既有产品行为**，属测试可达性限制，**不是缺陷**（KI-06）。
6. **不可逆差异如实披露**：`%LOCALAPPDATA%\…\EBWebView` +7 文件 / +0.11 MB（启动一次产生的 WebView2 缓存），
   因未整份复制该目录，**无法逐文件回滚**；用户配置已原样还原（含原始 mtime）。

### 15.4 一句话总论（定稿）

> **代码与自动化验证就绪 ≠ 功能已验收 ≠ 可以发布。**
>
> 本轮：**Rust 48/0、Python 140、跨模块集成 96、前端 38、浏览器 33、静态 68 全部为真绿，
> 且未发现「删断言换绿」**（Rust/Python `removed=0`、前端基线 9 条逐字仍在）；
> **安装/升级/卸载路径已实测通过，系统已复原为安装前状态**（用户配置含原始 mtime 保持不变）。
> 但**托盘与全局快捷键等 GUI 行为、字幕窗真实窗口属性、三入口幽灵组合（M-32 阻塞级）、
> 有活跃 session 时的优雅退出清理**仍为未验证 —— 它们需要一位操作者在**一台没有其它输入焦点的桌面上**执行。
> 发布前另须消除 **KI-10**（版本号未升，本次产物不得用于发布）并建议处理 **KI-13**（未签名）。





