# 第三方组件与许可声明（Linux 版）

本文件随 Linux 发行包一起安装（`bundle.resources`），说明「同传翻译」Linux 版使用的第三方组件及其许可。
Linux 版不包含、也不下载任何专有驱动：虚拟麦克风使用 PulseAudio/PipeWire 内置模块实现，
Windows 版的 VB-CABLE 组件与 wasapi-rs 在 Linux 版中**不存在**。

---

## 1. 随包分发的组件

### 1.1 Fusion Pixel Font（界面字体）

The interface bundles the unmodified Fusion Pixel 12px proportional Simplified Chinese font by TakWolf,
including Latin and CJK glyphs. It is used locally; no remote font request is made by the application.

- Source: https://github.com/TakWolf/fusion-pixel-font
- Asset origin: https://fusion-pixel-font.takwolf.com/
- Copyright (c) 2022, TakWolf (https://takwolf.com).
- License: SIL Open Font License, Version 1.1.
- 完整许可文本随前端资源分发：`desktop/public/fonts/LICENSE-OFL.txt`，安装后位于
  前端资源目录 `fonts/LICENSE-OFL.txt`；源码仓库同路径可查。

### 1.2 Tauri 框架与官方插件

- Tauri（含 `tauri`、`tauri-build`、`tauri-plugin-global-shortcut`、`tauri-plugin-single-instance`）
  Copyright (c) 2019-2025 Tauri Programme within The Commons Conservancy.
- License: MIT OR Apache-2.0。Source: https://github.com/tauri-apps/tauri
- `@tauri-apps/api` / `@tauri-apps/cli`（前端与构建工具）：MIT OR Apache-2.0，同上仓库。

### 1.3 Rust crates（静态链接进主程序）

主程序由 Rust 静态链接以下主要 crate（完整依赖树见 `desktop/src-tauri/Cargo.lock`）：

| crate | 用途 | License |
| --- | --- | --- |
| `keyring` | 系统密钥环（Secret Service）访问 | MIT OR Apache-2.0 |
| `serde` / `serde_json` | 序列化 | MIT OR Apache-2.0 |
| `reqwest` / `native-tls` | HTTP 客户端（更新下载） | MIT OR Apache-2.0 |
| `rfd` | 保存文件对话框（GTK3 后端） | MIT |
| `sha2` | SHA-256 校验 | MIT OR Apache-2.0 |
| `semver` | 版本比较 | MIT OR Apache-2.0 |
| `url` / `uuid` | URL 与标识符 | MIT OR Apache-2.0 |

以上均为宽松许可；对应的版权与许可声明随 crate 源码分发，可在 crates.io 及各自仓库查阅。

### 1.4 Python 引擎（PyInstaller onefile sidecar）

翻译引擎由 PyInstaller 以 onefile 形式打包为 `translator-bridge`，其中包含 Python 解释器与以下主要第三方库：

| 组件 | 用途 | License |
| --- | --- | --- |
| CPython | Python 运行时 | PSF License 2.0 |
| PyInstaller | 打包工具（生成的 bootloader 随包） | GPL-2.0-or-later **with Bootloader Exception** |
| `dashscope` | 阿里云百炼实时语音识别 | Apache-2.0 |
| `google-genai` | Google Gemini 实时翻译 | Apache-2.0 |
| `httpx` | HTTP 客户端 | BSD-3-Clause |
| `numpy` | 数值计算 | BSD-3-Clause |
| `scipy` | 重采样等信号处理 | BSD-3-Clause |
| `soundcard` | PulseAudio 设备枚举/录音/播放 | BSD-3-Clause |
| `websockets` | 实时 WebSocket 协议 | BSD-3-Clause |

传递依赖（如 `certifi` (MPL-2.0)、`anyio`/`sniffio` (MIT)、`httpcore`/`h11` (BSD-3/MIT)、
`pydantic` (MIT)、`protobuf` (BSD-3-Clause)、`google-auth` (Apache-2.0)、`requests` (Apache-2.0)、
`typing_extensions` (PSF-2.0)、`idna` (BSD-3-Clause) 等）同样为宽松许可，完整清单可用以下命令生成：

```bash
/home/cyh26/venvs/translation-linux/bin/pip install pip-licenses
/home/cyh26/venvs/translation-linux/bin/pip-licenses --format=markdown --with-urls
```

说明：
- `numpy`/`scipy` 的 Linux wheel 内含 OpenBLAS（BSD-3-Clause）与 GCC Fortran 运行时
  （GPL-3.0 **with GCC Runtime Library Exception**，允许随二进制再分发）；
- PyInstaller 的 GPLv2 许可仅约束其自身 bootloader 源码；其 Bootloader Exception 明确允许
  打包并再分发采用其它许可的应用程序，本项目仅使用其打包能力；
- 引擎的 Python 源码（`linux/scripts/*.py`）与本项目其它代码同许可，不因 PyInstaller 打包而改变。

---

## 2. 运行时系统依赖（动态链接，不随包分发）

下列组件由发行版以系统包提供，deb/rpm 的 `Depends`/`Requires` 中声明，**不**打包进本项目产物：

| 组件 | 用途 | License | Debian/Ubuntu 包 |
| --- | --- | --- | --- |
| WebKitGTK 4.1 | Tauri WebView | LGPL-2.1+ / BSD 系（WebKit） | `libwebkit2gtk-4.1-0` |
| GTK 3 | 原生窗口/对话框/托盘宿主 | LGPL-2.1+ | `libgtk-3-0` |
| GLib / GObject | 基础设施 | LGPL-2.1+ | `libglib2.0-0` |
| librsvg | SVG 渲染（图标） | LGPL-2.1+ | `librsvg2-2` |
| libayatana-appindicator3 | 系统托盘（AppIndicator） | LGPL-2.1 / LGPL-3.0 | `libayatana-appindicator3-1` |
| libxdo | X11 全局快捷键辅助 | BSD-2-Clause | `libxdo3` |
| PulseAudio / PipeWire（`pipewire-pulse`） | 音频服务 | LGPL-2.1+ / MIT 系 | `pulseaudio-utils` 或 `pipewire-pulse` |
| libpulse | PulseAudio 客户端库 | LGPL-2.1+ | `libpulse0` |

> 上表组件通过动态链接使用，其源码与许可由发行版提供（`/usr/share/doc/<pkg>/copyright`）。
> 若发行版未自带，请按发行版文档安装。

### 2.1 音频后端说明

- 系统声音隔离采集：`pactl`（`module-null-sink` / `module-loopback`）与 `parec`，来自
  `pulseaudio-utils`（或 `pipewire-pulse` 提供的兼容命令）；**不修改**用户持久配置，仅在会话期间
  以 `translator_*` 命名加载模块并在结束后卸载。
- 虚拟麦克风：PulseAudio/PipeWire 内置 `module-null-sink` + `module-remap-source`，
  会议软件中显示为“Translator Virtual Microphone”。**无需安装驱动**。
- 未使用 VB-CABLE、WASAPI 或任何专有音频驱动/闭源组件。

---

## 3. 构建/发布工具（不随安装包分发）

| 工具 | 用途 | License |
| --- | --- | --- |
| Node.js / npm | 前端构建 | MIT |
| Vite / TypeScript | 前端构建 | MIT / Apache-2.0 |
| Rust / Cargo | 编译 | MIT OR Apache-2.0 |
| PyInstaller | sidecar 打包 | GPL-2.0-or-later with Bootloader Exception |
| `dpkg-deb` / `fakeroot` | deb 打包 | GPL-2.0+ |
| `rpm` / `rpmbuild` | rpm 打包 | GPL-2.0+ / LGPL-2.1+ |
| linuxdeploy / appimagetool / AppImage runtime（可选 AppImage） | AppImage 打包 | MIT |

---

## 4. 字体与 CJK 显示

界面内嵌 Fusion Pixel 12px 字体（OFL-1.1，见 §1.1）。界面、字幕与导出文本中的日文/韩文/繁体等
CJK 字形依赖系统字体回退；推荐安装 `fonts-noto-cjk`（SIL OFL-1.1）以获得完整覆盖。
该字体由发行版提供，不随本应用分发。

---

## 5. 与 Windows 版的差异（许可相关）

| 项 | Windows 版 | Linux 版 |
| --- | --- | --- |
| 系统声音采集 | WASAPI 进程回环（`wasapi-rs`，MIT） | PulseAudio/PipeWire monitor source（无额外库） |
| 虚拟麦克风 | 可选下载并引导安装 VB-CABLE 驱动（第三方专有/捐赠许可） | PulseAudio 内置模块，**不涉及任何第三方驱动许可** |
| 凭据存储 | Windows Credential Manager（`keyring` windows-native） | Secret Service（GNOME Keyring / KWallet） |
| WebView | WebView2（Microsoft，系统组件） | WebKitGTK（系统组件） |

因此 Linux 发行包**不包含** VB-CABLE 的下载、校验、安装逻辑，也不含其许可文本。
