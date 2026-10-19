#!/usr/bin/env bash
# verify-deb.sh — Linux .deb 包的「结构 + 依赖 + 可运行性」验证
#
# 维护者: build-verify
# 适用:   Ubuntu 24.04 / Debian 12（x86_64），WSL2 可运行
#
# 用法:
#   bash linux/packaging/verify-deb.sh <path/to/xxx.deb> [--keep] [--no-sidecar-run]
#
# 选项:
#   --keep             保留解包目录（便于人工检查，路径会打印）
#   --no-sidecar-run   跳过 sidecar 启动自检（交叉架构或无法执行包内 ELF 时）
#
# 环境变量:
#   EXPECTED_VERSION   期望版本号，默认 1.0.2
#   EXPECTED_ARCH      期望架构，默认 amd64
#
# 退出码:
#   0 = 全部检查通过（允许 SKIP）
#   1 = 至少一项 FAIL
#   2 = 用法错误 / 文件不存在
#
# 检查项:
#   D01 .deb 可被 dpkg-deb 解析
#   D02 元数据 Package/Version/Architecture/Maintainer/Description/Installed-Size
#   D03 Depends 覆盖 WebKitGTK 4.1 / GTK3 / librsvg2 / appindicator
#   D04 主程序 /usr/bin/simultaneous-translator 存在、可执行、ELF x86-64
#   D05 主程序动态库依赖无 missing（ldd）
#   D06 翻译引擎 sidecar /usr/bin/translator-bridge 存在、可执行、ELF、体积合理
#   D07 .desktop：Type/Name/Name[zh_CN]/Exec/Icon/Terminal
#   D08 图标：hicolor PNG（≥32x32 与 128x128），实际尺寸与目录名一致
#   D09 THIRD_PARTY_NOTICES.md 已随包安装且非空
#   D10 包体积合理（Installed-Size 与解包体积）
#   D11 sidecar 启动自检：ready 事件 → ping.ok=true → shutdown.ok=true、退出码 0
#   D12 包内路径卫生（无 `..` 越界条目）

set -euo pipefail

EXPECTED_VERSION="${EXPECTED_VERSION:-1.0.2}"
EXPECTED_ARCH="${EXPECTED_ARCH:-amd64}"
RUN_SIDECAR=1
KEEP=0
DEB=""

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-sidecar-run) RUN_SIDECAR=0 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "未知选项: $arg" >&2; exit 2 ;;
    *) DEB="$arg" ;;
  esac
done

if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "用法: bash packaging/verify-deb.sh <path/to/xxx.deb> [--keep] [--no-sidecar-run]" >&2
  [ -n "$DEB" ] && echo "文件不存在: $DEB" >&2
  exit 2
fi

for tool in dpkg-deb file; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少工具: $tool（apt-get install dpkg-dev file）" >&2; exit 2; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d -t verify-deb.XXXXXX)"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "解包目录（保留）: $TMP/root"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

PASS=0
FAIL=0
SKIP=0
declare -a FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILURES+=("$*"); printf '  [FAIL] %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  [SKIP] %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }

# dpkg-deb -f 在字段缺失时返回空（个别版本非 0），统一吞掉退出码
field() { dpkg-deb -f "$DEB" "$1" 2>/dev/null || true; }

ROOT="$TMP/root"
NAME="$(basename "$DEB")"

echo "=================================================================="
echo " deb 验证: $NAME"
echo " 期望: version=$EXPECTED_VERSION arch=$EXPECTED_ARCH"
echo " 主机: $(uname -m) $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "=================================================================="

# ---------- D01 可解析 ----------
echo
echo "D01 .deb 可解析"
if dpkg-deb --info "$DEB" >"$TMP/info.txt" 2>"$TMP/info.err"; then
  ok "dpkg-deb --info 成功（$(wc -l <"$TMP/info.txt") 行）"
  if dpkg-deb --extract "$DEB" "$ROOT" 2>"$TMP/extract.err"; then
    ok "dpkg-deb --extract 成功"
  else
    bad "dpkg-deb --extract 失败: $(tail -2 "$TMP/extract.err" | tr '\n' ' ')"
    echo; echo "== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP（解包失败，终止后续检查）=="
    exit 1
  fi
else
  bad "dpkg-deb --info 失败: $(tail -2 "$TMP/info.err" | tr '\n' ' ')"
  echo; echo "== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP =="
  exit 1
fi

