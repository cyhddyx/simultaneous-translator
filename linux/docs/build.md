# Linux 构建指南

> Owner：build-verify。适用 Linux 版 1.0.2。
> 相关文档：[`../packaging/README.md`](../packaging/README.md)（打包）、[`release.md`](release.md)（发布）、[`testing.md`](testing.md)（测试）。

---

## 1. 参考验证环境（本仓库实测）

| 项目 | 值 |
| --- | --- |
| 发行版 | Ubuntu 24.04.3 LTS（WSL2 内核 6.6，x86_64） |
| 系统库 | webkit2gtk-4.1 2.52.6、gtk+-3.0 3.24.41、librsvg 2.58.0、ayatana-appindicator3 0.5.90、libpulse 16.1 |
| Rust | rustup stable 1.99.1（`/home/cyh26/.cargo/bin`） |
| Node | v24.14.0（nvm），npm 11.9.0，registry = npmmirror |
| Python | 3.12.3，venv `/home/cyh26/venvs/translation-linux`；PyInstaller 6.22.3 |
| 音频 | WSLg PulseAudio：`PULSE_SERVER=unix:/mnt/wslg/PulseServer`，默认 sink `RDPSink`，支持 null-sink/loopback/remap-source/parec |
| 编译缓存 | `CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build`（ext4；**不要**用 `/mnt/e` 下的 9p 路径） |

非 WSL 的物理 Linux 桌面同样适用；把上面「WSLg PulseAudio」换成桌面自带的 PulseAudio/PipeWire 即可。

---

## 2. 前置依赖

### 2.1 系统包（Debian/Ubuntu）

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential curl wget file git \
  libwebkit2gtk-4.1-dev librsvg2-dev patchelf \
  libgtk-3-dev libayatana-appindicator3-dev libxdo-dev \
  libpulse-dev pulseaudio-utils \
  dpkg-dev fakeroot rpm cpio \
  fonts-noto-cjk
```

### 2.2 Fedora / openSUSE（构建机）

```bash
sudo dnf install -y gcc gcc-c++ make curl wget file \
  webkit2gtk4.1-devel librsvg2-devel patchelf \
  gtk3-devel libappindicator-gtk3-devel libxdo-devel \
  pulseaudio-libs-devel pulseaudio-utils \
  rpm-build dpkg-dev fakeroot google-noto-sans-cjk-fonts
```

### 2.3 语言工具链

- **Rust**：rustup stable（`rustc >= 1.77` 即可，实测 1.99.1）。
- **Node.js >= 22.12**（含 npm）；`desktop/node_modules` 由 `npm install` 生成。
- **Python >= 3.10**（实测 3.12）：`scripts/install.sh` 会创建 `linux/.venv` 并安装
  `requirements.txt`；已有虚拟环境时可用 `TRANSLATOR_VENV` 或直接使用绝对解释器路径。

---

## 3. 快速开始

```bash
cd /mnt/e/Project/translation/linux        # 仓库根目录下的 linux/
bash scripts/install.sh                    # 1) 建 .venv + 安装 Python 依赖 + 检查 pactl/parec
cd desktop && npm install                  # 2) 前端依赖（首次；之后可跳过）
cd .. && bash scripts/dev.sh               # 3) 开发模式（Vite + Tauri dev）
```

完整构建（sidecar + 前端 + deb/rpm）：

```bash
cd /mnt/e/Project/translation/linux
bash scripts/build.sh
```

### 3.1 脚本约定

| 脚本 | 作用 | 备注 |
| --- | --- | --- |
| `scripts/install.sh` | 创建开发用虚拟环境、安装 `requirements.txt`、检查 `pactl`/`parec` | 可重复执行 |
| `scripts/build-sidecar.sh` | PyInstaller onefile → `desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu` | 打包前置，必须先跑 |
| `scripts/dev.sh` | 开发模式启动（先构建前端 dev server，再 `tauri dev`） | 需要 `desktop/node_modules` |
| `scripts/build.sh` | 完整构建：`build-sidecar.sh` + `npx tauri build --bundles deb,rpm` | 最终产物由 build-verify 执行 |

全部脚本：`#!/usr/bin/env bash` + `set -euo pipefail`，UTF-8/LF，可重复执行。

