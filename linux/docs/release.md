# Linux 发布流程

> Owner：build-verify。适用 Linux 版 **1.0.2**。
> 相关文档：[`../packaging/README.md`](../packaging/README.md)（打包细节）、[`build.md`](build.md)（构建环境）、[`testing.md`](testing.md)（验证）、[`qa/packaging.md`](qa/packaging.md)（打包验证记录）。

---

## 1. 发布物一览

| 资产（GitHub Release 附件名） | 内容 | 必需 |
| --- | --- | --- |
| `simultaneous-translator_<版本>_linux_amd64.deb` | Ubuntu/Debian 安装包 | 是 |
| `simultaneous-translator_<版本>_linux_amd64.rpm` | Fedora/openSUSE 安装包 | 是 |
| `SHA256SUMS.txt` | 校验文件，每行 `<64位SHA-256>  <文件名>` | 是 |
| `simultaneous-translator_<版本>_linux_amd64.AppImage` | 便携版 | 可选（默认不构建） |
| `RELEASE_NOTES.md` | 发布说明正文 | 是（工作区归档） |

应用内「设置 → 软件更新」按同一 GitHub Release 的 `SHA256SUMS.txt` 校验下载文件
（Linux 资产匹配规则见契约 D10）。

---

## 2. 版本号同步（三处，缺一不可）

| 文件 | 字段 | 1.0.2 示例 |
| --- | --- | --- |
| `linux/desktop/package.json` | `"version"` | `"1.0.2"` |
| `linux/desktop/src-tauri/Cargo.toml` | `[package] version` | `version = "1.0.2"` |
| `linux/desktop/src-tauri/tauri.conf.json` | `"version"` | `"1.0.2"` |

改完 `Cargo.toml` 后需要让 `Cargo.lock` 重新解析（`cargo check` 会自动更新 lock；只改版本号时是本包自身的
version 字段，lock 中 `name = "simultaneous-translator"` 的 version 同步）。**三处不一致会导致
`tauri build` 版本校验失败或产物文件名与内容不一致。**

> 版本号只升一次：`1.0.2` 是 Linux 首个正式版，与 Windows v1.0.2 功能对等。

---

## 3. 发布前检查清单

```text
[ ] 1. 三处版本号一致；Cargo.lock 已更新并提交
[ ] 2. windows/ 未被修改（只读基线）
[ ] 3. 工作树干净（无未提交的调试改动、无 target/dist/node_modules/binaries 误入库）
[ ] 4. Linux 验证流水线全绿（见 testing.md；结果写 artifacts/logs/linux-verification.md）
[ ] 5. sidecar 已重新构建（改过 scripts/*.py 就必须重跑）
[ ] 6. npx tauri build --bundles deb 与 --bundles rpm 均退出码 0
[ ] 7. verify-deb.sh / verify-rpm.sh 全部 PASS（FAIL=0）
[ ] 8. 安装冒烟通过（dpkg -i + xvfb-run 启动；退出码 124 视为未崩溃）
[ ] 9. 产物归档到 releases/linux/v<版本>/ 并生成 SHA256SUMS.txt
[ ] 10. RELEASE_NOTES.md 按模板填写（packaging/release-notes-template.md）
[ ] 11. GitHub Release 上传 4 个资产；检查 Release 标签 v<版本>
[ ] 12. 校验：下载回来的资产 SHA256 与 SHA256SUMS.txt 一致
```

---

## 4. 构建

```bash
cd /mnt/e/Project/translation/linux
export CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build   # WSL 参考环境
bash scripts/build.sh                                     # sidecar + 前端 + deb + rpm
```

或分步：

```bash
bash scripts/build-sidecar.sh
cd desktop
npx tauri build --bundles deb
npx tauri build --bundles rpm
```

产物路径（Tauri 打包器原名，发布前按 §6 重命名）：

```
linux/desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_<版本>_amd64.deb
linux/desktop/src-tauri/target/release/bundle/rpm/simultaneous-translator-<版本>-1.x86_64.rpm
```

> 打包是**排他操作**：不要与其他 `cargo build` / `npm run build` / `tauri build` 并发。
> 构建日志保存到 `artifacts/logs/`（含退出码与关键输出），便于追溯。

---

## 5. 验证

```bash
cd /mnt/e/Project/translation/linux
bash packaging/verify-deb.sh \
  desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_1.0.2_amd64.deb
bash packaging/verify-rpm.sh \
  desktop/src-tauri/target/release/bundle/rpm/simultaneous-translator-1.0.2-1.x86_64.rpm
```

要求：两份都输出 `FAIL=0`（允许 SKIP，例如宿主非 x86_64 时的 sidecar 自检）。

安装冒烟（WSL/测试机，可回滚）：

```bash
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
sudo dpkg -i desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_1.0.2_amd64.deb
timeout 15 xvfb-run -a dbus-run-session -- simultaneous-translator
# 退出码 124 = 15s 后仍存活（未崩溃）；0/1 = 进程自行退出，需查 stderr
sudo dpkg -r simultaneous-translator
```