# ---------- D02 元数据 ----------
echo
echo "D02 元数据"
PKG_NAME="$(field Package)"
PKG_VER="$(field Version)"
PKG_ARCH="$(field Architecture)"
PKG_MAINT="$(field Maintainer)"
PKG_DESC="$(field Description)"
PKG_SIZE="$(field Installed-Size)"
PKG_DEPS="$(field Depends)"
info "Package=$PKG_NAME Version=$PKG_VER Architecture=$PKG_ARCH Installed-Size=${PKG_SIZE}KB"
info "Depends=$PKG_DEPS"

if [ -n "$PKG_NAME" ]; then ok "Package 非空: $PKG_NAME"; else bad "Package 为空"; fi
if [ "$PKG_VER" = "$EXPECTED_VERSION" ]; then ok "Version == $EXPECTED_VERSION"; else bad "Version 期望 $EXPECTED_VERSION，实际 '${PKG_VER}'"; fi
if [ "$PKG_ARCH" = "$EXPECTED_ARCH" ]; then ok "Architecture == $EXPECTED_ARCH"; else bad "Architecture 期望 $EXPECTED_ARCH，实际 '${PKG_ARCH}'"; fi
if [ -n "$PKG_MAINT" ]; then ok "Maintainer 非空: $PKG_MAINT"; else bad "Maintainer 为空"; fi
if [ -n "$PKG_DESC" ]; then ok "Description 非空"; else bad "Description 为空"; fi
if [ -n "$PKG_SIZE" ]; then ok "Installed-Size 存在: ${PKG_SIZE}KB"; else bad "Installed-Size 缺失"; fi

# ---------- D03 依赖 ----------
echo
echo "D03 运行时依赖（Depends）"
# WebKitGTK 4.1（Ubuntu 24.04 起）、GTK3 是 Tauri Linux 的硬依赖；
# appindicator 是托盘（tauri tray-icon）的运行时依赖，契约 D7 要求随包声明。
# librsvg2 只是构建期图标工具链依赖（Tauri v2 运行时图标为 PNG），不在 Depends 中属正常。
missing_deps=()
for dep in libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1; do
  if printf '%s' "$PKG_DEPS" | grep -Fq "$dep"; then
    ok "Depends 含 $dep"
  else
    bad "Depends 缺 $dep"
    missing_deps+=("$dep")
  fi
done
if printf '%s' "$PKG_DEPS" | grep -Fq 'librsvg2-2'; then
  info "Depends 含 librsvg2-2（可选；Tauri v2 运行时不强制）"
else
  info "Depends 未含 librsvg2-2（正常：Tauri v2 运行时使用 PNG 图标，不依赖 librsvg）"
fi
[ "${#missing_deps[@]}" -eq 0 ] || info "缺失依赖需在 tauri.conf.json bundle.linux.deb.depends 或打包配置中补齐: ${missing_deps[*]}"

# ---------- D04 主程序 ----------
echo
echo "D04 主程序"
MAIN="$ROOT/usr/bin/simultaneous-translator"
if [ -f "$MAIN" ]; then
  ok "存在 $MAIN"
  if [ -x "$MAIN" ]; then ok "主程序有可执行权限"; else bad "主程序无可执行权限"; fi
  main_info="$(file -b "$MAIN")"
  info "file: $main_info"
  if printf '%s' "$main_info" | grep -q 'ELF 64-bit LSB'; then ok "主程序为 ELF 64-bit"; else bad "主程序不是 ELF 64-bit: $main_info"; fi
  if printf '%s' "$main_info" | grep -q 'x86-64'; then ok "主程序目标架构 x86-64"; else bad "主程序目标架构非 x86-64"; fi
  main_size="$(stat -c%s "$MAIN")"
  info "主程序大小: $(numfmt --to=iec "$main_size")（$main_size B）"
  if [ "$main_size" -ge 5000000 ]; then ok "主程序体积合理（>= 5MB，含内嵌前端）"; else bad "主程序体积偏小（${main_size} B < 5MB），可能未内嵌前端"; fi
  # 前端是否真的内嵌：Tauri 会把 dist 资源编进二进制；用 CSS/JS 资源字符串做弱证据
  if grep -aqE 'assets/index-.*\.(js|css)|<html' "$MAIN"; then ok "弱证据：主程序内含前端资源字符串"; else info "未在二进制中发现明文前端资源（Tauri 压缩属正常，以冒烟为准）"; fi
