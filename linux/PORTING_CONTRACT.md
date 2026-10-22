# Linux 版移植契约（协作基线）

> 本文是 Linux 版开发期间的**唯一权威约定**：目录归属、接口不变量、平台映射决策、验证环境与协作规则。
> 与本文冲突的实现视为缺陷；需要改动本文的决策时，先由 Lead 更新本文再改代码。
>
> 参考基线：`E:\Project\translation\windows`（Windows v1.0.2，Git HEAD `0da6dbe`），**只读，任何人不得修改 `windows/` 下的任何文件**。

## 1. 目标与非目标

### 目标

在 `E:\Project\translation\linux` 产出一个**可独立构建、可安装运行**的 Linux 桌面版「同传翻译」，功能与 Windows v1.0.2 对等：

- Tauri 2 桌面应用：React + TypeScript 前端、Rust 原生后端、Python 翻译引擎（JSONL 桥接）。
- 收听通道：系统声音采集（排除本软件输出）与指定播放设备回环；麦克风输入。
- 发言通道：麦克风输入、译文语音、虚拟麦克风（会议软件可选用）。
- 双向会话、增量字幕、重连、静默保活、音色复刻、字幕悬浮窗、托盘与全局快捷键、会话历史与导出、API Key 安全存储、检查更新。
- 打包：deb / rpm 为主，AppImage 可选；构建与测试脚本为 shell。

### 非目标（本轮不做）

- 不抽取 `shared/` 共用代码（保持 `windows/` 发布链路零风险；抽取作为后续独立任务，见 `shared/README.md`）。
- 不做 WebKit/浏览器之外的移动端、不做 PipeWire 原生 API 实现（走 `pipewire-pulse` 兼容层）。
- 不做 Linux 自动安装更新（只做「检查 → 下载 → 校验 → 打开所在目录/提示安装」，不自动提权）。
- 不引入新的收费/闭源组件；虚拟麦克风用 PulseAudio 内置模块实现，不需要 VB-CABLE 类驱动。

### 版本

统一 **1.0.2**（与 Windows 功能对等）。`package.json`、`Cargo.toml`、`tauri.conf.json` 三处版本号保持一致。

## 2. 规格来源（必须先读）

| 主题 | 文件（路径相对工作区） |
| --- | --- |
| Windows 版功能与行为说明 | `windows/README.md` |
| 前端↔Rust 契约 | `windows/desktop/src/tauri.ts`、`windows/desktop/src-tauri/src/lib.rs` |
| Rust↔Python JSONL 协议 | `windows/scripts/tauri_bridge.py`（`handle_request`）、`windows/scripts/test_tauri_bridge.py` |
| 运行时通道控制 | `windows/docs/runtime-channel-control.md`（已复制到 `linux/docs/`，按 Linux 改写） |
| 字幕悬浮窗 | `windows/docs/subtitle-window.md`（同上） |
| 托盘/快捷键 | `windows/docs/tray-shortcuts-contract.md`（同上） |
| 音频路由设计 | `linux/docs/linux-audio-routing.md`（本工作区，权威） |
| 前端界面基线 | `windows/desktop/src/*.tsx`、`*.css`（已复制到 `linux/desktop/src/`） |

## 3. 目录结构与代码归属

