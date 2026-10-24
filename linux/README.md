# 同传翻译（Linux 桌面版）

面向 Linux x64 的实时同传工具，与 [Windows 版](../README.md) 功能对等（v1.0.4）。
技术栈与 Windows 版一致：Tauri 2 + React/TypeScript 前端、Rust 原生后端、Python 翻译引擎；
音频、虚拟麦克风、托盘、密钥存储等平台相关部分按 Linux（PulseAudio / PipeWire / Secret Service /
AppIndicator / X11 或 Wayland）重新实现。

- 状态：**Linux 版 1.0.4**
- 目录：仓库内 `linux/`；Windows 版源码在仓库根目录
- 平台：Linux x64；参考验证环境 Ubuntu 24.04（WSLg 与物理桌面均可）
- 文档：[构建](docs/build.md) · [打包](packaging/README.md) · [发布](docs/release.md) ·
  [测试](docs/testing.md) · [音频路由设计](docs/linux-audio-routing.md) · [QA](docs/qa/)

## 目录

- [与 Windows 版的差异](#与-windows-版的差异)
- [两种输出模式](#两种输出模式)
- [通道与音频路由](#通道与音频路由)
- [模型连接](#模型连接)
- [音频设备测试向导](#音频设备测试向导)
- [托盘、快捷键与运行时控制](#托盘快捷键与运行时控制)
- [字幕悬浮窗](#字幕悬浮窗)
- [会话历史与导出](#会话历史与导出)
- [设置与安全](#设置与安全)
- [安装与打包](#安装与打包)
- [开发运行](#开发运行)
- [测试](#测试)
- [已知限制](#已知限制)
- [目录结构](#目录结构)

## 与 Windows 版的差异

Linux 版是 `linux/` 下**独立完整**的工程：前端、Rust 后端、Python 引擎各自带 Linux 平台实现，
`windows/` 保持发布基线不动（共用代码的物理抽取留到后续任务，见 `../shared/README.md`）。

| 能力 | Windows 版 | Linux 版 |
| --- | --- | --- |
| 系统声音采集（排除本软件） | WASAPI 进程回环（独立采集 exe） | PulseAudio 虚拟混音 sink `translator_mix` + `parec`，会话内临时切换默认 sink、结束恢复；见[音频路由](docs/linux-audio-routing.md) |
| 指定播放设备回环 | WASAPI loopback | 该 sink 的 `.monitor` 采集 |
| 虚拟麦克风 | VB-CABLE 驱动（需下载安装） | PulseAudio 内置模块 `translator_mic` + `translator_mic_source`，一键创建，无驱动 |
| API Key | Windows 凭据管理器 | Secret Service（GNOME Keyring / KWallet），无服务时可用环境变量 |
| 托盘 | 系统内置 | `libayatana-appindicator3`；无 AppIndicator 宿主时降级并提示 |
| 全局快捷键 | Win32 注册 | `tauri-plugin-global-shortcut`；X11 全功能，Wayland 受限（逐项报告失败） |
| 字幕悬浮窗置顶 | 置顶窗口 | X11 生效；Wayland 由合成器决定 |
| 安装包 | NSIS `.exe` | deb / rpm（AppImage 可选） |
| 软件更新 | 下载安装包并退出安装 | 检查→下载→SHA256 校验→打开所在目录（AppImage 运行时可替换并提示重启）；不自动提权 |
| 构建脚本 | PowerShell | bash（`scripts/*.sh`） |

设置文件 schema（v9）、凭据信封格式（`StoredSecretEnvelope` v2）、JSONL 引擎协议与 Tauri 命令表
均与 Windows 版保持一致，可跨平台对照排查。

## 两种输出模式

- **语音转文字**：输入语音，实时显示原文和译文字幕。会话只输出文本，不创建译文播放器。
- **语音转语音**：输入语音，播放译文语音，同时显示字幕。

在「设置 → 常规」选择统一输出模式，也可在「设置 → 音频」给两个通道分别选择模式。保存后下次开始同传生效。

目标语言按官方语种表区分：文字模式支持 60 种，语音模式支持其中 29 种。粤语、希腊语等仅支持文字输出的语言
不能播报；输入粤语仍可自动识别并翻译为受支持的语音。界面、原生程序和翻译引擎共用
`scripts/translation_languages.json`，打包时一并包含。

| 通道 | 默认输入 | 默认状态 |
| --- | --- | --- |
| 收听通道（对方 → 我） | 系统声音（排除本软件） | 开启，语音转文字 |
| 发言通道（我 → 对方） | 麦克风 | 关闭，语音转文字 |

两个通道分别选择输入设备、目标语言和译文播放设备，可独立启用。输入为 16 kHz 单声道 PCM16，
输出语音为 24 kHz PCM16。源语言由模型自动识别。

常规设置中的「对话方向」可选择双向对话、只收听或只发言。「我收到的译文语言」控制收听译文，
「对方收到的译文语言」控制发言译文；两个方向分别建立同传会话，拥有各自的翻译目标、音色和输出设备。

## 通道与音频路由

Linux 版用 PulseAudio（或 PipeWire 的 `pipewire-pulse` 兼容层）完成路由，详细设计见
[docs/linux-audio-routing.md](docs/linux-audio-routing.md)。运行要求：

- `pactl` 与 `parec` 可用（安装 `pulseaudio-utils`，PipeWire 用户安装 `pipewire-pulse`）；
- 存在系统默认播放设备；
- 会话期间应用会临时把默认 sink 切到 `translator_mix` 并在结束后恢复；异常退出时下次启动会清理残留模块。

### 收听通道的三种输入方式

1. **系统声音（排除本软件，默认）**：创建 `translator_mix` 虚拟混音 sink，其他应用的声音进入该 sink，
   再 loopback 到你的播放设备（你仍能听到原声）；应用采集它的 monitor。本软件的译文语音显式播放到
   你选择的播放设备，不经过 `translator_mix`，因此不会被再次送入模型。失败时明确报错，不会静默回退到
   会自激的模式。
2. **指定播放设备（回环）**：直接采集所选播放设备的 `.monitor`，不排除本软件；禁止与任一路译文输出
   使用同一设备。
3. **麦克风**：普通录音设备（`soundcard` / PulseAudio source）。与扬声器同时使用时建议佩戴耳机，
   减少声学回声。

### 发言通道与虚拟麦克风（发送译文到其他应用）

把译文语音作为麦克风输入交给会议、游戏或直播软件：

1. 「设置 → 音频 → 发送译文到其他应用」点击「创建虚拟麦克风」（幂等，无需管理员权限、无需驱动、无需重启）。
2. 点击「检测并连接」：应用确认 `translator_mic_source` 存在，并把发言通道的译文输出设为虚拟麦克风。
3. 在会议/直播软件中把麦克风选为 **“Translator Virtual Microphone”**；通常只需设置一次。

此时发言译文只送入虚拟麦克风，本机不额外监听；收听通道仍可使用耳机。应用不会修改其他软件的
麦克风选择，也不会改动系统默认设备之外的用户配置。

## 模型连接

### 首次配置 API Key

未配置密钥时打开软件会显示「首次配置向导」：

1. 点击「获取密钥」打开[阿里云百炼 API Key 控制台](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，
   注册/登录、开通服务，选择地域与业务空间，创建并复制 API Key。
2. 回到软件点击「下一步：填写密钥」，粘贴完整密钥，点击「保存并完成」，然后在主界面点「开始同传」。

默认接口地址：

```text
wss://maas.qianwenaiapi.com/api-ws/v1/realtime
```

程序自动附加 `?model=qwen3.8-livetranslate-flash-realtime`，并通过 `Authorization: Bearer <API Key>`
鉴权。也可为默认地址配置 `DASHSCOPE_API_KEY` 环境变量（不写入设置文件与日志）。

客户端等待 `session.updated` 后开始采集，处理增量字幕、完整字幕与语音事件。网络临时断开或服务端结束连接后，
受影响的通道会自动重连（间隔从 1 秒递增到最长 15 秒），界面显示「正在连接」，恢复后继续翻译；
重连保留通道开关与发言静音状态。长时间静默待机时客户端定时发送 100 ms 静音保活帧，避免服务端空闲超时。
音色按通道独立设置：发言默认「本人音色」（`voice: "default"`、`enable_voice_clone: true`、
`frequency: "once"`），收听默认「系统音色」，也可单独选择「对方音色」（`frequency: "always"`）。

## 音频设备测试向导

「设置 → 音频」提供独立的设备测试向导，开始同传前可确认播放、麦克风和回环链路是否可用。
测试全部在本机完成：不调用翻译模型、不需要 API Key、不保存录音，也不修改已保存的音频设置。

| 测试 | 使用的设备 | 判定依据 |
| --- | --- | --- |
| 播放测试音 | 选定的播放设备 | 播放约 1 秒 440 Hz 测试音，无错误即成功 |
| 麦克风测试 | 选定的麦克风（PulseAudio source） | 以 16 kHz 单声道录制约 3 秒，在内存中计算峰值与均方根，达阈值才算检测到信号 |
| 回环测试 | 选定播放设备的 `.monitor` | 边播测试音边录约 1 秒，检测到超过阈值的信号才算成功 |

设备列表复用「设置 → 音频」的枚举结果（PulseAudio sink / source，排除 monitor 源）；
同一时刻只允许运行一个测试，测试期间选择器与其他入口锁定；正在同传时开始按钮不可用。

## 托盘、快捷键与运行时控制

关闭主窗口不会结束程序：翻译继续运行，程序收起到系统托盘（需要 AppIndicator 宿主；
无宿主时窗口关闭即退出并在设置页提示）。托盘 tooltip 与菜单首项显示当前状态
（未启动 / 正在连接 / 正常翻译 / 音频异常 / 网络异常）。

| 默认快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+Space` | 开始 / 停止同传 |
| `Ctrl+Shift+M` | 临时静音 / 取消静音发言通道 |
| `Ctrl+Shift+O` | 显示 / 隐藏字幕悬浮窗 |
| `Ctrl+Shift+L` | 开启 / 关闭收听通道 |
| `Ctrl+Shift+S` | 开启 / 关闭发言通道 |

可在「设置 → 快捷键」中录制和修改，立即生效、重启保留。**Wayland 会话下全局快捷键通常不可用**
（合成器限制），应用会逐项报告注册失败；需要快捷键时请使用 X11 会话。托盘菜单提供同一套控制；
托盘、快捷键与主界面按钮共用同一个动作分发器。

同传进行中可直接静音发言、开关通道，不必停止会话。这些开关只作用于当前会话，不写回设置文件；
重新开始同传后恢复设置里的通道配置。

## 字幕悬浮窗

默认快捷键 `Ctrl+Shift+O` 或托盘菜单打开：无边框、半透明、跨应用置顶（X11 生效，Wayland 由合成器决定）、
不占任务栏，可拖动、可缩放，只显示当前原文、译文与错误提示，字号跟随「字幕大小」设置。

主界面实时原文和译文默认显示末尾 3 行；悬浮窗显示原文末尾 2 行、译文末尾 3 行。完整记录保留在会话历史中。
窗口按需创建并复用；隐藏或关闭悬浮窗、把主窗口收起到托盘都不会中断正在进行的同传。

## 会话历史与导出

- 历史保存在本机 WebView 的 IndexedDB（数据库名 `simultaneous-translator-history`），不随安装包升级丢失，
  不上传服务器；旧版本 localStorage 记录首次启动时自动迁移。
- 「会话记录」右上角日历图标打开会话历史：左侧按本机日历日期列出记录，右侧按同传会话分组显示起止时间、
  原文、译文、通道和翻译状态。
- 「导出这一天」/「导出全部」导出 UTF-8 文本（带 BOM）。桌面版点击导出后弹出系统保存对话框
  （通过 XDG Desktop Portal 或 GTK 后端），保存位置由用户选择。
- 卸载应用或主界面清空按钮会删除这些记录；需要长期保留请按日期导出。

## 设置与安全

- API Key 保存在系统密钥环（Secret Service：GNOME Keyring / KWallet），普通设置文件不含密钥；
  密钥绑定接口协议与完整地址，修改地址需要重新填写对应密钥。没有可用的 Secret Service 时应用会给出
  明确错误，此时可改用 `DASHSCOPE_API_KEY` 环境变量。
- 设置 schema 为第 9 版，旧版配置自动迁移；开发版与安装版使用独立的设置文件与凭据名称。
- 每次开始都会生成独立会话，停止后丢弃旧会话结果；退出时先关闭同传会话，再结束本地引擎。
- 前端只调用 Tauri 自定义命令，音频数据和 API Key 不暴露给 WebView。
- 数据目录由 Tauri 提供：设置/缓存位于 `$XDG_CONFIG_HOME`、`$XDG_CACHE_HOME` 下的应用目录
  （`com.simultaneous-translator.desktop`），不写入安装目录。

## 安装与打包

### 使用预编译包

从 Releases 下载与发行版匹配的安装包：

| 发行版 | 文件 | 安装 |
| --- | --- | --- |
| Debian / Ubuntu / Deepin / UOS | `simultaneous-translator_1.0.4_linux_amd64.deb` | `sudo apt install ./simultaneous-translator_1.0.4_linux_amd64.deb` |
| Fedora / RHEL / openSUSE | `simultaneous-translator_1.0.4_linux_amd64.rpm` | `sudo dnf install ./simultaneous-translator_1.0.4_linux_amd64.rpm` |
| 任意发行版（免安装） | `simultaneous-translator_1.0.4_linux_amd64.AppImage`（可选构建） | `chmod +x` 后直接运行 |

运行时依赖：`libwebkit2gtk-4.1`、`libgtk-3-0`、`libayatana-appindicator3`（托盘）、
`libpulse0` + `pulseaudio-utils`（或 `pipewire-pulse`）、`xdg-utils`、`libsecret`（可选，Secret Service 客户端）。

> **引擎由两部分组成，缺一不可**：主程序 `simultaneous-translator` 与同目录的 Python 引擎
> `translator-bridge`。deb/rpm 已包含两者；手工做免安装版时必须放在同一目录，否则开始同传会报
> 「已打包的翻译引擎缺失。请重新安装应用。」。

### 从源码构建

```bash
cd linux
bash scripts/install.sh        # 1) 建 .venv、装 Python 依赖、检查 pactl/parec
cd desktop && npm install      # 2) 前端依赖
cd .. && bash scripts/build.sh # 3) sidecar + 前端 + deb/rpm
```

产物（相对 `linux/desktop/src-tauri/`）：

| 路径 | 用途 |
| --- | --- |
| `target/release/simultaneous-translator` | 主程序（未打包） |
| `binaries/translator-bridge-x86_64-unknown-linux-gnu` | 引擎中间产物（externalBin 复制为 `translator-bridge`） |
| `target/release/bundle/deb/simultaneous-translator_1.0.4_amd64.deb` | Debian/Ubuntu 安装包（打包器原名；发布资产重命名为 `_linux_amd64.deb`） |
| `target/release/bundle/rpm/simultaneous-translator-1.0.4-1.x86_64.rpm` | Fedora/openSUSE 安装包（打包器原名；发布资产重命名为 `_linux_amd64.rpm`） |

AppImage 需要构建机联网下载 linuxdeploy 工具链，默认不启用：见 [packaging/README.md](packaging/README.md)。
构建细节、依赖与故障排查见 [docs/build.md](docs/build.md)；发布流程见 [docs/release.md](docs/release.md)。

### 更新检查

程序启动后自动查询 GitHub Releases，并在运行期间每 6 小时检查一次；发现新版本时主界面提示。
Linux 版匹配的资产名为 `simultaneous-translator_<版本>_linux_amd64.deb` / `.rpm` / `.AppImage`，
并核对同一 Release 的 `SHA256SUMS.txt`。下载并校验后打开文件所在目录（AppImage 且文件可写时直接替换并
提示重启）；安装由用户完成，应用不会自动提权执行安装命令。也可在更新页直接打开发布页手动下载。

## 开发运行

前置条件：Linux x64、Node.js ≥ 22.12、Rust stable、Python ≥ 3.10、PulseAudio/PipeWire 工具、WebKitGTK 4.1 开发包
（完整列表见 [docs/build.md](docs/build.md)）。

```bash
cd linux
bash scripts/install.sh
cd desktop
npm install
npm run desktop:dev      # 开发模式：Vite + Tauri + Python 引擎
npm run dev              # 仅浏览器演示（mock 后端，不需要 Rust/音频）
```

## 测试

```bash
cd linux
# Python 引擎（协议、音频、集成）
/home/cyh26/venvs/translation-linux/bin/python scripts/test_tauri_bridge.py
# 或使用项目 venv： .venv/bin/python scripts/test_*.py

# 前端
cd desktop
npm run build
node --experimental-strip-types --test tests/*.test.mjs

# Rust
cd src-tauri
CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build cargo test
```

测试分层、PulseAudio 集成测试的前置条件与跳过规则见 [docs/testing.md](docs/testing.md)，
验收矩阵见 [docs/qa/test-matrix.md](docs/qa/test-matrix.md)。

## 已知限制

- **Wayland**：全局快捷键通常不可用；置顶悬浮窗与窗口拖动由合成器决定。需要这些能力时请登录 X11 会话。
- **纯 PipeWire（无 `pipewire-pulse`）** 环境不保证可用；应用依赖 `pactl`/`parec`。
- **托盘** 需要 AppIndicator 宿主（GNOME 需安装 AppIndicator 扩展）；否则关闭窗口即退出并提示。
- **虚拟麦克风** 需要在会议软件中出现 PulseAudio source；个别应用只列 ALSA 设备。
- **更新** 仅支持「检查 → 下载 → 校验 → 人工安装/AppImage 替换」，不做自动提权安装。
- 首次运行若系统无 Secret Service，API Key 需通过 `DASHSCOPE_API_KEY` 环境变量提供。
- 未做 Linux 真机全链路联调（真实 API Key + 会议软件）的项已在 [docs/qa/known-issues.md](docs/qa/known-issues.md)
  与验证报告中如实标注；本仓库的自动化验证在 WSLg（Ubuntu 24.04）上完成。

## 目录结构

```text
linux/
├─ README.md                 本文件
├─ PORTING_CONTRACT.md       移植契约（接口不变量、平台决策、协作规则）
├─ THIRD_PARTY_NOTICES.md    第三方组件与许可
├─ requirements.txt          Python 依赖
├─ desktop/                  前端 + Tauri 原生后端
│  ├─ src/                   React + TypeScript
│  ├─ public/                字体、装饰图、图标
│  ├─ tests/                 Node 单测
│  └─ src-tauri/             Rust：窗口、托盘、快捷键、密钥、引擎进程、更新、虚拟麦克风
├─ scripts/                  Python 引擎与 shell 构建脚本
│  ├─ tauri_bridge.py        JSONL 引擎入口（命令/事件）
│  ├─ livetranslate.py       同传会话核心
│  ├─ system_capture.py      系统声音隔离采集（pactl + parec）
│  ├─ pulse_audio.py         PulseAudio 模块/设备辅助
│  ├─ install.sh / build.sh / build-sidecar.sh / dev.sh
│  └─ test_*.py              引擎测试
├─ packaging/                deb/rpm 校验脚本、AppImage 说明、发布说明模板
└─ docs/                     构建、发布、测试、音频路由与 QA 文档
```

## 版本

- Linux 版：**1.0.4**（功能对齐 Windows v1.0.4）
- 参考基线：`windows/`（Git 仓库，Windows v1.0.4）
- 本地构建产物归档：`../releases/linux/v1.0.4/`（deb / rpm / SHA256SUMS.txt）

第三方组件与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；像素字体授权见
`desktop/public/fonts/LICENSE-OFL.txt`。