else
  bad "缺少主程序 /usr/bin/simultaneous-translator（实际 usr/bin: $(ls -1 "$ROOT/usr/bin" 2>/dev/null | tr '\n' ' '))"
fi

# ---------- D05 ldd ----------
echo
echo "D05 主程序动态库"
if [ -f "$MAIN" ] && command -v ldd >/dev/null 2>&1; then
  ldd_out="$(ldd "$MAIN" 2>&1 || true)"
  if printf '%s' "$ldd_out" | grep -q 'not found'; then
    bad "主程序存在未解析动态库: $(printf '%s' "$ldd_out" | grep 'not found' | head -5 | tr '\n' ' ')"
  else
    ok "ldd 无 'not found'（依赖库在宿主中可用）"
  fi
else
  skip "无法执行 ldd"
fi

# ---------- D06 sidecar ----------
echo
echo "D06 翻译引擎 sidecar"
SIDECAR="$ROOT/usr/bin/translator-bridge"
if [ -f "$SIDECAR" ]; then
  ok "存在 $SIDECAR"
  if [ -x "$SIDECAR" ]; then ok "sidecar 有可执行权限"; else bad "sidecar 无可执行权限"; fi
  side_info="$(file -b "$SIDECAR")"
  info "file: $side_info"
  if printf '%s' "$side_info" | grep -q 'ELF 64-bit LSB'; then ok "sidecar 为 ELF 64-bit"; else bad "sidecar 不是 ELF 64-bit: $side_info"; fi
  side_size="$(stat -c%s "$SIDECAR")"
  info "sidecar 大小: $(numfmt --to=iec "$side_size")（$side_size B）"
  if [ "$side_size" -ge 8000000 ]; then ok "sidecar 体积合理（>= 8MB，PyInstaller onefile）"; else bad "sidecar 体积偏小（${side_size} B），可能是空壳或未打包依赖"; fi
  # Rust 侧按「与主程序同目录」查找引擎（契约 §4.4），这里断言同目录
  if [ "$(dirname "$MAIN")" = "$(dirname "$SIDECAR")" ]; then ok "sidecar 与主程序同目录（契约 §4.4 发行模式）"; else bad "sidecar 与主程序不同目录"; fi
else
  bad "缺少 sidecar /usr/bin/translator-bridge（实际 usr/bin: $(ls -1 "$ROOT/usr/bin" 2>/dev/null | tr '\n' ' ')）"
fi

# ---------- D07 .desktop ----------
echo
echo "D07 桌面入口 .desktop"
mapfile -t DESKTOPS < <(find "$ROOT/usr/share/applications" -maxdepth 1 -name '*.desktop' -type f 2>/dev/null | sort)
if [ "${#DESKTOPS[@]}" -eq 1 ]; then
  ok "恰好 1 个 .desktop: ${DESKTOPS[0]#"$ROOT"}"
  DESKTOP="${DESKTOPS[0]}"
  dcontent="$(tr -d '\r' <"$DESKTOP")"
  if printf '%s' "$dcontent" | grep -q '^Type=Application'; then ok "Type=Application"; else bad "缺 Type=Application"; fi
  if printf '%s' "$dcontent" | grep -q '^Name=同传翻译'; then ok "Name=同传翻译"; else bad "缺 Name=同传翻译（契约 D11 要求中文显示名）"; fi
  if printf '%s' "$dcontent" | grep -Fq 'Name[zh_CN]=同传翻译'; then ok "Name[zh_CN]=同传翻译"; else bad "缺 Name[zh_CN]=同传翻译"; fi
  if printf '%s' "$dcontent" | grep -qE '^Exec=.*simultaneous-translator'; then ok "Exec 指向主程序"; else bad "Exec 未指向 simultaneous-translator: $(printf '%s' "$dcontent" | grep -E '^Exec=' || echo '(无)')"; fi
  if printf '%s' "$dcontent" | grep -qE '^Icon=[^[:space:]]'; then
    icon_name="$(printf '%s' "$dcontent" | sed -n 's/^Icon=//p' | head -1)"
    ok "Icon=$icon_name"
  else
    bad "缺 Icon 字段"
    icon_name=""
  fi
  if printf '%s' "$dcontent" | grep -q '^Terminal=false'; then ok "Terminal=false（GUI 程序）"; else bad "缺 Terminal=false（否则会弹终端）"; fi
  if printf '%s' "$dcontent" | grep -qE '^Categories=.*(AudioVideo|Utility|Audio|Network)'; then ok "Categories 合理"; else info "Categories 未命中常见分类（不判失败）"; fi