```text
linux/
├─ README.md                     Linux 版总说明（Lead 维护）
├─ PORTING_CONTRACT.md           本文（Lead 维护）
├─ THIRD_PARTY_NOTICES.md        第三方声明（build-verify 维护）
├─ requirements.txt              Python 依赖（engine-port 维护）
├─ .gitignore                    Lead 维护
├─ desktop/
│  ├─ package.json               ui-port（脚本与依赖）
│  ├─ package-lock.json          ui-port（仅在依赖变更时更新）
│  ├─ index.html / vite.config.ts / tsconfig*.json   ui-port
│  ├─ public/                    静态资源（ui-port；字体授权文件必须保留）
│  ├─ tests/                     Node 单测（ui-port）
│  ├─ src/                       React + TS（ui-port）
│  └─ src-tauri/
│     ├─ Cargo.toml / Cargo.lock / build.rs / tauri.conf.json   rust-port
│     ├─ capabilities/           rust-port
│     ├─ icons/                  rust-port（含 Linux PNG，Android/iOS 目录可删）
│     └─ src/                    rust-port
├─ scripts/
│  ├─ livetranslate.py           engine-port
│  ├─ tauri_bridge.py            engine-port
│  ├─ system_capture.py          engine-port（Linux 重写）
│  ├─ audio_test_helpers.py      engine-port
│  ├─ translation_languages.json engine-port（数据不变）
│  ├─ test_*.py                   engine-port（按 Linux 适配）
│  ├─ install.sh                 engine-port（开发环境：建 .venv / 装依赖）
│  ├─ build-sidecar.sh           engine-port（PyInstaller → binaries/）
│  └─ dev.sh / build.sh          engine-port（开发启动 / 完整构建）
├─ packaging/                    build-verify（desktop template、图标、发布说明模板）
├─ docs/                         build-verify 总体维护；各契约文档由标注的 owner 维护
│  ├─ build.md / release.md / testing.md / qa/     build-verify
│  ├─ linux-audio-routing.md                       Lead
│  ├─ runtime-channel-control.md / subtitle-window.md / tray-shortcuts-contract.md
│  │                                               rust-port（按 Linux 改写）
└─ releases/linux/               （工作区级）构建产物归档：releases/linux/v1.0.2/
```

## 4. 接口不变量（不允许破坏）

### 4.1 前端 ↔ Rust：Tauri 命令

命令名、参数名、返回结构**全部保持 Windows 现状**，只在语义上做 Linux 实现：

| 命令 | 所在模块 | Linux 语义要点 |
| --- | --- | --- |
| `get_settings` / `save_settings` | lib.rs | 设置 schema v9 不变，文件路径用 Tauri app config dir |
| `get_active_session` | lib.rs | 不变 |
| `fetch_provider_models` / `test_provider_connection` | lib.rs | 不变（走引擎 probe） |
| `list_audio_devices` / `run_audio_test` | lib.rs → 引擎 | 不变（引擎内部改用 PulseAudio 枚举） |
| `start_translation` / `stop_translation` | lib.rs | 不变（引擎启动参数、sidecar 路径按 Linux） |
| `export_caption_history` | lib.rs | rfd 保存对话框（Linux 需 xdg-portal 或 gtk3 feature），UTF-8 BOM 保留 |
| `get_runtime_state` / `dispatch_native_action` | tray.rs | 不变 |
| `install_virtual_microphone` | virtual_microphone.rs | 改为「创建/确保 PulseAudio 虚拟麦克风」；不再安装驱动 |
| `open_virtual_microphone_link` | virtual_microphone.rs | 打开 Linux 帮助链接（本地文档/GitHub） |
| `open_api_key_help` | api_key_help.rs | `xdg-open` 打开浏览器 |
| `check_app_update` / `download_app_update` | updater.rs | GitHub Releases 检查；Linux 资产匹配规则见 §5.10 |
| `install_app_update` | updater.rs | 校验后打开下载目录（AppImage 可替换当前文件）；**不自动提权** |
| `open_app_releases` | updater.rs | `xdg-open` GitHub Releases |

前端 `tauri.ts` 中每个命令的类型与错误文案保持一致；平台文案（Windows/凭据管理器/VB-CABLE 等）由 ui-port 改写为 Linux 说法。

### 4.2 Rust ↔ Python：JSONL 引擎协议

**逐行 JSON，stdin 命令 / stdout 事件**，命令名固定为：
`ping`、`start`、`stop`、`probe.models`、`probe.connect`、`devices`、`audio_test`、`set_runtime_channel`、`set_speak_muted`、`shutdown`。

- 事件种类、字段名、`session_id` 语义、`id` 请求-响应配对、错误对象结构全部保持不变。
- 不允许在协议中新增必填字段；新增可选字段需同步 `linux/scripts/test_tauri_bridge.py` 并在本契约记录。
- 现有 Python 测试（`test_tauri_bridge.py` 等）是协议的回归网，必须保留并在 Linux 下可运行。

