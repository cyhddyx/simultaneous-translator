#!/usr/bin/env bash
# 生成 Tauri 外部二进制（Python 翻译引擎 sidecar）。
#
# 产物：
#   desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu
# 由 tauri.conf.json 的 externalBin 在打包时复制为安装目录下的 translator-bridge。
#
# 用法：
#   bash scripts/build-sidecar.sh
#   TRANSLATOR_PYTHON=/path/to/python bash scripts/build-sidecar.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP_ROOT="$PROJECT_ROOT/desktop"
PYTHON="${TRANSLATOR_PYTHON:-$PROJECT_ROOT/.venv/bin/python}"
BRIDGE_PATH="$SCRIPT_DIR/tauri_bridge.py"
LANGUAGES_PATH="$SCRIPT_DIR/translation_languages.json"
OUTPUT_DIR="$DESKTOP_ROOT/src-tauri/binaries"
BUILD_ROOT="$PROJECT_ROOT/.tauri-sidecar-build"
PYINSTALLER_VERSION="6.22.3"

# Tauri 按目标三元组查找 externalBin，Linux x86_64 为 x86_64-unknown-linux-gnu。
TARGET_TRIPLE="${TAURI_TARGET_TRIPLE:-$(uname -m)-unknown-linux-gnu}"

echo "== 构建 Python 翻译引擎 sidecar =="
echo "解释器：$PYTHON"
echo "目标架构：$TARGET_TRIPLE"

if [[ ! -x "$PYTHON" ]]; then
    echo "错误：未找到 Python 解释器 $PYTHON。请先运行 scripts/install.sh。" >&2
    exit 1
fi
if [[ ! -f "$BRIDGE_PATH" ]]; then
    echo "错误：缺少 scripts/tauri_bridge.py。" >&2
    exit 1
fi
if [[ ! -f "$LANGUAGES_PATH" ]]; then
    echo "错误：缺少 scripts/translation_languages.json。" >&2
    exit 1
fi

# PyInstaller 只在构建时需要，安装到同一个虚拟环境里（与 Windows 构建脚本一致）。
if ! "$PYTHON" -c "import PyInstaller" >/dev/null 2>&1; then
    echo "安装 PyInstaller $PYINSTALLER_VERSION…"
    "$PYTHON" -m pip install "pyinstaller==$PYINSTALLER_VERSION"
fi

mkdir -p "$OUTPUT_DIR" "$BUILD_ROOT"

"$PYTHON" -m PyInstaller \
    --noconfirm \
    --clean \
    --onefile \
    --console \
    --name "translator-bridge" \
    --distpath "$BUILD_ROOT/dist" \
    --workpath "$BUILD_ROOT/work" \
    --specpath "$BUILD_ROOT" \
    --hidden-import dashscope.audio.asr \
    --hidden-import soundcard.pulseaudio \
    --hidden-import websockets.asyncio.client \
    --hidden-import websockets.asyncio.server \
    --add-data "$LANGUAGES_PATH:." \
    "$BRIDGE_PATH"

BUILT_BRIDGE="$BUILD_ROOT/dist/translator-bridge"
TARGET_BRIDGE="$OUTPUT_DIR/translator-bridge-$TARGET_TRIPLE"
if [[ ! -f "$BUILT_BRIDGE" ]]; then
    echo "错误：PyInstaller 没有生成 translator-bridge。" >&2
    exit 1
fi

install -m 0755 "$BUILT_BRIDGE" "$TARGET_BRIDGE"
echo "sidecar 已生成：$TARGET_BRIDGE"