---

## 4. 开发模式

```bash
cd linux/desktop
npm run dev            # 仅前端 + mock 后端（浏览器 http://127.0.0.1:1420，不需要 Rust/音频）
npm run desktop:dev    # = bash ../scripts/dev.sh（Rust 主进程 + Python 引擎）
```

开发模式由 Rust 主进程启动 `scripts/tauri_bridge.py`（开发解释器优先级见 `lib.rs`；默认 `linux/.venv/bin/python`，
可用环境变量覆盖）。浏览器 mock 模式（`npm run dev`）保留，用于无音频服务的 UI 调试。

Rust 单独检查：

```bash
cd linux/desktop/src-tauri
CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build cargo check
```

---

## 5. 前端构建

```bash
cd linux/desktop
npm run build      # tsc -b && vite build → dist/
```

`dist/` 由 `tauri.conf.json` 的 `beforeBuildCommand` 在打包时自动重建；**不要**在打包进行中并发跑
`npm run build`（产物会混淆，见 `docs/qa/known-issues.md`）。

---

## 6. Python 引擎与 sidecar

```bash
cd linux
bash scripts/build-sidecar.sh
# 产物: desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu（PyInstaller onefile）
```

- PyInstaller 版本锁定 6.22.x；`--onefile`；
- 打包脚本会带上 `translation_languages.json` 与必要的 hidden-import（`dashscope`、`soundcard`、`websockets` 等）。
- 改动 `scripts/*.py` 后**必须**重跑 `build-sidecar.sh`，否则发行包里的引擎还是旧版。

手动验证 sidecar（无需 GUI）：

```bash
printf '%s\n%s\n' \
  '{"id":"ping-1","command":"ping","params":{}}' \
  '{"id":"shutdown-1","command":"shutdown","params":{}}' \
  | timeout 60 desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu
```

期望：先输出 `ready` 事件，再输出 `ping` 与 `shutdown` 的 `ok:true` 响应，退出码 0。

---

## 7. 完整打包

见 [`../packaging/README.md`](../packaging/README.md)。核心命令：

```bash
cd linux/desktop
export CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build
npx tauri build --bundles deb        # 先 deb
npx tauri build --bundles rpm        # 再 rpm
```

> **不要**手动单独跑 `cargo build` 后手工拼装安装包；始终以 `npx tauri build` 为准（含前端重建、
> externalBin 复制、desktop 模板替换、资源安装）。

---

## 8. 环境变量

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `PULSE_SERVER` | 指定 PulseAudio/PipeWire 服务（WSL/远程音频必需） | `unix:/mnt/wslg/PulseServer` |
| `CARGO_TARGET_DIR` | Rust 编译输出目录（建议 ext4） | `/home/cyh26/targets/tauri-build` |
| `TRANSLATOR_PYTHON` | 开发模式 / `build-sidecar.sh` 使用的 Python 解释器（覆盖 `linux/.venv`） | `/home/cyh26/venvs/translation-linux/bin/python` |
| `TRANSLATOR_VENV` | `install.sh` 使用的虚拟环境路径 | `/home/cyh26/venvs/translation-linux` |
| `TAURI_BUNDLES` | `build.sh` 的打包目标 | `deb,rpm`（默认）/ `appimage` |
| `DASHSCOPE_API_KEY` | 无 Secret Service 环境下的 API Key 备用通道（不写入设置文件/日志） | `sk-...` |
| `RUST_LOG` | Rust 侧日志级别（Tauri 默认 info） | `info` 或 `debug` |
| `WEBKIT_DISABLE_COMPOSITING_MODE` | 无 GPU / Xvfb 环境下规避 WebKit 合成问题 | `1` |
| `LIBGL_ALWAYS_SOFTWARE` | 无 GPU 时强制软件渲染 | `1` |

