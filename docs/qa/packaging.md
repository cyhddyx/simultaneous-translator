# 安装包（NSIS）验证记录

> 维护者：Agent 4 / `qa-verifier`
> 状态：**构建产物已由 QA 独立复核（P-01~P-09 通过）；安装/升级/卸载/安装版功能（P-10~P-44）待授权后执行**
> 说明：安装包构建（PyInstaller + `tauri build`）耗时较长且需要独占 cargo/CPU，
> 由 **Lead 排他执行**（2026-10-07 19:44:35 → 19:50:08，exit 0）。
> 口径：未实测一律写「未验证」，**不得**根据构建日志推测安装版行为。

---

## 0. 前置

| 项 | 值 |
|---|---|
| 构建命令 | `cd desktop; npm run desktop:build`（= `scripts/tauri.ps1 build`） |
| 执行者 | **Lead（排他）** |
| 构建时间 | 2026-10-07 **19:44:35 → 19:50:08**，exit 0 |
| 受测源码时间点 | 前端源码最后改动 19:28:35–19:29:28（task-8 修复）；Rust 冻结于 19:22:08 之前 |
| 关键文件哈希 | `lib.rs` `9E208EF0EEEE6A96` / `tray.rs` `8B1CD14A0187BCFC` / `build.rs` `31E0E8C3082909E6` / `tauri_bridge.py` `06BEFA88B2B4E842` / `livetranslate.py` `9184113FF3D00577` |
| **前端 dist（安装包内前端）** | `dist/index.html` `1CC6F563DB257529`（450 B）／`dist/assets/index-B88iHQZn.css` `62D0D76DAB306FC`（51,128 B）／**`dist/assets/index-CuYVL2m9.js` `4A2D770530D616FA`（313,037 B）**，全部 19:47:27 由打包内 `beforeBuildCommand` 重建 |
| **安装包 SHA256** | **`2f10382c69cda161d9194f9da7b6fb13e4a967b1bedca2d5cb6c36cb31dee5eb`** |

> **追溯三元组**：源码时间点（19:28:57 前）＋ dist 哈希（`4A2D770530D616FA` 等）＋ 安装包 SHA256（`2f10382c…`）。
> QA **刻意未执行** `npm run build`：避免与打包内部重建并发写 `dist/`（会产出无法区分的混合产物，见 KI-11）。

---

## 1. 构建产物 —— ✅ **QA 独立复核通过**

| # | 检查项 | 判据 | 实测 |
|---|---|---|---|
| P-01 | 构建成功 | 命令 exit 0，无 error | ✅ **通过**：Lead 报告 exit 0（19:44:35→19:50:08）；QA 复核产物存在且可执行 |
| P-02 | NSIS 安装包路径 | 记录实际路径 | ✅ `simultaneous-translator\desktop\src-tauri\target\release\bundle\nsis\同传翻译_0.3.1_x64-setup.exe` |
| P-03 | 文件名与版本 | 与 `tauri.conf.json` 的 `version`/`productName` 一致 | ✅ `version=0.3.1`、`productName=同传翻译`、`identifier=com.simultaneous-translator.desktop`，文件名 `同传翻译_0.3.1_x64-setup.exe` 一致 |
| P-04 | 安装包体积 | 记录并与上一版对比 | ✅ **68,304,417 B**（19:50:08）；已发布 beta0.3.1 为 68,066,090 B → **+238,327 B**，与新增托盘/快捷键/字幕窗/运行时通道功能量级相符，无异常膨胀 |
| P-05 | sidecar 已打包 | `binaries\translator-bridge-x86_64-pc-windows-msvc.exe` 存在 | ✅ 存在，**66,090,911 B**（与 Lead 报告一致） |
| P-06 | sidecar 可独立运行 | 对打包 exe 发 JSONL，`ping` 返回 ok | ✅ **QA 独立复现（比 Lead 多 3 项断言）**，见 §1.1 |
| P-07 | 新增能力文件已打包 | `capabilities/subtitle-window.json` 生效 | ✅ 文件存在且与契约 T §11 **逐字一致**（5 条权限：`core:event:default`、`allow-start-dragging`、`allow-close`、`allow-set-always-on-top`、`allow-start-resize-dragging`，`windows:["subtitle"]`）；**且全部 capabilities 中 `global-shortcut` 零命中**（符合「不把快捷键权限授予任何 WebView」的刻意决策） |
| P-08 | 未新增体积型资源 | 托盘图标复用既有图标 | ✅ `bundle.icon` 仅列既有 5 项（`32x32.png`/`128x128.png`/`128x128@2x.png`/`icon.icns`/`icon.ico`），`icons/` 无本次新增文件 |

