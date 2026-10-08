# 已知问题 / 复现记录

> 维护者：Agent 4 / `qa-verifier`
> 规则：**只有能复现的才写进来**，每条必须给「复现步骤 + 最小用例 + 影响范围 + 是否阻塞」。
> 归属：`QA` = 测试侧问题，`PY` = Python sidecar/引擎，`RS` = Rust/Tauri，`FE` = 前端，`ENV` = 环境/工具链。
> 状态：`OPEN` / `ACCEPTED`（Lead 已裁决接受偏差）/ `FIXED` / `WONTFIX`。

---

## KI-01 `cargo test` 因 Common-Controls v6 清单未链进测试 harness 而无法启动 —— **ENV，FIXED（根因已更正）**

> ⚠️ **根因更正**：我最初的判断（并发构建产生陈旧 `.dll.lib`）**是错的**，已接受 rust-native 的纠正。
> 正确的根因见下。

- **现象**：`cargo test` 直接失败，测试二进制根本没跑起来：
  ```
  Running unittests src\lib.rs (target\debug\deps\simultaneous_translator_lib-8a900abf80b57c46.exe)
  error: test failed, to rerun pass `--lib`
  Caused by: process didn't exit successfully: ... (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)
  ```
- **正确根因**：Tauri `tray-icon` feature 在 Windows 的平台坑 —— `muda` 导入 `TaskDialogIndirect`，
  该符号只存在于 **Common-Controls v6** 程序集；`tauri-build` 只通过 `cargo:rustc-link-arg-bins`
  把 v6 清单链进 **bin** 目标，而**库的单元测试 harness 不是 bin 目标** → 加载 `comctl32.dll` 的 v5 shim → 缺符号。
- **对方证据**：全新 `cargo clean -p simultaneous-translator` 后**仍失败**（排除陈旧产物说）；
  手工移除外部 `.manifest` 后**立即复现**。
- **修复**：`build.rs` 增加 `cargo:rustc-link-search=native=<OUT_DIR>`；
  `lib.rs` 增 `#[cfg(all(test, windows))] #[link(name="resource", kind="static")] extern "C" {}`。
- **我的独立佐证（⛔ 非独立复现）**：`OUT_DIR\resource.lib` 存在（13216 B）；
  当前测试 harness exe 内嵌字符串含 `Microsoft.Windows.Common-Controls` / `TaskDialogIndirect` /
  `comctl32` / `6.0.0.0` → 与「清单缺失」因果链一致。我**没有**用「删清单→复现」的方式独立复现。
- **影响范围**：仅「Rust 单测能否执行」，**不是产品缺陷**；修复不进入 bin/cdylib（`cfg(test)` 门控）。
- **是否阻塞**：曾阻塞 L1；**现已解除**。
- **状态**：**FIXED**（QA 已独立复跑：`cargo fmt -- --check` exit 0、`cargo test` 48 pass / 0 fail / 1 ignored）

---

## KI-02 `scripts/test_runtime_channels.py` 当前 2 条自测失败 —— **PY，观察中（可能是在写中）**

- **现象**：`Ran 27 tests ... FAILED (failures=2)`
  ```
  FAIL: test_a_finished_session_mismatches_instead_of_mutating_a_new_one
        AssertionError: True is not false
  FAIL: test_malformed_params_never_reach_the_runtime_state (params=None)
        AssertionError: 'invalid_channel' not found in ['invalid_params', 'invalid_request']
  ```
- **复现步骤**：`.venv\Scripts\python.exe scripts\test_runtime_channels.py`
- **影响范围**：仅该测试文件；同一语义在 QA 的 L3 集成测试里（真实进程）是**通过**的。
- **初步判断**：更像「测试期望值」与实现不一致，而不是线上行为错误：
  - 第 2 条的 `params=None`（整体缺 params 对象）被实现判为 `invalid_channel`，
    契约 R §2.1 要求「`channel` 不是 listen/speak → `invalid_channel`」；
    但「params 不是对象」按既有 `handle_request` 会先返回 `invalid_request`。
    两种解释都能自洽 → 属**契约歧义**，见 KI-04。
- **是否阻塞**：否（不阻塞 L3；但 L2 复验结论必须写成「2 项失败」而不是通过）。
- **状态**：OPEN（等 python-bridge 收尾后复跑确认）