### 4.3 设置与凭据

- 设置 schema **v9**，`settings.json` / `settings.production.json` 命名与迁移逻辑保持不变（与 Windows 设置文件格式兼容，可互相拷贝排查）。
- 凭据信封格式（`StoredSecretEnvelope` v2）与 account 命名保持不变；仅存储后端换成 Secret Service。
- 密钥绝不写入设置文件或日志。

### 4.4 引擎启动约定

- 开发模式：`linux/.venv/bin/python linux/scripts/tauri_bridge.py`（由 `scripts/install.sh` 创建），可由环境变量覆盖解释器路径。
  解释器优先级（Rust `lib.rs` 实现）：`TRANSLATOR_PYTHON` 环境变量 → `<linux 根>/.venv/bin/python` → `python3`。
- 发行模式：与主程序同目录的 `translator-bridge`（Tauri externalBin 复制）。
- **构建前置**：tauri-build 在编译期检查 `desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu`
  是否存在，因此 `scripts/build-sidecar.sh` 必须先于 `cargo build` / `npx tauri build` 执行（否则报
  `resource path ... doesn't exist`）。
- 缺失引擎时的错误提示沿用现状语义（"已打包的翻译引擎缺失…" / "未找到开发用 Python 引擎…"），文案改为 Linux 路径。

## 5. Linux 平台映射决策

| 编号 | 主题 | 决策 |
| --- | --- | --- |
| D1 | 线程/进程模型 | 与 Windows 相同：Rust 主进程 + Python 子进程（stdio JSONL），前端只通过 Tauri 命令访问。 |
| D2 | 系统声音采集（排除本软件） | PulseAudio/PipeWire 专用混音 sink `translator_mix` + loopback 回放 + 采集其 monitor；本软件译文直出用户播放设备，从而不回采。详见 `docs/linux-audio-routing.md`。失败即报错，不回退到会回采的模式。 |
| D3 | 指定播放设备回环 | 直接采集该 sink 的 `.monitor`（不排除本软件），语义与 Windows 回环模式一致；禁止与本软件译文输出同设备。 |
| D4 | 虚拟麦克风 | `module-null-sink`（`translator_mic`）+ `module-remap-source`（`translator_mic_source`，显示名 "Translator Virtual Microphone"）。`install_virtual_microphone` = 创建/确保；会议软件选择该虚拟源。无需下载驱动。**实测约束**：pactl 模块参数不接受含 ASCII 空格的 description，显示名用不换行空格 U+00A0 分隔（Rust 写 `\u{a0}`），内部对象名不变。 |
| D5 | 音频后端 | Python `soundcard`（PulseAudio 后端）用于设备枚举/麦克风/播放；系统采集用 `parec` 子进程（16 kHz 单声道 s16le，100 ms/帧）。模块管理统一用 `pactl`（pipewire-pulse 兼容）。 |
| D6 | API Key | `keyring` v3 + `sync-secret-service` + `crypto-rust`（GNOME Keyring / KWallet）；无 Secret Service 时给出明确错误，并保留 `DASHSCOPE_API_KEY` 等环境变量通道。 |
| D7 | 托盘 | Tauri `tray-icon`（libayatana-appindicator3 运行时依赖）。无托盘环境（无 appindicator host）时记录告警并降级为「关闭窗口即退出」并在设置页提示。 |
| D8 | 全局快捷键 | `tauri-plugin-global-shortcut`：X11 全功能；Wayland 下通常不可用 → 逐项报告注册失败（沿用现有逻辑），设置页明确提示需要 X11/合成器支持。Ctrl+Shift+* 默认组合保持不变。 |
| D9 | 字幕悬浮窗 | 无边框置顶窗口沿用现状；X11 下 `set_always_on_top` 生效，Wayland 由合成器决定，失败不阻塞主流程并记录。 |
| D10 | 检查更新 | 同一 GitHub 仓库 Releases；Linux 资产命名统一带平台与架构：`simultaneous-translator_<version>_linux_amd64.deb`、`..._linux_amd64.rpm`、`..._linux_amd64.AppImage`（与 Windows 资产 `_x64-setup.exe` 一样一眼能看出系统/架构；旧版 `_amd64.<ext>` 命名仍被接受），以及 `SHA256SUMS.txt`（`<sha>  <文件名>` 每行）。下载 → SHA256 校验 → 打开所在目录；若以 AppImage 运行且可写，替换当前 AppImage 并提示重启。 |
| D11 | 打包 | `bundle.targets = ["deb", "rpm"]`，AppImage 作为可选目标（需构建机联网下载 linuxdeploy；默认不启用，文档给命令）。`productName` 用 ASCII `simultaneous-translator` 以满足 deb 包名规范；中文显示名通过 `bundle.linux.deb.desktopTemplate` / `bundle.linux.rpm.desktopTemplate` 提供（`Name=同传翻译`，`Name[zh_CN]=同传翻译`）。窗口标题仍为「同传翻译」。 |
| D12 | Python 打包 | PyInstaller onefile（Linux）：`binaries/translator-bridge-x86_64-unknown-linux-gnu`，`externalBin: ["binaries/translator-bridge"]` 保持不变。 |
| D13 | 文件路径 | 设置/历史/缓存目录交给 Tauri `app_config_dir` / `app_cache_dir`；导出历史走 rfd；不硬编码 `~/.config` 具体子路径。 |
| D14 | 前端平台化 | `linux/desktop/src` 是 Linux 分支副本，**直接改写文案与交互**，不引入运行时平台分支；浏览器演示模式（`npm run dev` 的 mock 后端）保留。 |
| D15 | 依赖策略 | Rust 依赖保持与 Windows 相同的 crate 版本线（复制 `Cargo.lock`，只在必要处增删 feature/依赖并提交 lock 变化）；不引 Windows-only crate（移除 `wasapi`、`windows-sys` 等）。 |
| D16 | 编码与换行 | 所有文本文件 UTF-8、LF；shell 脚本 `#!/usr/bin/env bash` + `set -euo pipefail`；Python 保持现有风格与中文文案。 |