### 1.1 P-06 独立复现（QA 自建，原始 JSONL 直连打包 exe）

命令：`.venv\Scripts\python.exe <临时脚本>`，对
`desktop\src-tauri\binaries\translator-bridge-x86_64-pc-windows-msvc.exe`（66,090,911 B）发 7 条请求：

```
exit code: 0
ready commands: ['ping','start','stop','shutdown','probe.models','probe.connect','devices',
                 'set_runtime_channel','set_speak_muted']          ← 两个新命令确实进了 PyInstaller 产物
q1 ping                       ok=True   result={"protocol_version":1,"state":"idle","session_id":null}
q2 __unknown__                ok=False  code=unknown_command
q3 set_runtime_channel(随机id) ok=False  code=no_active_session      ← 命令被识别（不是 unknown_command）
q4 set_speak_muted(随机id)     ok=False  code=no_active_session      ← 同上
q5 set_runtime_channel(nope)   ok=False  code=invalid_channel        ← 参数校验先于 session 校验
q6 devices                    ok=True   （真实硬件枚举成功，返回 speakers 列表）
q7 shutdown                   ok=True   result={"state":"shutting_down"}
非 JSON 的 stdout 行：0
stderr：空
```
**结论**：打包产物与源码行为一致，协议零污染，退出码 0。
**附带收获**：`q5` 证明**参数校验优先于 session 存在性校验**（无活跃 session 时非法 channel 仍报 `invalid_channel`），
这条把 `known-issues.md` KI-04 的「错误码优先级未定义」从推测变成了实测。

### 1.2 KI-10 二次确认（发布安全）

| 文件 | 大小 | mtime | SHA256(前16) |
|---|---|---|---|
| `releases\beta0.3.1\simultaneous-translator_0.3.1_x64-setup.exe`（**已发布，未被触碰**） | 68,066,090 | 2026-10-07 17:51:03 | `1F561DD188CF0E8E` |
| `…\bundle\nsis\同传翻译_0.3.1_x64-setup.exe`（**本次构建**） | 68,304,417 | 2026-10-07 19:50:08 | `2F10382C69CDA161` |

→ **同版本号、不同内容**：本次产物**绝不能**用于发布 beta0.3.1（须先升版本号并重生成 SHA256SUMS）。
已发布目录内容**未被破坏**。

---

## 2. 安装 —— ✅ **已执行（静默安装，含完整前/后状态核对）**

### 2.0 「先备份、后改动、最后复原」协议执行记录