完整测试矩阵见 [`testing.md`](testing.md)；人工验收见 [`qa/manual-checklist.md`](qa/manual-checklist.md)。

---

## 6. 归档（工作区）

```bash
cd /mnt/e/Project/translation
VER=1.0.2
mkdir -p releases/linux/v$VER
DEB=linux/desktop/src-tauri/target/release/bundle/deb/simultaneous-translator_${VER}_amd64.deb
RPM=$(ls linux/desktop/src-tauri/target/release/bundle/rpm/*.rpm | head -1)

cp "$DEB" releases/linux/v$VER/simultaneous-translator_${VER}_linux_amd64.deb
cp "$RPM" releases/linux/v$VER/simultaneous-translator_${VER}_linux_amd64.rpm

cd releases/linux/v$VER
sha256sum simultaneous-translator_${VER}_linux_amd64.deb \
          simultaneous-translator_${VER}_linux_amd64.rpm > SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

目录结构：

```
releases/linux/
├─ README.md                       # Linux 产物说明（与 windows/README.md 对应）
└─ v1.0.2/
   ├─ RELEASE_NOTES.md
   ├─ SHA256SUMS.txt
   ├─ simultaneous-translator_1.0.2_linux_amd64.deb
   └─ simultaneous-translator_1.0.2_linux_amd64.rpm
```

**命名强制统一**：GitHub 资产名、`SHA256SUMS.txt` 中的文件名、应用内更新下载匹配名三者必须一致
（契约 D10）。Tauri 产出的 rpm 文件名可能带 `-1` release 段，归档/上传时**重命名**为
`simultaneous-translator_<版本>_linux_amd64.rpm`（内容不变，SHA 按重命名后的文件计算）。

---

## 7. GitHub Release 上传

```bash
# 前提：本地工作区不是 git 仓库时，用 gh release upload 指定仓库
TAG=v1.0.2
gh release create "$TAG" \
  releases/linux/v1.0.2/simultaneous-translator_1.0.2_linux_amd64.deb \
  releases/linux/v1.0.2/simultaneous-translator_1.0.2_linux_amd64.rpm \
  releases/linux/v1.0.2/SHA256SUMS.txt \
  --repo cyhddyx/simultaneous-translator \
  --title "同传翻译 1.0.2（Linux）" \
  --notes-file releases/linux/v1.0.2/RELEASE_NOTES.md

# 或追加到已有 Release
gh release upload "$TAG" <文件...> --repo cyhddyx/simultaneous-translator
```

上传后自检：

```bash
gh release view "$TAG" --repo cyhddyx/simultaneous-translator --json assets \
  --jq '.assets[].name'
# 期望含上面 3–4 个资产名，且与 SHA256SUMS.txt 中文件名逐字一致
```

---

## 8. 应用内更新（Linux 行为）

- 检查：GitHub Releases API，包含 beta 预发布版本；版本号比较规则与 Windows 一致。
- 下载：按当前架构匹配 `simultaneous-translator_<版本>_linux_amd64.deb` / `.rpm` / `.AppImage`；
  下载后核对同一 Release 的 `SHA256SUMS.txt`，大小或 SHA-256 不符则阻止安装。
- 安装：**不自动提权**。deb/rpm 下载后打开所在目录并提示用户用系统包管理器安装；
  AppImage 若可写则替换当前文件并提示重启。
- 失败：仅更新页显示错误，不中断同传，不误报「已是最新版本」。

> 发布时务必上传 `SHA256SUMS.txt`，否则应用内下载校验会失败。

---

## 9. 发布失败 / 回滚

| 场景 | 处理 |
| --- | --- |
| 构建失败（退出码非 0） | 看 `artifacts/logs/` 中构建日志；修复后重跑完整构建（不要用旧的中间产物拼包） |
| 验证脚本 FAIL | 按 FAIL 项修复（常见：sidecar 缺失/版本不符/desktop 模板未替换/依赖缺 appindicator） |
| 安装冒烟崩溃 | 保留 stderr/backtrace；对比开发模式；确认为打包问题时检查 WebKit/依赖库版本 |
| 已上传 Release 有问题 | 删除该 Release 与 tag，修复后重新打 tag；**不要**用同一版本号覆盖上传不同内容的资产（供应链可追溯性） |
| 用户升级后回退 | 保留上一版本安装包；deb/rpm 可直接安装旧版；设置与凭据格式向后兼容，无需清理 |

---

## 10. 与 Windows 发布流程的差异

| 项 | Windows | Linux |
| --- | --- | --- |
| 安装包工具 | NSIS（Tauri 内置） | deb/rpm（Tauri 内置；AppImage 需联网工具链） |
| 签名 | 未签名（SmartScreen 提示） | 未签名；deb/rpm 由用户系统包管理器安装，无 SmartScreen 类拦截 |
| 版本校验失败点 | Tauri crate vs npm API | 同（两者共用依赖版本线） |
| 更新安装 | 静默/交互式安装器 | 打开下载目录，人工安装；不自动提权 |
| 产物归档 | `releases/windows/<版本>/` | `releases/linux/<版本>/` |
