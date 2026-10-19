# Linux 安装包（deb / rpm）验证记录

> 维护者：build-verify。适用版本 **1.0.2**。
> 状态口径：`通过 / 失败 / 跳过（原因）/ 未验证`。未实测一律写「未验证」，不按构建日志推测安装版行为。
> 关联：[`README.md`](../../packaging/README.md)（打包说明）、[`../../docs/testing.md`](../../testing.md)（测试）、
> `artifacts/logs/linux-verification.md`（完整流水线日志）。

---

## 0. 前置

| 项 | 值 |
| --- | --- |
| 构建命令 | `cd linux && bash scripts/build.sh`（= sidecar + 前端 + `npx tauri build --bundles deb,rpm`） |
| 执行者 | **build-verify（本任务唯一最终构建执行者）** |
| 构建时间 | 待填 |
| 受测源码 | 待填（各 owner 完成信号后的最终源码） |
| sidecar | `desktop/src-tauri/binaries/translator-bridge-x86_64-unknown-linux-gnu`，大小见 §1 |
| 构建环境 | WSL2 Ubuntu 24.04.3 / rustc 1.99.1 / node 24.14.0 / CARGO_TARGET_DIR=/home/cyh26/targets/tauri-build |

> 追溯三元组：**源码冻结时间点 + 产物哈希（见 §2/§3）+ SHA256SUMS**。
> 构建是排他操作；构建期间不运行其它 `cargo build` / `npm run build`。

---

## 1. 构建产物

| # | 检查项 | 判据 | 实测 |
| --- | --- | --- | --- |
| P-01 | `npx tauri build --bundles deb` | exit 0，无 error | 待填 |
| P-02 | deb 路径 | 记录实际路径 | 待填 |
| P-03 | 文件名与版本 | 文件名含 `1.0.2`、`amd64` | 待填 |
| P-04 | deb 体积 | 记录并与 sidecar 体积对照 | 待填 |
| P-05 | `npx tauri build --bundles rpm` | exit 0，产出 `.rpm` | 待填 |
| P-06 | sidecar 已生成且被打包 | 文件存在、大小合理、包内 `/usr/bin/translator-bridge` | 待填 |
| P-07 | 前端已重建 | `desktop/dist/` 时间戳晚于前端源码冻结 | 待填 |
| P-08 | 版本号三处一致 | package.json / Cargo.toml / tauri.conf.json = 1.0.2 | 待填 |

---

## 2. deb 内容验证（`packaging/verify-deb.sh`）

```bash
bash linux/packaging/verify-deb.sh <deb 路径>
```

| # | 检查项 | 结果 |
| --- | --- | --- |
| D01 | dpkg-deb 可解析/解包 | 待填 |
| D02 | 元数据 Package/Version/Architecture/Maintainer/Description/Installed-Size | 待填 |
| D03 | Depends 覆盖 webkit2gtk-4.1/gtk3/librsvg2/appindicator | 待填 |
| D04 | 主程序 `/usr/bin/simultaneous-translator`（ELF x86-64、体积） | 待填 |
| D05 | 主程序 `ldd` 无 missing | 待填 |
| D06 | sidecar `/usr/bin/translator-bridge`（ELF、体积、同目录） | 待填 |
| D07 | `.desktop`（中文 Name、Exec、Icon、Terminal=false） | 待填 |
| D08 | hicolor 图标（32x32/128x128、尺寸一致） | 待填 |
| D09 | `THIRD_PARTY_NOTICES.md` 随包、无 VB-CABLE 残留 | 待填 |
| D10 | 包体积合理 | 待填 |
| D11 | sidecar 启动自检（ready → ping.ok → shutdown.ok） | 待填 |
| D12 | 路径卫生（无 `../`、无开发残留） | 待填 |

**汇总**：`PASS=待填 FAIL=待填 SKIP=待填`；完整输出见 `artifacts/logs/verify-deb.log`。

### 2.1 包内容清单（关键路径）

| 路径 | 说明 |
| --- | --- |
| `/usr/bin/simultaneous-translator` | 主程序 |
| `/usr/bin/translator-bridge` | Python 引擎 sidecar（与主程序同目录） |
| `/usr/share/applications/*.desktop` | 桌面入口（中文显示名） |
| `/usr/share/icons/hicolor/*/apps/*.png` | 图标 |
| `/usr/lib/<product>/*` 或资源目录 | `THIRD_PARTY_NOTICES.md` |

（构建后粘贴 `dpkg-deb -c` 的关键行。）

---

## 3. rpm 内容验证（`packaging/verify-rpm.sh`）

```bash
bash linux/packaging/verify-rpm.sh <rpm 路径>
```

| # | 检查项 | 结果 |
| --- | --- | --- |
| R01 | rpm 可解析/解包 | 待填 |
| R02 | 元数据 Name/Version/Release/Arch | 待填 |
| R03 | Requires 覆盖 webkit2gtk/gtk3/librsvg/appindicator | 待填 |
| R04 | 主程序 | 待填 |
| R05 | sidecar | 待填 |
| R06 | `.desktop`（中文 Name/Exec/Terminal） | 待填 |
| R07 | 图标 | 待填 |
| R08 | `THIRD_PARTY_NOTICES.md` | 待填 |
| R09 | 解包体积合理 | 待填 |
| R10 | sidecar 启动自检 | 待填 |

**汇总**：`PASS=待填 FAIL=待填 SKIP=待填`；完整输出见 `artifacts/logs/verify-rpm.log`。

> Debian 系上**不安装** rpm（只验证元数据+解包+可执行性）；rpm 的真实安装需 Fedora/openSUSE 环境（人工 M-P02）。

---

## 4. 安装冒烟（L8，WSL，root）

| # | 检查项 | 判据 | 实测 |
| --- | --- | --- | --- |
| P-10 | `dpkg -i` 安装 | exit 0 | 待填 |
| P-11 | 安装布局 | `/usr/bin/simultaneous-translator` 与 `/usr/bin/translator-bridge` 均存在 | 待填 |
| P-12 | 启动冒烟 | `timeout 15 xvfb-run -a dbus-run-session -- simultaneous-translator` → exit 124（未崩溃） | 待填 |
| P-13 | 无残留进程 | 冒烟后无 `translator-bridge`/`simultaneous-translator` 进程 | 待填 |
| P-14 | `dpkg -r` 卸载 | exit 0 | 待填 |
| P-15 | 卸载后文件清理 | `/usr/bin` 两文件删除；用户配置保留（正确行为） | 待填 |

---

## 5. 已知限制与未验证面

| 项 | 说明 |
| --- | --- |
| 托盘/快捷键/置顶 | 需真实桌面（L9 人工清单 M-01~M-22、M-32） |
| 真实音频路由 | WSLg 只能验证 `pactl`/`parec` 命令链路；真实声卡/会议软件需人工（M-L01~M-L08） |
| rpm 安装 | 需 Fedora/openSUSE 环境（M-P02） |
| AppImage | 默认不构建（可选，见 `packaging/appimage.md`） |
| 更新下载校验 | 需已发布的 Release 资产（M-P05） |
| 签名 | deb/rpm 未签名（与 Windows 一致，非本次引入） |

---

## 6. 结论

| 维度 | 结论 |
| --- | --- |
| deb 构建与内容 | 待填 |
| rpm 构建与内容 | 待填 |
| 安装/卸载冒烟 | 待填 |
| 版本与命名 | 待填 |
| 遗留风险 | 待填 |

> 本文件只记录可复核的事实；构建日志中的「看起来正常」不作为安装版行为的证据。
