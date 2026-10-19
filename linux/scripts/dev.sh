#!/usr/bin/env bash
# 开发模式启动 Tauri 桌面版。
#
# Rust 主进程在开发模式下直接运行 scripts/tauri_bridge.py；本脚本把
# TRANSLATOR_PYTHON 指向 linux/.venv（PORTING_CONTRACT §4.4），并自动
# 为 WSLg 补上 PULSE_SERVER。
#
# 用法（项目根目录或 desktop 目录均可）：
#   bash scripts/dev.sh
#   cd desktop && npm run desktop:dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP_ROOT="$PROJECT_ROOT/desktop"
PYTHON="${TRANSLATOR_PYTHON:-$PROJECT_ROOT/.venv/bin/python}"

echo "== 同传翻译 Linux 版：开发模式 =="

if [[ ! -x "$PYTHON" ]]; then
    echo "错误：未找到开发用 Python 引擎（$PYTHON）。请先运行 scripts/install.sh。" >&2
    exit 1
fi
if [[ ! -f "$SCRIPT_DIR/tauri_bridge.py" ]]; then
    echo "错误：缺少 scripts/tauri_bridge.py。" >&2
    exit 1
fi

# Rust 侧用这个变量覆盖开发模式的解释器路径（契约 §4.4）。
export TRANSLATOR_PYTHON="$PYTHON"

# WSLg 不把 PulseAudio 套接字导出到默认位置；桌面 Linux 不需要这一步。
if [[ -z "${PULSE_SERVER:-}" && -S /mnt/wslg/PulseServer ]]; then
    export PULSE_SERVER="unix:/mnt/wslg/PulseServer"
    echo "检测到 WSLg，使用 PULSE_SERVER=$PULSE_SERVER"
fi

# rustup 安装的 cargo 不在非登录 shell 的 PATH 里。
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

if [[ ! -d "$DESKTOP_ROOT/node_modules" ]]; then
    echo "安装前端依赖…"
    (cd "$DESKTOP_ROOT" && npm install)
fi

echo "启动 Tauri 开发模式（Ctrl+C 退出）…"
cd "$DESKTOP_ROOT"
exec npx tauri dev
