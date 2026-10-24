#!/usr/bin/env bash
# verify-rpm.sh — Linux .rpm 包的「结构 + 依赖 + 可运行性」验证
#
# 维护者: build-verify
# 适用:   Ubuntu 24.04（rpm / rpm2cpio / cpio 已装），WSL2 可运行
#         Debian 系只做「元数据 + 解包内容 + 可执行性」验证，不用 rpm 安装（避免与 dpkg 混用）。
#
# 用法:
#   bash linux/packaging/verify-rpm.sh <path/to/xxx.rpm> [--keep] [--no-sidecar-run]
#
# 环境变量:
#   EXPECTED_VERSION   期望版本号，默认 1.0.2
#
# 退出码:
#   0 = 全部检查通过（允许 SKIP）
#   1 = 至少一项 FAIL
#   2 = 用法错误 / 文件不存在
#
# 检查项:
#   R01 rpm 可解析
#   R02 元数据 Name/Version/Release/Architecture
#   R03 Requires 覆盖 WebKitGTK / GTK3 / librsvg2 / appindicator
#   R04 主程序 /usr/bin/simultaneous-translator
#   R05 sidecar /usr/bin/translator-bridge
#   R06 .desktop（含中文 Name）
#   R07 hicolor 图标
#   R08 THIRD_PARTY_NOTICES.md
#   R09 解包体积合理
#   R10 sidecar 启动自检（ready → ping → shutdown）

set -euo pipefail

EXPECTED_VERSION="${EXPECTED_VERSION:-1.0.2}"
RUN_SIDECAR=1
KEEP=0
RPM=""

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-sidecar-run) RUN_SIDECAR=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "未知选项: $arg" >&2; exit 2 ;;
    *) RPM="$arg" ;;
  esac
done

if [ -z "$RPM" ] || [ ! -f "$RPM" ]; then
  echo "用法: bash packaging/verify-rpm.sh <path/to/xxx.rpm> [--keep] [--no-sidecar-run]" >&2
  exit 2
fi

for tool in rpm rpm2cpio cpio file; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少工具: $tool（apt-get install rpm cpio）" >&2; exit 2; }
done

TMP="$(mktemp -d -t verify-rpm.XXXXXX)"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then echo "解包目录（保留）: $TMP/root"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

PASS=0; FAIL=0; SKIP=0
declare -a FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILURES+=("$*"); printf '  [FAIL] %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  [SKIP] %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }

ROOT="$TMP/root"
mkdir -p "$ROOT"
echo "=================================================================="
echo " rpm 验证: $(basename "$RPM")"
echo " 期望: version=$EXPECTED_VERSION"
echo "=================================================================="

# ---------- R01 可解析 ----------
echo
echo "R01 rpm 可解析"
if ! rpm -qip "$RPM" >"$TMP/info.txt" 2>"$TMP/info.err"; then
  bad "rpm -qip 失败: $(tail -2 "$TMP/info.err" | tr '\n' ' ')"
  echo; echo "== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP =="; exit 1
fi
ok "rpm -qip 成功"
# rpm 4.18.2 的 rpm2cpio 在本环境会输出完整 cpio 流后仍返回 1；
# 以 cpio 是否能完整解包为准，不把 rpm2cpio 的退出码单独当失败。
rpm2cpio "$RPM" >"$TMP/payload.cpio" 2>"$TMP/cpio.err" || true
if [ ! -s "$TMP/payload.cpio" ]; then
  bad "解包失败: rpm2cpio 未输出数据: $(tail -2 "$TMP/cpio.err" | tr '\n' ' ')"
  echo; echo "== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP =="; exit 1
fi
if ( cd "$ROOT" && cpio -idm --quiet <"$TMP/payload.cpio" 2>>"$TMP/cpio.err" ); then
  ok "rpm2cpio | cpio 解包成功"
else
  bad "解包失败: $(tail -2 "$TMP/cpio.err" | tr '\n' ' ')"
  echo; echo "== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP =="; exit 1
fi

# ---------- R02 元数据 ----------
echo
echo "R02 元数据"
rpm_name="$(rpm -qp --qf '%{NAME}' "$RPM" 2>/dev/null || true)"
rpm_ver="$(rpm -qp --qf '%{VERSION}' "$RPM" 2>/dev/null || true)"
rpm_rel="$(rpm -qp --qf '%{RELEASE}' "$RPM" 2>/dev/null || true)"
rpm_arch="$(rpm -qp --qf '%{ARCH}' "$RPM" 2>/dev/null || true)"
info "Name=$rpm_name Version=$rpm_ver Release=$rpm_rel Arch=$rpm_arch"
[ -n "$rpm_name" ] && ok "Name 非空: $rpm_name" || bad "Name 为空"
[ "$rpm_ver" = "$EXPECTED_VERSION" ] && ok "Version == $EXPECTED_VERSION" || bad "Version 期望 $EXPECTED_VERSION，实际 '$rpm_ver'"
[ "$rpm_arch" = "x86_64" ] && ok "Architecture == x86_64" || bad "Architecture 期望 x86_64，实际 '$rpm_arch'"

