#!/usr/bin/env bash
# 完整构建：Python 翻译引擎 sidecar + Tauri 前端/Rust + Linux 安装包。
#
# 默认打包 deb 与 rpm；AppImage 需要构建机联网下载 linuxdeploy，按需开启：
#   TAURI_BUNDLES=deb bash scripts/build.sh
#   TAURI_BUNDLES=appimage bash scripts/build.sh
#
# 用法（项目根目录或 desktop 目录均可）：
#   bash scripts/build.sh
#   cd desktop && npm run desktop:build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP_ROOT="$PROJECT_ROOT/desktop"
BUNDLES="${TAURI_BUNDLES:-deb,rpm}"

echo "== 同传翻译 Linux 版：完整构建 =="
echo "安装包类型：$BUNDLES"

if [[ -d "$HOME/.cargo/bin" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "错误：未找到 Rust 工具链（cargo）。请安装 rustup stable。" >&2
    exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
    echo "错误：未找到 Node.js/npx。请安装 Node.js 22.12 或更高版本。" >&2
    exit 1
fi

# 1) Python 引擎 sidecar（externalBin 要求先存在）。
bash "$SCRIPT_DIR/build-sidecar.sh"

# 2) 前端依赖（可重复执行 npm install 不会破坏已有安装）。
if [[ ! -d "$DESKTOP_ROOT/node_modules" ]]; then
    echo "安装前端依赖…"
    (cd "$DESKTOP_ROOT" && npm install)
fi

# 3) Tauri 构建（beforeBuildCommand 会执行 npm run build，sidecar 由 externalBin 打包）。
echo "构建 Tauri 应用…"
cd "$DESKTOP_ROOT"
npx tauri build --bundles "$BUNDLES"

echo
echo "构建完成。安装包位于："
find "$DESKTOP_ROOT/src-tauri/target/release/bundle" -maxdepth 2 -type f \
    \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -print 2>/dev/null || true