## 6. 音频架构

见 `docs/linux-audio-routing.md`（由 Lead 维护）。要点：三个 PulseAudio 模块（null-sink ×2、loopback、remap-source）的命名、加载/卸载顺序、崩溃残留清理、设备枚举映射、测试隔离。

## 7. 构建与验证环境（本机已预置）

| 项目 | 事实 |
| --- | --- |
| WSL 发行版 | Ubuntu 24.04（`wsl.exe -d Ubuntu-24.04`，默认用户 `cyh26`，root 可用 `-u root`） |
| 项目在 WSL 的路径 | `/mnt/e/Project/translation`（9p 挂载，比 ext4 慢，构建缓存放 ext4） |
| 系统依赖 | 已装：`libwebkit2gtk-4.1-dev`、`librsvg2-dev`、`patchelf`、`libayatana-appindicator3-dev`、`libgtk-3-dev`、`libxdo-dev`、`libasound2-dev`、`libpulse-dev`、`pulseaudio-utils`、`xvfb`、`dpkg-dev`、`fakeroot`、`rpm`、`fonts-noto-cjk` |
| Rust | rustup stable 1.99.1（`/home/cyh26/.cargo/bin`），官方 crates.io 索引可用 |
| Node | v24.14（nvm），npm registry 已设 `https://registry.npmmirror.com` |
| Python venv | `/home/cyh26/venvs/translation-linux`（Python 3.12，已装 `linux/requirements.txt` 依赖） |
| PulseAudio 测试环境 | WSLg server：`export PULSE_SERVER=unix:/mnt/wslg/PulseServer`；已验证支持 null-sink / loopback / remap-source / parec 采集 |
| Rust 编译缓存 | 各 owner 使用独立 `CARGO_TARGET_DIR`（ext4）：rust-port=`/home/cyh26/targets/rust-check`，build-verify=`/home/cyh26/targets/tauri-build`，避免互相等锁 |
| 构建产物 | `linux/desktop/src-tauri/target/...`（Windows 侧不需要）、WSL 侧目标目录；deb/rpm 最终复制到 `E:\Project\translation\releases\linux\v1.0.2\` |

### 常用命令

```bash
# 前端（WSL，工作目录 /mnt/e/Project/translation/linux/desktop）
npm install            # 首次
npm run build          # tsc -b && vite build
node --experimental-strip-types --test tests/*.test.mjs

# Python 引擎（WSL）
cd /mnt/e/Project/translation/linux
/home/cyh26/venvs/translation-linux/bin/python scripts/test_tauri_bridge.py
/home/cyh26/venvs/translation-linux/bin/python -m pytest scripts -q   # 若启用 pytest

# Rust 检查（谁改 rust 谁跑；build-verify 跑最终构建）
cd /mnt/e/Project/translation/linux/desktop/src-tauri
CARGO_TARGET_DIR=/home/cyh26/targets/rust-check cargo check

# 完整打包（build-verify）
cd /mnt/e/Project/translation/linux/desktop
npx tauri build --bundles deb        # 前置：sidecar 已生成
```

## 8. 验收里程碑

| 里程碑 | 内容 | Owner |
| --- | --- | --- |
| M1 | 前端 `npm run build` 通过、Node 单测通过 | ui-port |
| M2 | Python 单测通过（协议测试 + Linux 音频模块测试 + PulseAudio 集成测试） | engine-port |
| M3 | `cargo check`（或 `cargo build`）通过，无 Windows-only 残留 | rust-port |
| M4 | `npx tauri build --bundles deb` 产出可安装 .deb，侧车 `translator-bridge` 被正确打入 | build-verify |
| M5 | 冒烟：Xvfb/WSLg 下启动 app（能开窗、能读设置、能启动引擎），PulseAudio 模块生命周期与 parec 采集集成测试通过；Linux 文档完成 | build-verify + Lead |

## 9. 协作规则

1. **写作用域**：只改本契约 §3 中属于自己 scope 的文件。跨 scope 修改必须先发消息给 owner 或 Lead，不得直接改。
2. **`windows/` 只读**：任何情况下不修改、不删除、不格式化 `windows/` 下文件。
3. **WSL 环境**：只有 build-verify 可以执行 `apt-get` / 修改系统级环境；其他人只读使用已装工具。Rust 编译使用各自 `CARGO_TARGET_DIR`。
4. **PulseAudio 集成测试**：测试中创建的 sink/source 名字必须带 `tt_test_` 前缀，测试结束（含异常）必须卸载并断言无残留；不得改动系统默认 sink 以外的持久配置；测试结束恢复 `pactl get-default-sink`。
5. **不提交产物**：`node_modules/`、`target/`、`dist/`、`.venv/`、`binaries/*`、`*.deb`、`*.rpm`、`*.AppImage`、日志均不进入版本库（见 `.gitignore`）。
6. **汇报**：每个 owner 完成任务后向 Lead 发一条简洁消息：完成项、验证命令与结果、遗留风险、需要其他 owner 配合的事。发现契约冲突时立即上报，不自行改变决策。
7. **并发构建**：本工作区是秒级共享文件系统，多个 agent 可能同时写不同目录；不要同时在同一目录跑 npm/cargo 的全量构建。build-verify 拥有最终构建权。

## 10. 已知限制（必须在 Linux README 中如实说明）

- Wayland：全局快捷键、always-on-top、窗口拖动依赖合成器；建议 X11 或确认合成器支持。
- 纯 PipeWire（无 `pipewire-pulse`）环境不保证可用；需要 `pactl`/`parec`。
- 虚拟麦克风的可用性取决于会议软件是否列出 PulseAudio 源。
- 更新仅支持「检查 + 下载 + 校验 + 人工安装」，不做自动提权安装。
