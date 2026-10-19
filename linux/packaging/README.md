# Linux 打包说明（deb / rpm，可选 AppImage）

> Owner：build-verify。适用版本 **1.0.2**。
> 相关文档：[`../docs/build.md`](../docs/build.md)（开发环境与构建）、[`../docs/release.md`](../docs/release.md)（发布流程）、[`../docs/qa/packaging.md`](../docs/qa/packaging.md)（本机打包验证记录）。

---

## 1. 发行包由两部分组成，缺一不可

| 组成 | 来源 | 发行版中的位置 |
| --- | --- | --- |
| Tauri 主程序 | Rust 构建，前端产物内嵌 | `/usr/bin/simultaneous-translator` |
| Python 翻译引擎 sidecar | PyInstaller onefile 打包 `scripts/tauri_bridge.py` | `/usr/bin/translator-bridge`（与主程序**同目录**） |

引擎 sidecar **不在源码树里**：`desktop/src-tauri/binaries/*` 被 `.gitignore` 排除，`build.rs` 只调用 `tauri_build::build()`。
因此 `cargo build` / `npx tauri build` 都不会生成它。跳过 sidecar 步骤直接打包，**程序能安装、能启动，但开始同传会报「已打包的翻译引擎缺失。请重新安装应用。」**，设置页的设备列表也读不出来（设备枚举同样要启动引擎）。

`tauri.conf.json` 的关键配置（由 rust-port 维护，打包前请确认）：

```json
{
  "productName": "simultaneous-translator",
  "bundle": {
    "active": true,
    "targets": ["deb", "rpm"],
    "resources": { "../../THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md" },
    "externalBin": ["binaries/translator-bridge"],
    "linux": {
      "deb": { "desktopTemplate": "linux/desktop-template.desktop" },
      "rpm": { "desktopTemplate": "linux/desktop-template.desktop" }
    }
  }
}
```

- `productName` 必须是 ASCII `simultaneous-translator`（deb 包名规范），中文显示名 `同传翻译` 由
  `src-tauri/linux/desktop-template.desktop` 提供（`Name=同传翻译`、`Name[zh_CN]=同传翻译`）。
- `externalBin` 写不带目标三元组的 `binaries/translator-bridge`；实际文件必须是
  `binaries/translator-bridge-x86_64-unknown-linux-gnu`（Tauri 按目标三元组匹配），打包时会被复制为 `/usr/bin/translator-bridge`。

---

## 2. 构建前置

```bash
# Ubuntu 24.04 / Debian 12（x86_64）；WSL2 同样适用
sudo apt-get update
sudo apt-get install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev librsvg2-dev patchelf \
  libgtk-3-dev libayatana-appindicator3-dev libxdo-dev \
  libpulse-dev pulseaudio-utils \
  dpkg-dev fakeroot rpm cpio \
  fonts-noto-cjk

# Rust（rustup，stable）
# Node 22.12+（含 npm）；Python 3.12 venv（见 scripts/install.sh）
```

> WebKitGTK 必须是 **4.1**（Ubuntu 22.04 只有 4.0，需自行处理或改用 24.04）。`patchelf` 是 Tauri 打包 AppImage/deb 时
> 调整 RPATH 所需，缺失会在打包阶段报错。

---

## 3. 构建步骤（推荐：一条命令）

```bash
cd /mnt/e/Project/translation/linux          # WSL 下路径
bash scripts/build.sh                        # = sidecar + 前端 + tauri build（deb + rpm）
```

`scripts/build.sh` 内部顺序：

1. `scripts/build-sidecar.sh`：PyInstaller（6.22.x）onefile 生成
   `desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu`；
2. `cd desktop && npx tauri build --bundles deb,rpm`：其中的 `beforeBuildCommand` 先跑前端 `npm run build`，
   再编译 Rust 并生成 deb/rpm。

### 分步命令（排查时用）

```bash
cd /mnt/e/Project/translation/linux

# 1) Python 引擎 sidecar（必须先做；PyInstaller 已装于 venv）
bash scripts/build-sidecar.sh
ls -lh desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu

# 2) 前端依赖（首次）与 Tauri 打包
cd desktop
npm install
npx tauri build --bundles deb
npx tauri build --bundles rpm
```

> Rust 编译缓存：建议 `export CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build`（ext4，别放 9p 的 `/mnt/e`，否则极慢）。
> 打包是独占操作：同一时间不要并发跑其它 `cargo build` / `npm run build`。

---

## 4. 产物路径与命名

构建成功（`npx tauri build` 退出码 0）后：

| 产物 | 路径（相对 `desktop/src-tauri/`） | 命名规则 |
| --- | --- | --- |
| 主程序（未打包） | `target/release/simultaneous-translator` | Cargo 包名 |
| deb 安装包 | `target/release/bundle/deb/simultaneous-translator_<版本>_amd64.deb` | `<productName>_<version>_<arch>.deb` |
| rpm 安装包 | `target/release/bundle/rpm/simultaneous-translator-<版本>-1.x86_64.rpm` | `<name>-<version>-<release>.<arch>.rpm` |
| sidecar（中间产物） | `binaries/translator-bridge-x86_64-unknown-linux-gnu` | 不单独分发 |

> 实际文件名以构建输出为准（不同 Tauri CLI 小版本可能微调 rpm 的 `release` 段）。发布归档时按
> 契约 D10 的统一资产名复制/重命名：`simultaneous-translator_<版本>_amd64.deb`、`..._amd64.rpm`、
> `..._amd64.AppImage`，见 [`../docs/release.md`](../docs/release.md)。

---

## 5. 包内容验证

### 5.1 deb

