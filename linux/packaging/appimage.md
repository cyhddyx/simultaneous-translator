# 可选：AppImage 构建说明

> Owner：build-verify。**默认不启用**（契约 D11）。deb/rpm 是正式发行格式；AppImage 仅作为便携版补充。
> 启用前请确认构建机可联网下载 linuxdeploy 工具链。

## 1. 为什么默认不启用

- AppImage 需要 Tauri 在打包时下载 `linuxdeploy`（AppImage 形式）与 AppImage runtime，**构建机必须联网**；
- 运行 AppImage 需要 FUSE（Ubuntu 24.04 默认不装 `libfuse2`，可用 `--appimage-extract` 变通）；
- 应用内更新对 AppImage 是「提示 + 人工替换」，不像 deb/rpm 走系统包管理器；
- CI/内网环境更容易卡在工具链下载上，deb/rpm 已覆盖 Ubuntu/Debian/Fedora 系发行版用户。

## 2. 构建命令

```bash
cd /mnt/e/Project/translation/linux/desktop

# 仅 AppImage
npx tauri build --bundles appimage

# 一次产出 deb + rpm + AppImage
npx tauri build --bundles deb,rpm,appimage
```

产物（以实际输出为准）：

```
desktop/src-tauri/target/release/bundle/appimage/simultaneous-translator_<版本>_amd64.AppImage
```

> 注意：`package.json` / `tauri.conf.json` 的 `bundle.targets` 默认是 `["deb","rpm"]`；
> 用 `--bundles appimage` 命令行参数即可临时覆盖，不需要改配置（也不要为一次性构建改配置）。

## 3. 工具链与网络

Tauri v2 的 AppImage 打包会在需要时把 `linuxdeploy` 下载到缓存目录（通常是 `~/.cache/tauri/`）。
若网络受限，可手工准备：

```bash
mkdir -p ~/.cache/tauri
# 从 https://github.com/linuxdeploy/linuxdeploy/releases 下载 linuxdeploy-x86_64.AppImage
# 以及 AppImage runtime（appimagetool 会用到，Tauri 也会自动下载）
cp linuxdeploy-x86_64.AppImage ~/.cache/tauri/linuxdeploy-x86_64.AppImage
chmod +x ~/.cache/tauri/linuxdeploy-x86_64.AppImage
```

若 linuxdeploy 是用 `--appimage-extract` 解包使用的环境，需保证 FUSE 不可用时也能运行
（先在宿主上 `sudo apt-get install libfuse2` 或使用解包目录）。

## 4. 验证

```bash
cd /mnt/e/Project/translation/linux/desktop
APP=src-tauri/target/release/bundle/appimage/simultaneous-translator_1.0.2_amd64.AppImage
ls -lh "$APP"
file "$APP"                 # 应为 ELF 64-bit executable（AppImage）
chmod +x "$APP"

# 方式 1：直接运行（需要 libfuse2）
timeout 15 xvfb-run -a dbus-run-session -- "$APP"
# 退出码 124 = 15 秒后仍存活 → 启动冒烟通过

# 方式 2：无 FUSE 时解包运行（验证内容）
"$APP" --appimage-extract >/dev/null
./squashfs-root/AppRun --x11 2>/dev/null &   # 或直接检查 squashfs-root/usr/bin/*
```

检查点：
- 安装包内包含 `usr/bin/simultaneous-translator` 与 `usr/bin/translator-bridge`（两者同目录）；
- 不含 `translator-bridge-x86_64-unknown-linux-gnu` 这类带三元组后缀的冗余文件；
- 体积与 deb 解包体积量级相当（PyInstaller onefile 占大头）。

## 5. 归档命名

发布归档与更新检查统一使用契约 D10 的资产名：

```
releases/linux/v1.0.2/simultaneous-translator_1.0.2_amd64.AppImage
```

若 Tauri 产物名已是该形式，直接复制；否则复制时重命名（内容不变），并在 `SHA256SUMS.txt`
中使用重命名后的文件名。

## 6. 已知限制

- AppImage 不含桌面集成（图标/菜单）安装步骤，需要用户手工创建 `.desktop` 或使用 AppImageLauncher；
- 更新流程对 AppImage 是「下载 → SHA256 校验 → 提示替换当前文件并重启」，不自动提权、不自动覆盖；
- Wayland 下部分行为（全局快捷键/置顶）仍受合成器限制，与 deb/rpm 一致。