> 设置 schema 与凭据格式与 Windows 版兼容（v9 / `StoredSecretEnvelope` v2）；
> Linux 凭据后端为 Secret Service（GNOME Keyring / KWallet），无 Secret Service 时报明确错误并保留环境变量通道。

---

## 9. 产物

| 产物 | 路径（相对 `linux/desktop/src-tauri/`） |
| --- | --- |
| 主程序（未打包） | `target/release/simultaneous-translator` |
| sidecar（中间产物） | `binaries/translator-bridge-x86_64-unknown-linux-gnu` |
| deb | `target/release/bundle/deb/simultaneous-translator_<版本>_amd64.deb` |
| rpm | `target/release/bundle/rpm/simultaneous-translator-<版本>-1.x86_64.rpm` |

产物验证与归档见 [`testing.md`](testing.md) 与 [`release.md`](release.md)。

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `webkit2gtk-4.1 was not found` | 缺开发包或系统过旧 | Ubuntu 24.04 装 `libwebkit2gtk-4.1-dev`；22.04 需自行升级 WebKitGTK |
| `patchelf: command not found` | 缺打包工具 | `sudo apt-get install patchelf` |
| `failed to find external binary ...-x86_64-unknown-linux-gnu` | sidecar 未生成 | `bash scripts/build-sidecar.sh` |
| `Found version mismatched Tauri packages` | Rust `tauri` crate 与 `@tauri-apps/api` 版本线不一致 | 同步两者版本；不要单独 `cargo update tauri` |
| 开发模式报「未找到开发用 Python 引擎」 | 缺 `linux/.venv` 或 `scripts/tauri_bridge.py` | `bash scripts/install.sh`；或用环境变量指向已有 venv |
| sidecar 启动即退出并提示缺 `dashscope`/`soundcard`/`websockets` | venv 依赖不完整 | 重跑 `scripts/install.sh` 或 `pip install -r requirements.txt` |
| 构建极慢 / 磁盘占用暴涨 | `CARGO_TARGET_DIR` 落在 `/mnt/e`（9p） | 改到 ext4（如 `/home/<user>/targets/tauri-build`） |
| 托盘不显示 | 无 AppIndicator 宿主（如裸 GNOME） | 安装 AppIndicator 扩展；应用会记录告警并降级 |
| 全局快捷键不生效 | Wayland 合成器限制 | 使用 X11 会话；应用会逐项报告注册失败 |
| 无音频设备 / 报 PulseAudio 工具缺失 | 无音频服务 | 安装 `pulseaudio-utils` 或 `pipewire-pulse`；WSL 用 WSLg 的 PulseServer |

---

## 11. 与 Windows 构建的差异

| 项 | Windows | Linux |
| --- | --- | --- |
| 构建入口 | `scripts/tauri.ps1` / `npm run desktop:build` | `scripts/build.sh` / `bash scripts/build-sidecar.sh` |
| 引擎产物 | `translator-bridge-x86_64-pc-windows-msvc.exe` | `translator-bridge-x86_64-unknown-linux-gnu` |
| 安装包 | NSIS `.exe` | deb / rpm（AppImage 可选） |
| 系统音频采集 | WASAPI 进程回环 + 独立 Rust 采集 exe | `pactl` + `parec`（Python 侧 `system_capture.py`），无额外 Rust bin |
| 虚拟麦克风 | VB-CABLE 驱动安装 | PulseAudio 内置模块（`pactl`），无驱动 |
| 托盘依赖 | 系统内置 | `libayatana-appindicator3` 运行时依赖 |
| 全局快捷键 | Win32 注册 | `tauri-plugin-global-shortcut`，X11 全功能 / Wayland 受限 |