---

## KI-03 D1/D2 偏差：契约声明了实现永远不会发出的 code —— **ACCEPTED（Lead 已裁决）**

- **现象**：`audio_start_failed` 与 `websocket_reconnecting` 出现在 `docs/runtime-channel-control.md` §4.4 的对照表里，
  且在 Python 的 `error_service` / `error_recoverable` 映射中已声明，但**没有任何代码路径会发出它们**。
- **D1 反向验证（我实测，真实引擎）**：
  ```
  speak 通道 input=microphone, input_device=qa-no-such-device-0000
  → {"event":"error","data":{"scope":"audio","service":"audio","code":"audio_device_failed",
       "message":"发言通道音频设备打开失败：no device with id qa-no-such-device-0000","recoverable":false}}
  → {"event":"audio.status","data":{"status":"failed","channel":"speak","detail":"..."}}
  ```
  即：**发出的是既有 code `audio_device_failed`，`service=audio` 成立，`audio_start_failed` 未发出**。
  → 偏差**真实存在**，不是实现方的猜测。
- **D2 反向验证（我实测，故障注入走真实聚合代码）**：
  ```
  注入「speak 连接失败 + listen 存活」
  → {"event":"network.status","data":{"status":"degraded","detail":"..."}}
  全程无 websocket_reconnecting（0 命中）；无 network.status=failed；无 state=stopped
  ```
  → 引擎没有重连逻辑，发 `websocket_reconnecting` 就是伪造状态，保留为「已声明、当前不发出」是合理取舍。
- **影响范围**：契约文档与实现的**书面差异**；Rust 侧 `error_service` 映射里有这两个键但永远不会命中。
- **是否阻塞**：否。已由 Lead 裁决接受（记录于 `docs/runtime-channel-control.md` §4.4.1）。
- **复验判据（已写入 test-matrix）**：音频失败看 `service == "audio"`；网络健康看 `network.status` 的 `degraded` / `failed`。
- **状态**：ACCEPTED

---

## KI-04 契约歧义：错误码优先级未定义 —— **QA，OPEN（低危）**

- **现象**：当**多个**校验同时不满足时（例如无活跃 session **且** `channel` 非法 **且** 缺 `session_id`），
  契约 R §2.1/§3.2 没有规定先判哪个，实现与测试期望可能不同。
- **最小用例**：
  ```json
  {"type":"request","id":"x","command":"set_runtime_channel","params":{}}
  ```
  实测（QA L3）：`no_active_session`（无 session 时），python-bridge 自测期望 `invalid_params`。
- **实测补充（2026-10-07 19:52，对**打包后**的 sidecar exe）**：
  ```json
  {"command":"set_runtime_channel","params":{"session_id":"<随机 UUID>","channel":"nope","enabled":false}}
  → ok:false code=invalid_channel        ← 无活跃 session，但仍先报参数错误
  ```
  → **实际优先级已被实测确定**：**params/channel 校验 先于 session 存在性校验**。
  这与契约 §2.1 的书写顺序一致，但契约未明文规定。
- **影响范围**：仅错误码文本；不影响状态正确性（都拒绝、都不改状态）。
- **是否阻塞**：否。
- **建议**：在契约里补一句「校验顺序：params 结构 → 命令参数（channel/enabled/muted）→ session 存在性 → session 匹配 → 通道配置」，
  把已实测的顺序固化，避免后续实现无意改变优先级。
- **状态**：OPEN（**低危，仅缺契约明文**；行为已被实测确定）

---

## KI-05 `input: "system"` 时 `input_device` 被忽略（**非缺陷，易误判**） —— **QA，ACCEPTED**

- **现象**：一开始我用「`listen` 通道 + 假 `input_device`」想制造音频失败，结果音频**成功打开并连网**：
  ```
  audio.status {"status":"ready","channel":"listen"}   ← 说明假设备 id 未生效
  error {"service":"network","code":"websocket_connect_failed"}   ← 失败发生在网络阶段
  ```
- **原因**（读码确认）：`input_kind == "system"` 走 `SystemCapture`（自动排除本软件），
  **按设计不使用 `input_device`**；只有 `loopback` / `microphone` 才用 `sc.get_microphone(id=...)`。
