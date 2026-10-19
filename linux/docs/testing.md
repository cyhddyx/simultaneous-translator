# Linux 测试指南

> Owner：build-verify。适用 Linux 版 1.0.2。
> 相关文档：[`build.md`](build.md)、[`../packaging/README.md`](../packaging/README.md)、
> [`qa/test-matrix.md`](qa/test-matrix.md)（矩阵与覆盖映射）、[`qa/manual-checklist.md`](qa/manual-checklist.md)（人工验收）。
> 本机验证流水线的实际命令/退出码/关键输出记录在 `artifacts/logs/linux-verification.md`。

---

## 1. 测试分层

| 层级 | 命令（工作目录） | 覆盖对象 | 需要 |
| --- | --- | --- | --- |
| L1 Python 单测 | `cd linux; $VENV/bin/python scripts/test_*.py` | JSONL 协议、通道状态机、pactl/parec 命令构造、错误映射、音频设备测试逻辑 | 仅 Python |
| L2 PulseAudio 集成 | `cd linux; $PULSE_SERVER=... $VENV/bin/python scripts/test_*integration*.py` 或带集成开关的用例 | 真实 `pactl`/`parec`：模块加载/卸载、默认 sink 恢复、采集帧 | PulseAudio/PipeWire 服务 |
| L3 前端构建 | `cd linux/desktop; npm run build` | TypeScript 类型 + Vite 生产构建 | Node + node_modules |
| L4 前端单测 | `cd linux/desktop; node --experimental-strip-types --test tests/*.test.mjs` | 纯函数、mock 控制器（运行时状态、字幕窗、历史、语言表、Linux 文案） | Node |
| L5 Rust 单测/构建 | `cd linux/desktop/src-tauri; CARGO_TARGET_DIR=... cargo build`（`cargo test` 可选） | Rust 命令层、更新资产匹配、pactl 命令构造 | Rust 工具链 + 系统库 |
| L6 打包验证 | `bash packaging/verify-deb.sh <deb>` / `verify-rpm.sh <rpm>` | 包结构、依赖声明、desktop/图标、sidecar 启动自检 | 构建产物 |
| L7 冒烟 | `timeout 15 xvfb-run -a dbus-run-session -- <主程序>` | 打包后主程序能否启动、不崩溃、能读设置 | Xvfb + dbus + WebKit |
| L8 安装冒烟 | `dpkg -i <deb>` → L7 → `dpkg -r` | 安装/卸载集成、`/usr/bin` 布局 | root（WSL 可用） |
| L9 人工验收 | [`qa/manual-checklist.md`](qa/manual-checklist.md) | 托盘/快捷键/置顶/真实音频路由/会议软件虚拟麦克风 | 真实 Linux 桌面 |

> 口径：**通过 / 失败 / 跳过 / 未验证**。未执行的项一律写「未验证」，不得按推测写「通过」。
> 自动化的 L1–L8 由 build-verify 在 WSL 执行；L9 必须由能操作真实桌面的验收人执行。

---

## 2. 环境准备

```bash
# WSL 参考环境
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
VENV=/home/cyh26/venvs/translation-linux
export CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build
cd /mnt/e/Project/translation/linux
```

- Python 依赖：`bash scripts/install.sh`（或使用已有 venv）。
- 前端依赖：`cd desktop && npm install`。
- 系统依赖：见 [`build.md`](build.md) §2。
- 无音频服务时 L2 必须 **skip**，不得伪装通过；无 `$DISPLAY` 时 L7 用 `xvfb-run`。

---

## 3. 各层命令与判据

### 3.1 L1 Python 单测

```bash
cd /mnt/e/Project/translation/linux
$VENV/bin/python scripts/test_tauri_bridge.py
$VENV/bin/python scripts/test_runtime_channels.py
$VENV/bin/python scripts/test_realtime_reconnect.py
$VENV/bin/python scripts/test_audio_isolation.py
$VENV/bin/python scripts/test_audio_device_tests.py
$VENV/bin/python scripts/test_runtime_integration.py
# 新增的 Linux 音频模块测试（pactl 命令构造/帧解码/清理顺序），文件名以 scripts/ 下实际存在的为准：
for f in scripts/test_*.py; do $VENV/bin/python "$f" || echo "FAILED: $f"; done
```

判据：每条命令退出码 0；输出中的 `Ran N tests` / `OK` 记录到验证日志。测试使用 `unittest`
（无 pytest 也可运行）。

### 3.2 L2 PulseAudio 集成测试

```bash
cd /mnt/e/Project/translation/linux
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# 集成用例（按实现命名，通常含 integration / pulse 关键字或环境变量开关）
$VENV/bin/python -m unittest discover -s scripts -p 'test_*integration*.py' -v
# 或指定文件（以 scripts/ 下实际文件为准）
```

判据与隔离规则（**强制**）：

1. 用例创建的模块名必须带 `tt_test_` 前缀（例如 `tt_test_translator_mix`）；
2. 结束时（含异常路径）必须卸载自己加载的模块，并断言 `pactl list short modules` 无 `tt_test_` 残留；
3. 必须记录并恢复 `pactl get-default-sink`；
4. 不允许改动 `default.pa` / `~/.config/pulse/*.pa` 等持久配置；
5. 不允许并发跑多个 PulseAudio 集成测试。

无可用 `$PULSE_SERVER`（或 `pactl info` 失败）时：**skip 并记录原因**，不得判为通过。

### 3.3 L3/L4 前端

```bash
cd /mnt/e/Project/translation/linux/desktop
npm run build
node --experimental-strip-types --test tests/*.test.mjs
# 或按 package.json 的 test:* 分组
npm run test:audio && npm run test:devices && npm run test:languages && \
npm run test:runtime && npm run test:subtitle && npm run test:history
```