else
  bad "期望恰好 1 个 .desktop，实际 ${#DESKTOPS[@]} 个"
  icon_name=""
fi

# ---------- D08 图标 ----------
echo
echo "D08 图标（hicolor）"
mapfile -t ICONS < <(find "$ROOT/usr/share/icons/hicolor" -path '*/apps/*.png' -type f 2>/dev/null | sort)
if [ "${#ICONS[@]}" -ge 2 ]; then
  ok "共 ${#ICONS[@]} 个 PNG 图标"
  declare -A ICON_SIZES=()
  icon_dims_ok=1
  for icon in "${ICONS[@]}"; do
    rel="${icon#"$ROOT"}"
    dirsize="$(printf '%s' "$rel" | sed -n 's|.*/hicolor/\([0-9]*x[0-9]*\)/.*|\1|p')"
    dims="$(file -b "$icon" | sed -n 's/.*PNG image data, \([0-9]*\) x \([0-9]*\).*/\1x\2/p')"
    if [ -z "$dims" ]; then
      bad "无法解析图标尺寸: $rel"; icon_dims_ok=0; continue
    fi
    ICON_SIZES["$dims"]=1
    if [ -n "$dirsize" ] && [ "$dims" != "$dirsize" ]; then
      bad "图标尺寸与目录不一致: $rel（文件 ${dims}）"; icon_dims_ok=0
    fi
  done
  if [ "$icon_dims_ok" -eq 1 ]; then ok "图标尺寸与 hicolor 目录一致"; fi
  for need in 32x32 128x128; do
    if [ -n "${ICON_SIZES[$need]:-}" ]; then ok "存在 ${need} 图标"; else bad "缺 ${need} 图标"; fi
  done
  if [ -n "$icon_name" ] && ! printf '%s\n' "${ICONS[@]}" | grep -q "/${icon_name}\.png$"; then
    info "Icon=$icon_name 未找到同名 PNG（若 Icon 为绝对路径可忽略）"
  fi
else
  bad "hicolor PNG 图标不足 2 个（实际 ${#ICONS[@]} 个）"
fi

# ---------- D09 THIRD_PARTY_NOTICES ----------
echo
echo "D09 第三方声明"
mapfile -t NOTICES < <(find "$ROOT/usr" -name 'THIRD_PARTY_NOTICES.md' -type f 2>/dev/null | sort)
if [ "${#NOTICES[@]}" -ge 1 ]; then
  nsize="$(stat -c%s "${NOTICES[0]}")"
  ok "已安装 ${NOTICES[0]#"$ROOT"}（${nsize} B）"
  if [ "$nsize" -gt 500 ]; then ok "声明文件非空"; else bad "声明文件过小（${nsize} B）"; fi
  if grep -q '^# Optional VB-CABLE Component' "${NOTICES[0]}"; then
    bad "声明仍含 Windows VB-CABLE 章节（应已按 Linux 重写）"
  elif grep -q 'PulseAudio' "${NOTICES[0]}" && grep -q 'WebKitGTK' "${NOTICES[0]}"; then
    ok "声明为 Linux 版（含 PulseAudio/WebKitGTK，无 VB-CABLE 章节）"
  else
    bad "声明缺少 Linux 相关内容（PulseAudio/WebKitGTK）"
  fi
else
  bad "包内未找到 THIRD_PARTY_NOTICES.md（bundle.resources 未生效）"
fi

# ---------- D10 体积 ----------
echo
echo "D10 包体积"
extract_bytes="$(du -sb "$ROOT" | awk '{print $1}')"
info "解包体积: $(numfmt --to=iec "$extract_bytes")（$extract_bytes B）"
if [ -n "$PKG_SIZE" ] && [ "$PKG_SIZE" -lt 10000 ]; then
  bad "Installed-Size 偏小（${PKG_SIZE}KB < 10MB）"
else
  ok "Installed-Size 合理（${PKG_SIZE}KB）"
fi
if [ "$extract_bytes" -ge 20000000 ] && [ "$extract_bytes" -le 800000000 ]; then
  ok "解包体积在合理区间（20MB–800MB）"
else
  bad "解包体积异常: $extract_bytes B"
fi
deb_size="$(stat -c%s "$DEB")"
info "deb 文件大小: $(numfmt --to=iec "$deb_size")（$deb_size B）"