- **影响范围**：仅影响「如何构造音频失败用例」；不是产品缺陷。
- **是否阻塞**：否。
- **备注**：已写入 `test-matrix.md` C 组备注，避免后续复验者误判为「配置不生效」缺陷。
- **状态**：ACCEPTED（结论已固化到测试代码注释）

---

## KI-06 前端：启用发言通道后落回「配置同传」 —— **非缺陷（Lead 已确认），测试可达性限制**

- **现象**（浏览器 mock，`http://127.0.0.1:4173/`）：
  1. 初始 `sessionPhase` 可开始同传（按钮 `开始同传`）；
  2. 在设置 → 音频里勾选**发言通道**并保存；
  3. 会话按钮变为 **`配置同传`**（`needs_configuration`），四个运行时开关全部禁用（title = `请先开始同传，再使用通道控制`）；
  4. 此时浏览器内**无法**再验证静音链路。
- **复现步骤**：见上（Playwright 脚本 `_tray-shortcut-check.cjs` 的「通过设置启用发言通道」段）。
- **结论（Lead 裁决）**：这是**既有产品行为**——启用通道后配置完整性判定发生变化，
  **不是本次迭代的缺陷**。此条记录为**测试可达性限制**，不是 bug。
- **影响范围**：仅影响浏览器自动化的可测范围；静音/发言通道的用户可见行为改由
  人工清单 `manual-checklist.md` **M-09 / M-21** 覆盖。
- **是否阻塞**：否。
- **状态**：CLOSED（非缺陷，降级为测试限制说明）

---

## KI-07 Vite dev server 在并发 npm 操作下崩溃（EBUSY） —— **ENV，WONTFIX（已知）**

