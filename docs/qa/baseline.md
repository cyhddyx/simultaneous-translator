# 改动前基线（QA 实测记录）

> 记录者：Agent 4 / `qa-verifier`
> 采集时刻：2026-10-07 19:01–19:03 (+08:00)
> 目的：在 Rust / Python / 前端三个实现 agent 提交改动**之前**固定一份可复现的绿色基线，
> 以便后续判断「新增改动导致的回归」而不是「本来就红」。

---

## 1. 基线标识

| 项 | 值 |
|---|---|
| 仓库 | `E:\Project\translation\simultaneous-translator` |
| 分支 | `main` |
| commit | `56348ee391efa01d4792392ff56672c0e460fbe1`（`Document the source build order and the missing engine sidecar`） |
| 采集时 `git status`（受测路径） | **干净**：仅 `docs/` 下三个新契约文件为 untracked（`tray-shortcuts-contract.md`、`subtitle-window.md`、`runtime-channel-control.md`），`desktop/src-tauri`、`scripts/`、`desktop/src/` 均无改动 |
| 采集前后 `git status --porcelain -- desktop/src-tauri` | 开始前为空，结束后为空（本次 cargo 运行期间无人改动 Rust 源码） |

关键文件 SHA256（前 16 位）：

| 文件 | 大小 (B) | SHA256 前 16 位 |
|---|---|---|
| `scripts/tauri_bridge.py` | 77160 | `C79EEF3940C1F28F` |
| `scripts/livetranslate.py` | 43428 | `73817E2482EC258D` |
| `desktop/src-tauri/src/lib.rs` | 114856 | `2D03B900E0E2666A` |

> 这三个哈希是「基线 = 未改动版本」的证据。复验时若哈希变化，说明对应模块已被实现 agent 改动。

## 2. 工具链

| 工具 | 版本 |
|---|---|
| rustc | 1.98.0 (88d9e12ae 2026-08-18) |
| cargo | 1.98.0 (797e8a9bc 2026-08-05) |
| node | v24.18.0 |
| npm | 11.16.0 |
| python（`.venv`） | 3.14.2 |

## 3. 基线结果（全部为**实测**）

### 3.1 Rust

命令：`cd desktop\src-tauri; cargo test`

```
running 30 tests
test result: ok. 29 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.36s
```

- 通过：**29**
- 失败：**0**
- ignored：**1** — `virtual_microphone::tests::prepare_official_installer_without_installing`（需要下载官方驱动包，基线即被 ignore，属既有状态）
- 另有 `src\main.rs`、`src\bin\translator-audio-capture.rs`、doc-tests 各 0 test。
- 编译告警 1 条：`#[warn(linker_messages)]`（linker stdout 提示，来自 Windows 链接器，非代码问题）。
- 首轮编译耗时 32.30s（`target/` 已预热）。

> 注：Lead 交接信息里写「现 28 个 `#[test]`」，实测为 **30 个 test 函数**（29 pass + 1 ignored）。以实测为准。

### 3.2 Python（本机无 pytest，脚本直接当 unittest 跑）

```powershell
cd E:\Project\translation\simultaneous-translator
.venv\Scripts\python.exe scripts\test_tauri_bridge.py   # Ran 70 tests ... OK   (exit 0)
.venv\Scripts\python.exe scripts\test_audio_isolation.py # Ran 11 tests ... OK   (exit 0)
```

| 文件 | 用例数 | 结果 | 耗时 |
|---|---|---|---|
| `scripts/test_tauri_bridge.py` | 70 | **OK** (exit 0) | 0.380s |
| `scripts/test_audio_isolation.py` | 11 | **OK** (exit 0) | 0.347s |
| `scripts/test_runtime_channels.py` | — | **不存在**（应由 Agent 2 新建） | — |

`test_tauri_bridge.py` 基线用例类：`RealtimeEngineTests`、`RedactionTests`、`RuntimeConfigTests`、`SessionIsolationTests`、`UrlValidationTests`（末尾 20 条实测输出可见，全部 `ok`）。

### 3.3 前端

命令：`cd desktop; npm run build`（= `tsc -b && vite build`）

```
vite v8.2.2 building client environment for production...
✓ 1836 modules transformed.
dist/index.html                   0.45 kB │ gzip:  0.30 kB
dist/assets/index-tBhw7If1.css   42.00 kB │ gzip:  8.78 kB
dist/assets/index-BtKDKfX6.js   286.61 kB │ gzip: 89.17 kB
✓ built in 976ms
```

结果：**exit 0**，`tsc -b` 无类型错误，`vite build` 成功。

| 命令 | 用例数 | 结果 |
|---|---|---|
| `npm run test:audio` | 5 | **pass 5 / fail 0**（exit 0，394ms） |
| `npm run test:languages` | 4 | **pass 4 / fail 0**（exit 0，371ms） |

前端仅有 2 个 node 测试文件：`desktop/tests/virtual-microphone.test.mjs`、`desktop/tests/translation-languages.test.mjs`。

## 4. 基线结论

- 改动前三层**全绿**：Rust 29 pass / Python 81 pass（70+11）/ 前端 build + 9 node 用例 pass。
- 因此本次迭代后任何失败都可归因于新改动（除非失败项落在上面已声明的 `ignored` 用例上）。
- `scripts/test_runtime_channels.py` 在基线时**不存在**，其创建本身就是本次交付物之一。

## 5. 未验证 / 限制

- 本基线**未**包含安装包（NSIS）构建与安装版运行验证，按 task-4 要求需 Lead 明确授权后再执行。
- 本基线**未**包含任何 GUI / 托盘 / 快捷键的人工或自动化 UI 验证（改动前这些功能尚不存在）。
- 基线为「当时环境」快照：Windows 音频设备、网络可达性、密钥配置均未固定，涉及真实设备的用例不在本基线范围内。
- 采集期间其他 agent 已在并行编辑，但上面记录的三处关键路径在采集窗口内 `git status` 为空，故基线数值可信。