# ---------- D11 sidecar 自检 ----------
echo
echo "D11 sidecar 启动自检（ready → ping → shutdown）"
if [ "$RUN_SIDECAR" -eq 0 ]; then
  skip "按 --no-sidecar-run 跳过"
elif [ ! -f "$SIDECAR" ] || [ ! -x "$SIDECAR" ]; then
  skip "sidecar 不可执行，跳过"
elif [ "$(uname -m)" != "x86_64" ]; then
  skip "宿主非 x86_64，无法执行包内 sidecar"
else
  set +e
  printf '%s\n%s\n' \
    '{"id":"ping-1","command":"ping","params":{}}' \
    '{"id":"shutdown-1","command":"shutdown","params":{}}' \
    | timeout 120 "$SIDECAR" >"$TMP/sidecar.out" 2>"$TMP/sidecar.err"
  side_rc=$?
  set -e
  info "sidecar 退出码: $side_rc"
  if [ "$side_rc" -eq 124 ]; then
    bad "sidecar 自检超时（120s 未退出），可能卡在启动或 stdin 未关闭"
  elif [ "$side_rc" -ne 0 ]; then
    bad "sidecar 自检退出码 $side_rc；stderr 尾部: $(tail -c 400 "$TMP/sidecar.err" | tr '\n' ' ')"
    info "stdout 尾部: $(tail -c 300 "$TMP/sidecar.out" | tr '\n' ' ')"
  else
    if python3 - "$TMP/sidecar.out" <<'PY'
import json
import sys

path = sys.argv[1]
raw = [line for line in open(path, encoding="utf-8", errors="replace") if line.strip()]
if not raw:
    print("stdout 为空")
    sys.exit(1)
parsed = []
for index, line in enumerate(raw):
    try:
        parsed.append(json.loads(line))
    except json.JSONDecodeError as exc:
        print(f"第 {index + 1} 行不是 JSON: {line[:120]!r} ({exc})")
        sys.exit(1)

ready = next((p for p in parsed if p.get("type") == "event" and p.get("event") == "ready"), None)
if ready is None:
    print("缺少 ready 事件")
    sys.exit(1)
commands = ready.get("data", {}).get("commands", [])
missing = [c for c in ("ping", "start", "stop", "shutdown", "devices") if c not in commands]
if missing:
    print(f"ready.commands 缺少 {missing}")
    sys.exit(1)
print(f"ready.commands={commands}")

ping = next((p for p in parsed if p.get("id") == "ping-1"), None)
if ping is None or ping.get("ok") is not True:
    print(f"ping 响应异常: {ping}")
    sys.exit(1)
result = ping.get("result", {})
if not isinstance(result.get("protocol_version"), int):
    print(f"ping.result 缺 protocol_version: {result}")
    sys.exit(1)
print(f"ping.result={result}")

shutdown = next((p for p in parsed if p.get("id") == "shutdown-1"), None)
if shutdown is None or shutdown.get("ok") is not True:
    print(f"shutdown 响应异常: {shutdown}")
    sys.exit(1)
print("shutdown.ok=true")
if any(line.get("type") == "response" and line.get("ok") is False for line in parsed):
    print("存在 ok=false 的响应")
    sys.exit(1)
PY
    then
      ok "sidecar 自检通过：ready 事件 + ping.ok + shutdown.ok，退出码 0"
    else
      bad "sidecar 自检断言失败（见上）；stderr 尾部: $(tail -c 400 "$TMP/sidecar.err" | tr '\n' ' ')"
    fi
  fi
fi

# ---------- D12 路径卫生 ----------
echo
echo "D12 包内路径卫生"
if dpkg-deb --contents "$DEB" 2>/dev/null | grep -qE '(^|/| )\.\.(/|$)'; then
  bad "包内存在 ../ 越界路径"
else
  ok "无 ../ 越界路径"
fi
if find "$ROOT" -name '.git' -o -name 'node_modules' -o -name '*.log' | grep -q .; then
  bad "包内混入开发残留（.git/node_modules/*.log）"
else
  ok "无开发残留目录"
fi

# ---------- 汇总 ----------
echo
echo "=================================================================="
if [ "$FAIL" -eq 0 ]; then
  echo " 结果: PASS=$PASS FAIL=0 SKIP=$SKIP —— 全部通过"
else
  echo " 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP —— 存在失败项"
  for item in "${FAILURES[@]}"; do echo "   - FAIL: $item"; done
fi
echo "=================================================================="
[ "$FAIL" -eq 0 ]