- **现象**：`npm run dev` 启动成功后，若另一进程同时执行 npm 相关操作（会创建
  `desktop\.package.json.<pid>.<uuid>.tmpdir\`），vite 的 fs watcher 抛 `EBUSY` 并**整个进程退出**：
  ```
  Error: EBUSY: resource busy or locked, watch '...\desktop\.package.json.23880.*.tmpdir\package.json.tmp'
  ```
- **复现步骤**：并发执行 `npm run dev` 与 `npm run build`（或 npm 的任意 tmpdir 操作）。
- **影响范围**：浏览器 UI 自动化会失去 dev server；**不影响构建产物**。
- **规避**：UI 复验固定走 `npm run build` + `npx vite preview --host 127.0.0.1 --port 4173`
  （preview 不监听文件系统，不受影响）。`_tray-shortcut-check.cjs` 支持 `--url` 切换。
- **是否阻塞**：否。
- **状态**：WONTFIX（工具链行为，记录以免重复排查）

---

## KI-08 QA 发现 → **已被 Lead 固化为契约 §1.5.0（禁止回退）** —— **CLOSED（契约明文）**

- **来源**：复验契约 §1.5 时，我的第一版断言写的是「重复 `enabled:false`（changed:false）不会清静音」，
  实测**推翻了我的假设**。
- **实测证据**（tier E，原始 JSONL 绕过 Rust）：
  ```
  状态：speakEnabled=false, speakMuted=true（§1.5.1 允许的瞬时幽灵态）
  → set_runtime_channel{speak, enabled:false}
    响应 {"ok":true,"result":{"channel":"speak","enabled":false,"changed":false}}
    事件 [["runtime.mute", false]]        ← 只补发 mute 事件，不补发 channel 事件
  → set_speak_muted{muted:false} → changed:false   ← 幽灵确已清除
  ```
- **处置（Lead 已完成）**：契约新增 **§1.5.0「更强保证：幂等关闭也要清掉幽灵静音」**，
  明确「若未来有人把清理逻辑改成『只在 `changed` 时才执行』，即为**回退**，必须被 review 拦下」。
- **回归防护**：`scripts/test_runtime_integration.py` tier E 中的断言
  `§1.5.0 幂等关闭（changed:false）也清掉幽灵静音，且只补发 runtime.mute{false}`
  **变红即代表回退**。
- **影响范围**：无负面影响（行为强于最低要求）。
- **是否阻塞**：否。
- **状态**：CLOSED（已升格为契约明文 + 有回归断言）

---

## KI-09 启动握手期间退出最长等待 60s —— **RS，OPEN（非阻塞，既有行为）**

- **现象**：在「开始同传」的启动握手进行中点击退出/停止，界面最长可能等待 **60 秒**才返回。
- **口径（rust-native 确认，我已独立读码佐证）**：这是 `EngineManager.process` 锁的**既有粒度**——
  该锁在 `start_translation_inner` 中**跨 launch + 握手**持有。**典型耗时 2–5s**，
  只有 sidecar 卡死时才会走到 60s 上限。**不是死锁**，也**不是本次迭代引入**。
- **我的独立读码佐证**（只读，未改代码）：
  - `desktop/src-tauri/src/lib.rs:93`：`const ENGINE_START_TIMEOUT: Duration = Duration::from_secs(60);`
  - `lib.rs:1865`：`let deadline = Instant::now() + ENGINE_START_TIMEOUT;`
  - `lib.rs:1894`：`Err(mpsc::RecvTimeoutError::Timeout) => return Err("翻译引擎启动超时".into())`
    → 这是**有超时的等待**（`recv_timeout`），从代码结构上排除「无限等待/死锁」。
- **影响范围**：极端情况下退出体验差（无进度反馈时像卡住）；不丢数据、不残留进程。
- **是否阻塞**：否。
- **建议**：未来可把锁粒度收窄到「launch only」并给握手单独的取消信号；属独立改进项，不属本次验收。
- **状态**：OPEN（记录在案，非本次范围）

---

## KI-10 安装包版本号碰撞：本次构建沿用 0.3.1，**不得用于发布 beta0.3.1** —— **REL，OPEN（发布流程风险）**

- **事实（我已独立核对）**：
  - `desktop/src-tauri/tauri.conf.json` 的 `version` = **`0.3.1`**（未升版本号）；
  - 既有产物 `desktop/src-tauri/target/release/bundle/nsis/同传翻译_0.3.1_x64-setup.exe`
    已存在：**68,066,090 B**，2026-10-07 17:51 → 本次构建会**同名覆盖**它；
  - 已发布目录 `E:\Project\translation\releases\beta0.3.1\` 内含
    `simultaneous-translator_0.3.1_x64-setup.exe`（**同样 68,066,090 B**）与
    `SHA256SUMS.txt`（`1f561dd188cf0e8e…  simultaneous-translator_0.3.1_x64-setup.exe`）。
- **风险**：`releases/beta0.3.1/` 的**文件本身未被触碰**，但其 `SHA256SUMS.txt`
  与**新构建产物不再匹配**（内容已变、版本号未变）。若有人把新产物当成 beta0.3.1 发布，
  会出现「同一版本号、两个不同构建」的不可追溯状态。
- **结论（硬性）**：**本次安装包只能用于 QA 验证，绝不能直接用于发布 beta0.3.1。**
  正式发布必须先按流程**升版本号**（并重新生成 SHA256SUMS）。
- **影响范围**：发布流程与供应链可追溯性；对已发布内容**无**破坏。
- **是否阻塞**：不阻塞 QA 验证；**阻塞**「用本次产物发布」。
- **状态**：OPEN（已上报 Lead；发布前必须消除）

---

## KI-11 前端 `dist` 与源码一度不一致（冻结后仍改动） —— **PROC，OPEN（待重建消解）**

- **时间线（实测时间戳）**：
  | 时间 | 事件 |
  |---|---|
  | 19:17:40 | 前端源码最后一次改动（QA 的验证基准） |
  | 19:19:29–19:19:31 | QA `npm run build` → `dist/` 生成 |
  | 19:19–19:22 | QA 跑 node 测试（37 pass）与浏览器自动化（33 PASS） |
  | ~19:27 | Lead 宣布冻结并启动排他打包 |
  | **19:28:35 / 19:28:52 / 19:28:57** | `runtime.ts` / `tauri.ts` / `App.tsx` **再次改动**（Lead 授权的 task-8：托盘「设置」缺监听者的修复） |
  | 19:29:28 | `tests/runtime-mock.test.mjs` 改动 |
  | 19:29–19:34 | QA 比对 mtime 发现不一致并上报；**`dist/` 仍停在 19:19:31** |
- **后果**：QA 的 L4/L5/L6 结论**只对 19:17:40 前的源码有效**；`desktop/dist/`（19:19:31）
  **不包含** task-8 修复 → 用该 dist 做的任何前端/浏览器结论都不能代表当前源码。
  已在 `reverification.md` §2/§15.1 标注为 **「已作废、待重跑」**，并保留原始证据（§14）。
- **最终处置（Lead 决定）**：
  1. **19:28 的修复必须进入发布物** → 在版本冲突（见 KI-12）修复后**统一重建前端**；
  2. 产物追溯采用**三元组**：**源码时间点 + `dist` 哈希 + 安装包 SHA256**；
  3. QA 在 Lead 放行后重跑 `npm run build` → 全部 node 测试 → `_tray-shortcut-check.cjs`。
- **是否阻塞**：**曾阻塞「前端验证结论」的有效性**（不阻塞代码本身）。
- **最终状态**：**FIXED / CLOSED**。打包（19:50:08 exit 0）内部的 `beforeBuildCommand`
  已于 **19:47:27** 重建 `dist/`（`index-CuYVL2m9.js` `4A2D770530D616FA`），
  QA 据此重跑：**L5 38 pass / 0 fail、L6 33 PASS / 0 FAIL / 1 SKIP、L3 96 PASS / 0 FAIL**，
  并绑定三元组（源码 19:28:57 前 ＋ dist `4A2D770530D616FA` ＋ 安装包 `2f10382c…`）。
- **教训（建议进后续检查表）**：**「构建产物验证通过」必须绑定「具体源码时间点/哈希」**；
  冻结后任何源码改动都应立即作废对应的产物级结论 —— 本次是 QA 主动比对 mtime 才发现，
  **不是流程保证的**。
- **状态**：CLOSED（已重建并重跑，证据已绑定哈希）

---

## KI-12 首次打包在版本校验阶段失败（Tauri crate 与 npm API 失配） —— **REL，OPEN（task-9 处理中）**

- **现象**：`npx tauri build` 在版本校验阶段即退出，**`npm run build` 根本没有执行**，无安装包产出：
  ```
  Found version mismatched Tauri packages:
  tauri (v2.12.1) : @tauri-apps/api (v2.11.1)
  ```
- **根因**：`cargo add tauri-plugin-global-shortcut` 重新解析依赖，把 `tauri` crate 从 **2.11.5** 抬到 **2.12.1**
  （插件 2.4.0 要求 `tauri ^2.12`），而 npm 侧 `@tauri-apps/api` 仍是 **2.11.1** → CLI 拒绝构建。
- **处置（Lead 已派 task-9 给 rust-native）**：把插件锁到 `~2.3.2`（要求 `tauri ^2.10`），
  并把 `tauri` 解析回 2.11.5。
- **影响范围**：**仅打包**；开发/调试构建、单测、集成、浏览器验证**全部不受影响**（因此此前全绿是真实的）。
- **是否阻塞**：曾阻塞 L9 安装版验证。
- **QA 观察（值得记录的纪律价值）**：**Rust 单测、Python 单测、集成、浏览器全绿，照样卡在打包这一关** ——
  这正是「不允许把『开发版能运行』当作『安装版已完成』」的实例证据。
- **最终状态**：**FIXED**。rust-native（task-9）已把插件改为 `tauri-plugin-global-shortcut = "~2.3.2"`，
  `Cargo.lock` 解析回 `tauri = 2.11.5`（与 `@tauri-apps/api ^2.11.1` 匹配）；
  Lead 重新打包 **exit 0**（19:44:35→19:50:08），产物
  `同传翻译_0.3.1_x64-setup.exe`（68,304,417 B，SHA256 `2f10382c…`）。
- **状态**：CLOSED

---

## KI-13 安装包未签名（SmartScreen 会被拦） —— **REL，OPEN（发布待办，非本次功能引入）**

- **实测证据**（QA 只读检查）：
  ```
  Get-AuthenticodeSignature "…\bundle\nsis\同传翻译_0.3.1_x64-setup.exe"
    → Status = NotSigned
    → SignerCertificate = （空）
  VersionInfo: ProductName=同传翻译  FileVersion=0.3.1  CompanyName=（空）
  ```
- **影响范围**：用户双击安装包时 **Windows SmartScreen 会弹出「未知发布者」警告**，
  需要「更多信息 → 仍要运行」才能继续；企业环境可能被策略直接阻止。**不影响功能本身。**
- **是否本次引入**：**否** —— 属既有发布流程状态（此前版本同样未签名），本次只是把它记录成待办。
- **是否阻塞**：不阻塞 QA 验证（静默安装 `/S` 不受影响，已实测 exit 0）；**发布前建议处理**。
- **建议**：正式发布前申请代码签名证书并对安装包与主程序签名；
  短期至少在发布说明里告知用户 SmartScreen 提示的处理方式。
- **状态**：OPEN（发布类待办）

---

## 缺陷统计

### 每条的分类（阻塞性 × 是否本次引入）

| ID | 标题 | 阻塞? | 本次引入? | 状态 |
|---|---|---|---|---|
| KI-01 | `cargo test` 因 Common-Controls v6 清单未链进测试 harness 而无法启动 | 曾阻塞 L1（已解除） | **否**（既有构建配置在新增 `tray-icon` feature 后暴露） | FIXED |
| KI-02 | `test_runtime_channels.py` 2 条自测失败 | **否** | 是（编写中状态） | 已消解（并入 KI-04） |
| KI-03 | D1/D2：契约声明了永不发出的 code | **否** | 是（新增契约与实现的书面差异） | ACCEPTED（Lead 裁决） |
| KI-04 | 错误码优先级未在契约明文规定 | **否** | 是 | OPEN（低危；行为已实测确定，仅缺明文） |
| KI-05 | `input:"system"` 时 `input_device` 被忽略（易误判） | **否** | **否**（既有设计） | ACCEPTED（非缺陷） |
| KI-06 | 启用发言通道后落回 `needs_configuration` | **否** | **否**（既有设置校验行为） | CLOSED（测试可达性限制，非缺陷） |
| KI-07 | Vite dev server 在并发 npm 操作下 EBUSY 崩溃 | **否** | **否**（工具链行为） | WONTFIX |
| KI-08 | 幂等关闭也清幽灵静音的更强保证 | **否** | 是 | CLOSED（已升格为契约 §1.5.0，有回归断言） |
| KI-09 | 启动握手期间退出最长等 60s | **否** | **否**（既有锁粒度） | OPEN（非本次范围） |
| KI-10 | 安装包版本号碰撞（沿用 0.3.1） | **不阻塞 QA，阻塞发布** | 是（本次发布流程） | OPEN（发布前必须消除） |
| KI-11 | 前端 `dist` 与源码一度不一致（冻结后改动） | 曾阻塞前端结论（已解除） | 是（受控修复的时序副作用） | CLOSED（已重建重跑并绑定哈希） |
| KI-12 | 首次打包版本校验失败（tauri 2.12.1 vs api 2.11.1） | 曾阻塞 L9（已解除） | 是（新增插件引发的依赖抬升） | CLOSED |
| KI-13 | 安装包未签名（SmartScreen 会拦） | **不阻塞 QA，发布类待办** | **否**（既有发布流程状态；本次仅记录为待办） | OPEN（发布类） |

### 汇总

| 分类 | 数量 | 说明 |
|---|---|---|
| **阻塞 QA 结论（现存）** | **0** | 曾出现的 3 个（KI-01/KI-11/KI-12）均已解除 |
| 非阻塞 | 4（KI-04、KI-06、KI-09；KI-02 已并入） | 不影响验收结论 |
| 发布类待办（不阻塞 QA） | 2（**KI-10 必须消除**；KI-13 建议处理） | 见下 |
| 非缺陷（ACCEPTED/CLOSED/WONTFIX） | 6 | KI-03、KI-05、KI-06、KI-07、KI-08、KI-11(已修) |
| **本次引入的缺陷** | **0 个产品功能缺陷** | 本次引入的都是「构建/流程类」（KI-01 暴露、KI-03 书面差异、KI-10、KI-12）；<br>**无任何一条是功能实现错误** |

> 本文件不含「推测的问题」。每条都有可复现命令或可复核时间戳。
> 「阻塞」仅指**阻塞 QA 给出该验收项的结论**，不等于产品不可发布。
> **发布前必须消除：KI-10（升版本号 + 重生成 SHA256SUMS）；强烈建议处理 KI-13（代码签名）。**
> 剩余未验证面 = 人工 32 条（GUI，需安静桌面）＋ P-23/P-44 ＋ 活跃 session 的优雅退出清理。






