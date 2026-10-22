# 同传翻译 <版本号>

> 发布说明模板（build-verify 维护）。复制为 `releases/linux/v<版本>/RELEASE_NOTES.md` 后填写。
> 风格与 `releases/windows/v1.0.2/RELEASE_NOTES.md` 对齐：先讲用户可见变化，再给安装包与验证证据。

## 本版变化

- <功能 A：一句话说明用户可见效果>
- <功能 B>
- <修复：现象 → 现在的行为>
- 回归：<明确写出「上一版行为保持不变」的项>

## Linux 版说明（1.0.2 首次 Linux 发布时保留）

- 系统声音隔离采集使用 PulseAudio/PipeWire 虚拟混音 sink（`translator_mix`）：同传期间临时切换默认
  sink，结束自动恢复；异常退出后下次启动自动清理残留模块。
- 虚拟麦克风使用 PulseAudio 内置模块（`translator_mic` / `translator_mic_source`），在会议软件中显示为
  “Translator Virtual Microphone”，**无需安装任何驱动**。
- 托盘需要 libayatana-appindicator 宿主（GNOME 需 AppIndicator 扩展）；无托盘环境自动降级为「关闭窗口即退出」。
- 全局快捷键在 X11 全功能；Wayland 下取决于合成器，注册失败会逐项提示。
- 字幕悬浮窗置顶在 X11 生效；Wayland 由合成器决定。

## 安装包（Linux x64）

| 文件 | 说明 |
| --- | --- |
| `simultaneous-translator_<版本>_linux_amd64.deb` | Ubuntu 24.04 / Debian 12+ 安装包 |
| `simultaneous-translator_<版本>_linux_amd64.rpm` | Fedora / openSUSE 安装包 |
| `simultaneous-translator_<版本>_linux_amd64.AppImage` | 便携版（可选，需 FUSE） |
| `SHA256SUMS.txt` | 校验文件，每行 `<64 位 SHA-256>  <文件名>` |

安装：

```bash
sudo apt install ./simultaneous-translator_<版本>_linux_amd64.deb     # Debian/Ubuntu
sudo dnf install ./simultaneous-translator-<版本>-1.x86_64.rpm  # Fedora
```

也可从 Release 页面附件下载，或在应用内「设置 → 软件更新」检查更新（Linux 版为
「检查 → 下载 → SHA256 校验 → 打开所在目录/提示安装」，不自动提权）。

## 验证

- Python 引擎单测：<N> 条通过 / <M> 跳过（跳过原因：<PulseAudio 不可用等>）。
- PulseAudio 集成测试：<N> 条通过（WSLg `PULSE_SERVER`），模块无残留、默认 sink 已恢复。
- 前端：`npm run build` 通过；Node 单测 <N> 条通过。
- Rust：`cargo build`/`cargo test` 通过（<N> 条）。
- 打包：`npx tauri build --bundles deb,rpm` 退出码 0；`verify-deb.sh` PASS=<N> FAIL=0。
- 冒烟：`xvfb-run -a dbus-run-session -- <主程序>` 运行 <T> 秒未崩溃（exit 124），日志见
  `artifacts/logs/linux-verification.md`。
- 真实接口翻译、会议软件虚拟麦克风、托盘/快捷键交互仍需人工验收（见 `linux/docs/qa/manual-checklist.md`）。

## SHA-256

`<deb 的 sha256>`（deb）
`<rpm 的 sha256>`（rpm）
`<AppImage 的 sha256>`（AppImage，如有）

校验文件见附件 `SHA256SUMS.txt`。

## 已知限制

- Wayland：全局快捷键、always-on-top、无边框窗口拖动依赖合成器；建议 X11 或确认合成器支持。
- 纯 PipeWire（无 `pipewire-pulse`）环境不保证可用，需要 `pactl` / `parec`。
- 虚拟麦克风是否出现在会议软件设备列表，取决于该软件是否列出 PulseAudio 源。
- 更新仅支持「检查 + 下载 + 校验 + 人工安装」，不自动提权。
- <本版新增的已知问题，参见 linux/docs/qa/known-issues.md>
