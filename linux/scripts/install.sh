#!/usr/bin/env bash
# 开发环境安装：创建 linux/.venv、安装 Python 依赖，并检查 PulseAudio 运行时工具。
#
# 用法：
#   bash scripts/install.sh
#   TRANSLATOR_VENV=/path/to/venv bash scripts/install.sh   # 使用已有环境
#
# 可重复执行：已存在的虚拟环境会复用，依赖按 requirements.txt 更新。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_PATH="${TRANSLATOR_VENV:-$PROJECT_ROOT/.venv}"
PYTHON_BIN="${TRANSLATOR_SYSTEM_PYTHON:-python3}"

echo "== 同传翻译 Linux 版：Python 引擎环境安装 =="
echo "项目目录：$PROJECT_ROOT"
echo "虚拟环境：$VENV_PATH"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "错误：未找到 $PYTHON_BIN，请先安装 Python 3.10 或更高版本。" >&2
    exit 1
fi

if [[ ! -x "$VENV_PATH/bin/python" ]]; then
    echo "创建虚拟环境…"
    "$PYTHON_BIN" -m venv "$VENV_PATH"
fi

"$VENV_PATH/bin/python" -m pip install --upgrade pip
"$VENV_PATH/bin/python" -m pip install -r "$PROJECT_ROOT/requirements.txt"

# 系统声音采集依赖 PulseAudio/PipeWire 的命令行工具；缺失时只警告，
# 因为纯麦克风模式仍然可用。
missing_tools=()
for tool in pactl parec; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        missing_tools+=("$tool")
    fi
done
if (( ${#missing_tools[@]} > 0 )); then
    echo "警告：未找到 ${missing_tools[*]}。" >&2
    echo "      系统声音采集与音频设备枚举需要 pulseaudio-utils（或 pipewire-pulse）：" >&2
    echo "      Debian/Ubuntu: sudo apt install pulseaudio-utils" >&2
    echo "      Fedora:        sudo dnf install pulseaudio-utils" >&2
    echo "      Arch:          sudo pacman -S libpulse" >&2
else
    echo "PulseAudio 工具检查通过：pactl / parec"
fi

# soundcard 通过 libpulse 访问音频设备；缺少时 Python 导入会直接失败。
if ! "$VENV_PATH/bin/python" -c "import soundcard" check 2>/dev/null; then
    echo "警告：soundcard 无法连接音频服务（libpulse 或 PulseAudio/PipeWire 未就绪）。" >&2
    echo "      安装 libpulse-dev / libpulse0 并确认用户会话里有 PulseAudio/PipeWire。" >&2
fi

echo
echo "安装完成。"
echo "  开发启动：bash scripts/dev.sh            （或 cd desktop && npm run desktop:dev）"
echo "  完整构建：bash scripts/build.sh          （或 cd desktop && npm run desktop:build）"