```bash
bash packaging/verify-deb.sh \
  desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_1.0.2_amd64.deb
# 可选: --keep 保留解包目录；--no-sidecar-run 跳过启动自检
```

检查项（脚本输出 `[PASS]/[FAIL]/[SKIP]`，末尾汇总，任一 FAIL 退出码 1）：

| 编号 | 检查内容 |
| --- | --- |
| D01 | `dpkg-deb --info/--extract` 可解析 |
| D02 | 包元数据：Package / **Version=1.0.2** / Architecture=amd64 / Maintainer / Description / Installed-Size |
| D03 | Depends 覆盖 `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`（librsvg2 仅在 Requires 中出现时提示，非必需） |
| D04 | `/usr/bin/simultaneous-translator`：存在、可执行、ELF 64-bit x86-64、体积合理 |
| D05 | 主程序 `ldd` 无 `not found` |
| D06 | `/usr/bin/translator-bridge`：存在、可执行、ELF、>= 8MB、与主程序同目录 |
| D07 | `.desktop`：Type=Application、`Name=同传翻译`、`Name[zh_CN]=同传翻译`、Exec 指向主程序、Icon、Terminal=false |
| D08 | hicolor PNG 图标：>=2 个、含 32x32 与 128x128、实际尺寸与目录名一致 |
| D09 | `THIRD_PARTY_NOTICES.md` 已随包安装：Linux 版内容（含 PulseAudio/WebKitGTK），无 Windows VB-CABLE 章节 |
| D10 | 包体积合理（Installed-Size、解包体积 20MB–800MB） |
| D11 | **sidecar 启动自检**：`ready` 事件 → `ping.ok=true` → `shutdown.ok=true`、退出码 0 |
| D12 | 包内无 `../` 越界路径、无 `.git` / `node_modules` / `*.log` 残留 |

### 5.2 rpm

```bash
bash packaging/verify-rpm.sh \
  desktop/src-tauri/target/release/bundle/rpm/simultaneous-translator-1.0.2-1.x86_64.rpm
```

检查项与 deb 对应（R01–R10）：元数据、Requires、主程序、sidecar、`.desktop`、图标、
第三方声明、解包体积、sidecar 启动自检。Debian 系上**不安装** rpm，只做「元数据 + 解包 + 可执行性」验证。

### 5.3 安装冒烟（WSL / 测试机，可选但推荐）

```bash
# 记下现场，结束后复原
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
sudo dpkg -i desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_1.0.2_amd64.deb
which simultaneous-translator && ls -l /usr/bin/translator-bridge
update-desktop-database /usr/share/applications 2>/dev/null || true

timeout 15 xvfb-run -a dbus-run-session -- simultaneous-translator
# 退出码 124 = 15 秒后仍存活（未崩溃）→ 启动冒烟通过；退出码 1/其他 = 启动失败，看 stderr

sudo dpkg -r simultaneous-translator    # 卸载，确认无残留
dpkg -l | grep -c simultaneous-translator || true
```

> `dpkg -r` 不会删除用户配置（`~/.config/com.simultaneous-translator.desktop/`），这是正确行为。
> 正式人工验收见 [`../docs/qa/manual-checklist.md`](../docs/qa/manual-checklist.md)。

---

## 6. 可选：AppImage

契约 D11 规定 AppImage **默认不启用**（需要构建机联网下载 `linuxdeploy`）。需要时见
[`appimage.md`](appimage.md)，命令为：

```bash
cd desktop && npx tauri build --bundles appimage
```

---

## 7. 归档与发布

见 [`../docs/release.md`](../docs/release.md)。摘要：

```
releases/linux/v1.0.2/
├─ RELEASE_NOTES.md
├─ SHA256SUMS.txt                     # <sha256>  <文件名>，每行一个
├─ simultaneous-translator_1.0.2_amd64.deb
└─ simultaneous-translator_1.0.2_amd64.rpm
```

应用内「检查更新」按同一 GitHub Release 的 `SHA256SUMS.txt` 校验下载的 deb/rpm/AppImage。

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `failed to find external binary translator-bridge-x86_64-unknown-linux-gnu` | 没跑 `build-sidecar.sh`，或 sidecar 文件名没有目标三元组后缀 | 先 `bash scripts/build-sidecar.sh`；确认 `binaries/` 下文件名完全匹配 |
| 包能装、程序能开，开始同传报「已打包的翻译引擎缺失」 | sidecar 未打进包 / 与主程序不同目录 | 用 `verify-deb.sh` 的 D06 检查；重新 `scripts/build.sh` |
| `patchelf not found` / `failed to run patchelf` | 缺 `patchelf` | `sudo apt-get install patchelf` |
| `webkit2gtk-4.1 was not found` / `Package webkit2gtk-4.0 was not found` | 缺 4.1 开发包，或用了 22.04 | Ubuntu 24.04 安装 `libwebkit2gtk-4.1-dev` |
| `Found version mismatched Tauri packages: tauri (v2.x) : @tauri-apps/api (v2.y)` | Rust crate 与 npm 包版本线不一致 | 两者一起升降；不要单独 `cargo update tauri` |
| rpm 打包报 `rpmbuild` / `rpm` 相关错误 | Debian 系缺 rpm 工具 | `sudo apt-get install rpm` |
| AppImage 构建失败 `linuxdeploy` 下载超时 | 需联网下载 AppImage 工具链 | 见 `appimage.md` 的离线放置说明；或不做 AppImage |
| 打包时磁盘/9p 极慢 | `CARGO_TARGET_DIR` 指向了 `/mnt/e` | 指向 ext4：`/home/<user>/targets/tauri-build` |
| `tauri build` 在版本校验阶段退出，没执行前端构建 | 同「version mismatched」 | 同上 |