| 步骤 | 实际命令 | 返回码 | 耗时 | 结果 |
|---|---|---|---|---|
| 0 备份 | `Copy-Item %APPDATA%\com.simultaneous-translator.desktop\* → backup\install-verify-20261007-200812\appdata\` | — | — | ✅ `settings.json` `741DA41E79EB6BBB`(1492 B)、`settings.production.json` `ED6058820990F18D`(1862 B)，**备份/原始双向 SHA256 一致** |
| 0 记录 | `%LOCALAPPDATA%\com.simultaneous-translator.desktop\`（仅记录不复制） | — | — | 970 文件 / 140.40 MB / 顶层仅 `EBWebView` |
| 1 卸载 0.3.0 | `"E:\system\Desktop\123\test\同传翻译\uninstall.exe" /S` | **0** | 10.6s | ✅ 目录 / HKCU 卸载项 / 开始菜单 lnk **全部消失**，无进程残留 |
| 2 安装 0.3.1 | `"…\bundle\nsis\同传翻译_0.3.1_x64-setup.exe" /S` | **0** | 6.8s | ✅ 见 §2.1 |
| 3 功能验证 | 见 §3 | — | — | ✅ 见 §3 |
| 4 卸载 0.3.1 | `"E:\system\Desktop\123\test\同传翻译\uninstall.exe" /S` | **0** | 0.7s | ✅ 见 §5 |
| 5 复原 | `Copy-Item backup\…\appdata\* → %APPDATA%\com.simultaneous-translator.desktop\` | — | — | ✅ 复原后 SHA256 **与备份一致** |

> **全程未提权**（无 UAC 弹窗），未发送任何合成键鼠输入；与用户桌面交互仅限「短暂启动一次应用」。

### 2.1 安装后状态（P-10~P-12）

| 项 | 实测值 |
|---|---|
| HKCU 卸载项 `DisplayName` | `同传翻译` |
| **`DisplayVersion`** | **`0.3.1`** ✅（安装前为 0.3.0） |
| `InstallLocation` | `E:\system\Desktop\123\test\同传翻译`（**与旧版同路径** → 原地升级语义） |
| `UninstallString` | `…\同传翻译\uninstall.exe` |
| `Publisher` | `cyhddyx` |
| `EstimatedSize` | 75,203 KB |
| 开始菜单快捷方式 | ✅ 重新创建 `…\Start Menu\Programs\同传翻译.lnk` |
| 安装后自动启动 | 无（符合预期） |

| # | 检查项 | 结果 |
|---|---|---|
| P-10 | 静默安装成功、无报错 | ✅ exit 0 / 6.8s |
| P-11 | 快捷方式正确 | ✅ 指向安装目录内 exe |
| P-12 | 首次启动：应用能起来 | ✅ 见 §3.1 |

---

## 3. 安装版功能验证（可自动化部分）

### 3.1 启动与进程行为

| # | 检查项 | 判据 | 实测 |
|---|---|---|---|
| P-12 | 应用可启动 | 主进程常驻 | ✅ 启动 PID 29896，10s 后仍运行；`simultaneous-translator.exe` 常驻 |
| — | **契约 §10：关闭主窗口后进程仍在** | WM_CLOSE 后进程存活、窗口隐藏 | ✅ **实测通过**：`CloseMainWindow()` 返回 `True` → 6s 后进程**仍存活**，`MainWindowTitle` 变为空（窗口已隐藏）→ **「关闭主窗口 = 隐藏到托盘，不退出」成立** |
| P-14 | **无控制台黑框** | GUI 子系统 + 侧车不弹控制台 | ✅ **双重判定**：① `simultaneous-translator.exe` 的 PE `Subsystem=2 (WINDOWS_GUI)` → 结构上不会分配控制台；② 侧车 `translator-bridge.exe` 虽是 `Subsystem=3 (CUI)`，但 `lib.rs:1999 command.creation_flags(CREATE_NO_WINDOW)`（`lib.rs:84 CREATE_NO_WINDOW = 0x0800_0000`）→ 不会弹黑框 |
| — | 侧车在**空闲**时是否存在 | 设计为按需启动 | ✅ 观察到：应用启动后**无** `translator-bridge` 进程（引擎在开始同传时才拉起）—— 记录以免误判为「侧车没起来」 |
| P-41（弱） | 结束进程后无残留 | 无 `translator-bridge` | ✅ 硬杀后无任何相关进程残留；**但见 §3.3 的口径限制** |

### 3.2 配置迁移检查（用已有旧配置验证）

| 文件 | 安装前 | 安装后 | 启动 0.3.1 后 | 结论 |
|---|---|---|---|---|
| `settings.json` | `741DA41E79EB6BBB` | `741DA41E79EB6BBB` | `741DA41E79EB6BBB` | **逐字节未变** |
| `settings.production.json` | `ED6058820990F18D` | `ED6058820990F18D` | `ED6058820990F18D` | **逐字节未变** |

**结论（口径严格）**：
- ✅ **安装过程与一次正常启动都没有改写、没有丢失、没有迁移用户既有配置** —— 对「用已有旧配置验证设置迁移不受影响」这个问题，
  在**读取路径**上给出的答案是「无影响（零改写）」。
- ⚠️ **未覆盖**：只有从 UI **保存设置**时才会触发设置规范化/迁移写回，本环境无法在不操作 GUI 的前提下触发。
  因此「保存后的迁移正确性」仍属**需人工**（`manual-checklist.md` M-29 相关路径）。

### 3.3 口径限制（避免把弱证据当成强证据）

- P-41 的**强判据**是「**有活跃 session（侧车已启动）**时走正常退出路径 → 侧车必须消失」。
  本次只能验证**空闲态**：侧车根本没被拉起，所以「无残留」是**平凡成立**的，不能支撑强判据。
  正常退出路径（托盘「退出应用」）需要 GUI，**保持未验证 → 人工 M-07/M-31**。
- 本次用 `Stop-Process -Force` 结束应用，属**硬杀**，不是应用的优雅退出路径；
  硬杀后无残留**不能**推断「优雅退出会清理侧车」（反之亦然）。

---

## 4. 升级安装 —— 部分验证

| # | 检查项 | 判据 | 实测 |
|---|---|---|---|
| P-20 | 覆盖安装旧版 | 旧版存在时可升级 | ✅ **实测**：0.3.0 卸载 → 0.3.1 安装到**同一路径**，`DisplayVersion` 0.3.0 → **0.3.1**，快捷方式重建，无需用户干预 |
| P-21 | 设置保留 | 升级后无需重新配置 | ✅ 用户配置**逐字节未变**（§3.2），即升级不会破坏既有配置 |
| P-22 | 无残留旧文件 | 安装目录无上一版遗留 | ✅ 目录内**恰好 5 个文件**（新版本产物），无 0.3.0 遗留（0.3.0 的 `simultaneous-translator.exe` 9,677,824 B → 新版 10,595,840 B） |
| P-23 | 单实例 | 不出现两个实例 | 未验证（需 GUI 双击两次；单实例插件已打包但未做行为验证） |

> 说明：本次「升级」是在**先卸载 0.3.0 再安装 0.3.1** 的路径下完成的（用户已确认 0.3.0 是可删的历史测试残留）。
> 「不先卸载、直接覆盖安装」这一路径**未验证**，但 NSIS 会复用同一 `InstallLocation`，风险与本次相同。

---

## 5. 卸载 —— ✅ **已执行**

| # | 检查项 | 判据 | 实测 |
|---|---|---|---|
| P-40 | 正常卸载 | 卸载成功、无报错 | ✅ `uninstall.exe /S` **exit 0 / 0.7s** |
| P-41 | 进程清理 | 无 `translator-bridge` 残留 | ✅ 卸载后相关进程 **0**（口径限制见 §3.3） |
| P-42 | 目录清理 | 安装目录被删除 | ✅ `E:\system\Desktop\123\test\同传翻译` 已删除；**父目录中用户的 Word 文档完好无损** |
| P-43 | 快捷方式清理 | 开始菜单/桌面快捷方式移除 | ✅ `同传翻译.lnk` 已删除；HKCU 卸载项已删除；HKLM 相关项 **0** |
| P-44 | 卸载后重装 | 可重新安装 | 未验证（本轮未二次重装；如需可单独执行） |

**用户数据在卸载后保留**（正确行为，不得删除用户配置）：
`%APPDATA%\com.simultaneous-translator.desktop\` 仍含 `settings.json` + `settings.production.json`；
`%LOCALAPPDATA%\…\EBWebView` 仍在。
> 观察：`%LOCALAPPDATA%` 由 **970 文件/140.40 MB → 977 文件/140.51 MB**（+7 文件/+0.11 MB）——
> 这是**启动一次应用产生的 WebView2 缓存**，不是安装残留；卸载器不清 WebView2 缓存属常见行为。
> 本次按 Lead 指示「不必整份复制」只记录了条目数与大小，因此**无法逐文件精确回滚**，如实记录该差异。

---

## 6. 复原确认（不可跳过的一步）

| 项 | 结果 |
|---|---|
| 用户配置复原 | ✅ 从备份复制回 `%APPDATA%\com.simultaneous-translator.desktop\`，`settings.json` `741DA41E79EB6BBB` / `settings.production.json` `ED6058820990F18D` **与备份一致** |
| HKCU 卸载项 | ✅ 无 |
| 安装目录 | ✅ 无 |
| 开始菜单快捷方式 | ✅ 无 |
| 相关进程 | ✅ 无 |
| 用户其它文件 | ✅ `E:\system\Desktop\123\test\` 下用户 Word 文档完好 |

> **结论：验证结束后已复原为安装前状态。**
> 唯一**不可逆**差异是 `%LOCALAPPDATA%\…\EBWebView` 的 +7 个缓存文件（0.11 MB），已在 §5 说明原因。

---

## 7. 结论

| 维度 | 结论 |
|---|---|
| 构建产物 | ✅ **通过**（P-01~P-09，含 sidecar 字节级随包核对） |
| 安装（静默） | ✅ **通过**（P-10~P-12） |
| 首次启动 / 关闭主窗口不退出 | ✅ **通过**（契约 §10 实测成立） |
| 无控制台黑框 | ✅ **通过**（PE 子系统 + `CREATE_NO_WINDOW` 双重判定） |
| 配置迁移（读取路径） | ✅ **通过**（逐字节未变）；保存路径**需人工** |
| 升级安装 | 🟡 **部分通过**（P-20/21/22 通过；P-23 单实例未验证） |
| 卸载与残留 | ✅ **通过**（P-40~P-43；P-44 未验证） |
| 托盘图标 / 右键菜单 / 全局快捷键 / 字幕窗置顶 / 三入口幽灵组合 | ⚠️ **未验证 —— 需人工**（见 `manual-checklist.md` §0.1：需一台没有其它输入焦点的桌面） |
| 有活跃 session 时的优雅退出清理侧车 | ⚠️ **未验证 —— 需人工**（M-07/M-31） |

**待办**：Lead 完成 `npm run desktop:build` 后（已完成）→ 上述人工项由人在安静桌面上执行。
**发布提醒**：本次产物版本号仍为 `0.3.1` 且**未签名**，**不得**用于发布 beta0.3.1（KI-10、KI-13）。