# ---------- R03 Requires ----------
echo
echo "R03 运行时依赖（Requires）"
rpm -qpR "$RPM" >"$TMP/requires.txt" 2>/dev/null || true
info "Requires: $(tr '\n' ' ' <"$TMP/requires.txt" | head -c 800)"
req_text="$(tr '[:upper:]' '[:lower:]' <"$TMP/requires.txt")"
for pair in "webkit2gtk:WebKitGTK" "gtk-3:GTK3" "appindicator:appindicator"; do
  pattern="${pair%%:*}"; label="${pair#*:}"
  if printf '%s' "$req_text" | grep -Fq "$pattern"; then ok "Requires 含 $label"; else
    bad "Requires 缺 $label（模式 $pattern）"; fi
done
if printf '%s' "$req_text" | grep -Fq 'rsvg'; then
  info "Requires 含 librsvg（可选；Tauri v2 运行时不强制）"
else
  info "Requires 未含 librsvg（正常：Tauri v2 运行时使用 PNG 图标）"
fi

# ---------- R04 主程序 ----------
echo
echo "R04 主程序"
MAIN="$ROOT/usr/bin/simultaneous-translator"
if [ -f "$MAIN" ]; then
  ok "存在 $MAIN"
  [ -x "$MAIN" ] && ok "主程序可执行" || bad "主程序不可执行"
  main_info="$(file -b "$MAIN")"; info "file: $main_info"
  printf '%s' "$main_info" | grep -q 'ELF 64-bit LSB' && ok "ELF 64-bit" || bad "非 ELF 64-bit"
  main_size="$(stat -c%s "$MAIN")"
  info "大小: $(numfmt --to=iec "$main_size")（$main_size B）"
  [ "$main_size" -ge 5000000 ] && ok "体积合理（>= 5MB）" || bad "体积偏小（${main_size} B）"
else
  bad "缺少主程序（usr/bin: $(ls -1 "$ROOT/usr/bin" 2>/dev/null | tr '\n' ' ')）"
fi

# ---------- R05 sidecar ----------
echo
echo "R05 翻译引擎 sidecar"
SIDECAR="$ROOT/usr/bin/translator-bridge"
if [ -f "$SIDECAR" ]; then
  ok "存在 $SIDECAR"
  [ -x "$SIDECAR" ] && ok "sidecar 可执行" || bad "sidecar 不可执行"
  side_info="$(file -b "$SIDECAR")"; info "file: $side_info"
  printf '%s' "$side_info" | grep -q 'ELF 64-bit LSB' && ok "ELF 64-bit" || bad "非 ELF 64-bit"
  side_size="$(stat -c%s "$SIDECAR")"
  info "大小: $(numfmt --to=iec "$side_size")（$side_size B）"
  [ "$side_size" -ge 8000000 ] && ok "体积合理（>= 8MB）" || bad "体积偏小（${side_size} B）"
else
  bad "缺少 sidecar（usr/bin: $(ls -1 "$ROOT/usr/bin" 2>/dev/null | tr '\n' ' ')）"
fi

# ---------- R06 .desktop ----------
echo
echo "R06 桌面入口"
mapfile -t DESKTOPS < <(find "$ROOT/usr/share/applications" -maxdepth 1 -name '*.desktop' -type f 2>/dev/null | sort)
if [ "${#DESKTOPS[@]}" -eq 1 ]; then
  ok "恰好 1 个 .desktop: ${DESKTOPS[0]#"$ROOT"}"
  dcontent="$(tr -d '\r' <"${DESKTOPS[0]}")"
  printf '%s' "$dcontent" | grep -q '^Name=同传翻译' && ok "Name=同传翻译" || bad "缺 Name=同传翻译"
  printf '%s' "$dcontent" | grep -Fq 'Name[zh_CN]=同传翻译' && ok "Name[zh_CN]=同传翻译" || bad "缺 Name[zh_CN]=同传翻译"
  printf '%s' "$dcontent" | grep -qE '^Exec=.*simultaneous-translator' && ok "Exec 指向主程序" || bad "Exec 未指向主程序"
  printf '%s' "$dcontent" | grep -q '^Terminal=false' && ok "Terminal=false" || bad "缺 Terminal=false"
else
  bad "期望恰好 1 个 .desktop，实际 ${#DESKTOPS[@]} 个"