判据：`npm run build` 退出码 0（tsc 无错误、vite 产出 `dist/`）；Node 测试全部 pass、0 fail。

> 打包内部会再次执行 `beforeBuildCommand`（`npm run build`）。最终打包前后不要并发跑前端构建，
> 以免 `dist/` 混杂（见 [`qa/known-issues.md`](qa/known-issues.md)）。

### 3.4 L5 Rust

```bash
cd /mnt/e/Project/translation/linux/desktop/src-tauri
CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build cargo build
# 可选：单元测试（需要系统库；Linux 下没有 Windows 的 Common-Controls 清单问题）
CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build cargo test
```

判据：`cargo build` 退出码 0，无 Windows-only crate 残留（`grep -n 'wasapi\|windows-sys' Cargo.toml` 应为空）；
`cargo test` 若有 ignored 项需在日志中说明原因。

### 3.5 L6 打包验证

见 [`../packaging/README.md`](../packaging/README.md) §5：

```bash
bash packaging/verify-deb.sh desktop/src-tauri/target/release/bundle/deb/*.deb
bash packaging/verify-rpm.sh  desktop/src-tauri/target/release/bundle/rpm/*.rpm
```

判据：`FAIL=0`；允许 SKIP（例如宿主非 x86_64 时跳过 sidecar 自检）。

### 3.6 L7/L8 冒烟与安装冒烟

```bash
# L7：直接运行构建产物（未安装）
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
timeout 15 xvfb-run -a dbus-run-session -- \
  desktop/src-tauri/target/release/simultaneous-translator \
  >artifacts/logs/linux-smoke.log 2>&1
echo "exit=$?"    # 124 = 15s 后仍存活（通过）；0/1/其他 = 自行退出（失败，看日志）

# L8：安装后运行（需要 root；WSL 可用）
sudo dpkg -i desktop/src-tauri/target/release/bundle/deb/*.deb
timeout 15 xvfb-run -a dbus-run-session -- simultaneous-translator \
  >artifacts/logs/linux-smoke-installed.log 2>&1
echo "exit=$?"
sudo dpkg -r simultaneous-translator
```

判据：
- 退出码 **124** = 进程在超时内未退出 → **启动冒烟通过**（不是失败）；
- 退出码 0 = 进程自行正常退出（异常，记录日志）；
- 退出码 1/其他 = 启动失败，保留 stderr 并定位（缺库/WebKit/显示/密钥环等）。

> 无 GPU 的 WSL/Xvfb 下如遇 WebKit 合成问题，可加
> `WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1` 重试，并在日志中注明。

### 3.7 L9 人工验收

按 [`qa/manual-checklist.md`](qa/manual-checklist.md) 执行并填写结果表。重点：
- 托盘（需 AppIndicator 宿主）、全局快捷键（X11/Wayland 差异）、字幕窗置顶与拖拽；
- 真实音频：系统声音隔离采集（本软件译文不被回采）、回环模式、虚拟麦克风在会议软件里可见；
- API Key（Secret Service）、设置持久化、会话历史导出（XDG Portal 保存对话框）；
- deb/rpm 安装、升级、卸载、无残留进程；更新检查/下载/校验。

---

## 4. 跳过条件与限制

| 情况 | 处理 |
| --- | --- |
| `pactl info` 失败 / 无 `$PULSE_SERVER` | L2 集成测试 skip，记录「跳过原因：无 PulseAudio 服务」 |
| 无 `$DISPLAY` 且无 `xvfb-run` | L7 无法执行（建议装 `xvfb`） |
| 无 Secret Service（headless WSL 常见） | 凭据相关用例 skip 或走环境变量通道；产品会给出明确错误 |
| 无 AppIndicator 宿主 | 托盘自动化/人工项标记「跳过（无宿主）」；产品降级为关闭窗口即退出 |
| Wayland 会话 | 快捷键/置顶项标记「受合成器限制」，按 X11 会话结果为准 |
| 无 GPU / 软件渲染 | WebKit 可能需 `WEBKIT_DISABLE_COMPOSITING_MODE=1`；记录环境差异 |
| 交叉架构 | `verify-*.sh --no-sidecar-run` 跳过 sidecar 自检 |

**不得**把 skip 记成 pass；**不得**用「开发模式能跑」代替「安装包验证通过」。

---

## 5. 结果记录

所有验证命令与输出写入 `artifacts/logs/linux-verification.md`，格式：

```markdown
## <序号> <步骤名>
- 命令: `...`
- 工作目录: `...`
- 退出码: 0
- 关键输出: （贴 3–10 行摘要）
- 结论: 通过 / 失败 / 跳过（原因）
- 产物: 路径 + 大小 + SHA256（如适用）
```

矩阵状态同步更新到 [`qa/test-matrix.md`](qa/test-matrix.md) 与 [`qa/packaging.md`](qa/packaging.md)。
失败项按 scope 通知对应 owner（Python→engine-port、Rust→rust-port、前端→ui-port），修复后**重跑全链路**。

---

## 6. 一键执行顺序（build-verify 用）

```bash
# 0) 前置检查
wsl.exe -d Ubuntu-24.04 -- bash -lc 'bash /mnt/e/Project/translation/artifacts/logs/linux-probe-env.sh'

# 1) Python（engine-port 完成后）
# 2) 前端（ui-port 完成后）
# 3) Rust build（rust-port 完成后）
# 4) sidecar
# 5) deb → verify-deb.sh；rpm → verify-rpm.sh
# 6) 冒烟 + 安装冒烟
# 7) 归档 releases/linux/v1.0.2 + SHA256SUMS.txt
```

> L1–L5 谁改代码谁先自测；build-verify 在最终构建前**全量重跑**，以最终源码为准。