fi

# ---------- R07 图标 ----------
echo
echo "R07 图标"
mapfile -t ICONS < <(find "$ROOT/usr/share/icons/hicolor" -path '*/apps/*.png' -type f 2>/dev/null | sort)
if [ "${#ICONS[@]}" -ge 2 ]; then
  ok "共 ${#ICONS[@]} 个 PNG 图标"
  declare -A ICON_SIZES=()
  for icon in "${ICONS[@]}"; do
    rel="${icon#"$ROOT"}"
    dirsize="$(printf '%s' "$rel" | sed -n 's|.*/hicolor/\([0-9]*x[0-9]*\)/.*|\1|p')"
    dims="$(file -b "$icon" | sed -n 's/.*PNG image data, \([0-9]*\) x \([0-9]*\).*/\1x\2/p')"
    if [ -n "$dims" ]; then ICON_SIZES["$dims"]=1; fi
    if [ -n "$dirsize" ] && [ -n "$dims" ] && [ "$dims" != "$dirsize" ]; then
      bad "图标尺寸与目录不一致: $rel（文件 ${dims}）"
    fi
  done
  for need in 32x32 128x128; do
    [ -n "${ICON_SIZES[$need]:-}" ] && ok "存在 ${need} 图标" || bad "缺 ${need} 图标"
  done
else
  bad "hicolor PNG 图标不足 2 个（实际 ${#ICONS[@]} 个）"
fi

# ---------- R08 THIRD_PARTY_NOTICES ----------
echo
echo "R08 第三方声明"
mapfile -t NOTICES < <(find "$ROOT/usr" -name 'THIRD_PARTY_NOTICES.md' -type f 2>/dev/null | sort)
if [ "${#NOTICES[@]}" -ge 1 ]; then
  nsize="$(stat -c%s "${NOTICES[0]}")"
  ok "已安装 ${NOTICES[0]#"$ROOT"}（${nsize} B）"
  if grep -q '^# Optional VB-CABLE Component' "${NOTICES[0]}"; then
    bad "声明仍含 Windows VB-CABLE 章节（应已按 Linux 重写）"
  elif grep -q 'PulseAudio' "${NOTICES[0]}" && grep -q 'WebKitGTK' "${NOTICES[0]}"; then
    ok "声明为 Linux 版（含 PulseAudio/WebKitGTK，无 VB-CABLE 章节）"
  else
    bad "声明缺少 Linux 相关内容（PulseAudio/WebKitGTK）"
  fi
else
  bad "包内未找到 THIRD_PARTY_NOTICES.md"
fi

# ---------- R09 体积 ----------
echo
echo "R09 解包体积"
extract_bytes="$(du -sb "$ROOT" | awk '{print $1}')"
info "解包体积: $(numfmt --to=iec "$extract_bytes")（$extract_bytes B）"
if [ "$extract_bytes" -ge 20000000 ] && [ "$extract_bytes" -le 800000000 ]; then
  ok "解包体积在合理区间（20MB–800MB）"
else
  bad "解包体积异常: $extract_bytes B"
fi

# ---------- R10 sidecar 自检 ----------
echo
echo "R10 sidecar 启动自检"
if [ "$RUN_SIDECAR" -eq 0 ]; then
  skip "按 --no-sidecar-run 跳过"
elif [ ! -f "$SIDECAR" ] || [ ! -x "$SIDECAR" ]; then
  skip "sidecar 不可执行，跳过"
elif [ "$(uname -m)" != "x86_64" ]; then
  skip "宿主非 x86_64，跳过"
else
  set +e
  printf '%s\n%s\n' \
    '{"id":"ping-1","command":"ping","params":{}}' \
    '{"id":"shutdown-1","command":"shutdown","params":{}}' \
    | timeout 120 "$SIDECAR" >"$TMP/sidecar.out" 2>"$TMP/sidecar.err"
  side_rc=$?
  set -e
  info "sidecar 退出码: $side_rc"
  if [ "$side_rc" -ne 0 ]; then
    bad "sidecar 自检退出码 $side_rc；stderr: $(tail -c 300 "$TMP/sidecar.err" | tr '\n' ' ')"
  else
    if grep -q '"event":"ready"' "$TMP/sidecar.out" \
      && grep -q '"id":"ping-1","ok":true' "$TMP/sidecar.out" \
      && grep -q '"id":"shutdown-1","ok":true' "$TMP/sidecar.out"; then
      ok "sidecar 自检通过：ready + ping.ok + shutdown.ok，退出码 0"
    else
      bad "sidecar 自检断言失败；stdout 尾部: $(tail -c 300 "$TMP/sidecar.out" | tr '\n' ' ')"
    fi
  fi
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
