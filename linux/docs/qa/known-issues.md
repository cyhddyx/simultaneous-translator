# Linux 已知问题 / 复现记录

> 维护者：build-verify（按 `windows/docs/qa/known-issues.md` 的规则改写为 Linux 版）。
> 规则：**只有能复现的才写进来**；每条给「复现步骤 / 证据 / 影响范围 / 是否阻塞 / 状态」。
> 归属：`PY` = Python 引擎，`RS` = Rust/Tauri，`FE` = 前端，`PKG` = 打包/发布，`ENV` = 环境/工具链，`QA` = 测试侧。
> 状态：`OPEN` / `ACCEPTED`（契约已裁决接受）/ `FIXED` / `WONTFIX`。
> 与 Windows 版重复的通用缺陷不重复记录，只记录 Linux 移植/平台特有项。

---

## KI-L01 WSLg PulseAudio 只能验证命令链路，不能替代真实桌面音频 — **ENV，ACCEPTED（已知限制）**

- **事实**：本机 WSLg 的 PulseAudio 只有虚拟 RDP 设备：
  ```
  default sink: RDPSink
  sinks  : 1  RDPSink   module-rdp-sink.c
  sources: 1  RDPSink.monitor / 2 RDPSource  module-rdp-*.c
  ```
  支持 `module-null-sink`、`module-loopback`、`module-remap-source`、`parec`（已实测加载/卸载/采集）。
- **限制**：无法验证真实声卡热插拔、会议软件（Zoom/Teams/Discord）选择虚拟麦克风、实际听感与回声。
- **处置**：自动化只覆盖「pactl/parec 命令链路 + 模块生命周期 + 帧参数」；真实设备与会议软件行为列入
  `manual-checklist.md` M-L01~M-L08（L9 人工）。
- **是否阻塞**：不阻塞构建/打包；阻塞「音频路由的最终验收结论」（需真实桌面）。
- **状态**：ACCEPTED

---

## KI-L02 headless / 无 Secret Service 时密钥不可持久化 — **ENV，ACCEPTED（按设计报错）**

- **现象**：WSL / 无 D-Bus session 的 headless 环境启动应用，保存 API Key 时提示密钥环错误。
- **复现**：`unset DBUS_SESSION_BUS_ADDRESS; ./simultaneous-translator` → 设置页保存密钥。
- **预期行为（契约 D6）**：给出明确错误，不静默丢密钥；保留 `DASHSCOPE_API_KEY` 等环境变量通道。
- **影响范围**：仅凭据持久化；翻译功能可用环境变量跑通。
- **是否阻塞**：不阻塞打包/冒烟；阻塞「设置页保存密钥」自动化。
- **状态**：ACCEPTED（产品按契约行为；真实桌面 GNOME Keyring/KWallet 需人工验证 M-K02）

---

## KI-L03 Wayland 下全局快捷键 / 置顶 / 无边框拖动受限 — **RS/平台，ACCEPTED（契约 D8/D9）**

- **事实**：Wayland 协议不允许应用无条件注册全局快捷键、跨应用置顶或自行移动窗口；由合成器决定。
- **预期行为**：逐项报告注册失败并提示需要 X11/合成器支持；不崩溃、不阻塞主流程；建议 X11 会话。
- **影响范围**：Wayland 会话的快捷键/置顶/拖动体验；不影响音频、字幕、翻译主流程。
- **是否阻塞**：否（契约明确接受）。
- **状态**：ACCEPTED（人工 M-14b/M-22b 记录实际桌面表现）

---

## KI-L04 无 AppIndicator 宿主时托盘不可用 → 降级为关闭即退出 — **RS/平台，ACCEPTED（契约 D7）**

- **现象**：裸 GNOME（未装 AppIndicator 扩展）或极简 WM 下没有托盘宿主，托盘图标不可见。
- **预期行为**：托盘创建失败只记录告警，不崩溃；行为降级为「关闭窗口即退出」并在设置页提示。
- **复现**：无 appindicator host 的会话启动应用 → 观察日志与关闭窗口行为。
- **影响范围**：托盘/菜单相关功能（A 组）不可用；主流程不受影响。
- **是否阻塞**：否（契约 D7）。
- **状态**：ACCEPTED（人工 M-08 在目标桌面记录实际行为）

---

## KI-L05 纯 PipeWire（无 `pipewire-pulse`）环境不保证可用 — **ENV，ACCEPTED（契约 §10）**

- **事实**：应用只用 `pactl` / `parec` 命令与 PulseAudio 对象模型；`pipewire-pulse` 提供兼容层，
  纯 PipeWire 且无该兼容层的发行版不保证可用。
- **处置**：文档如实说明（README/known limitations）；错误信息提示安装 `pipewire-pulse` 或 `pulseaudio-utils`。
- **是否阻塞**：否。
- **状态**：ACCEPTED（L9 人工在有 `pipewire-pulse` 的环境验证 M-L08）

---

## KI-L06 更新只做「检查 + 下载 + 校验 + 人工安装」，不自动提权 — **PKG，ACCEPTED（契约非目标）**

- **事实**：Linux 版不做自动提权安装（design decision，见 PORTING_CONTRACT §1 非目标）。
- **行为**：deb/rpm 下载后打开所在目录并提示用包管理器安装；AppImage 可写时替换并提示重启。
- **影响范围**：更新体验比 Windows 多一步人工确认；这是有意的安全取舍。
- **是否阻塞**：否。
- **状态**：ACCEPTED

---

## KI-L07 Tauri Rust crate 与 `@tauri-apps/api` 版本线必须同步 — **PKG/RS，已知风险（已缓解）**

- **现象**：`npx tauri build` 在版本校验阶段直接退出，前端构建都不执行：
  ```
  Found version mismatched Tauri packages:
  tauri (v2.x) : @tauri-apps/api (v2.y)
  ```
- **根因**：`tauri-plugin-*` 升级会抬高 `tauri` crate 的解析版本，而 npm 侧 `@tauri-apps/api` 未同步。
- **现缓解**：`tauri-plugin-global-shortcut` 用 `~2.3.2` 锁在 2.3.x 线（见 `Cargo.toml` 注释）；
  `Cargo.lock` 与 `desktop/package-lock.json` 提交锁定。
- **复现命令**：`cd linux/desktop && npx tauri build --bundles deb`（版本失配时立即失败）。
- **影响范围**：仅打包；不影响 `cargo build` / 开发 / 单测。
- **是否阻塞**：曾阻塞打包；当前已对齐，若未来升级依赖需一并升级并重跑打包。
- **状态**：ACCEPTED（持续风险，见 `docs/release.md` §2）

---

## KI-L08 PyInstaller onefile sidecar 体积大、首次启动需解压 — **PKG，已知（非缺陷）**

- **事实**：sidecar 为 PyInstaller onefile，内含 CPython + numpy/scipy/dashscope 等，
  体积约几十 MB；每次进程启动需解压到临时目录（首启数秒）。
- **影响**：安装包体积较大；首次「开始同传」等待时间比 Windows 开发模式长（有启动超时兜底 60s）。
- **处置**：不视为缺陷；`verify-deb.sh` 对 sidecar 体积做下限检查（>=8MB）防止空壳；
  启动冒烟允许较长 timeout。
- **是否阻塞**：否。
- **状态**：ACCEPTED（记录以免误判为「引擎卡死」）

---

## KI-L09 `npm install` 会改写 package-lock 的 optional 依赖 libc 元数据 — **ENV/PROC，WONTFIX**

- **现象**：Linux 上执行 `npm install` 后 `package-lock.json` 出现大量行级 diff（`libc` 字段被删/改），
  但 `dependencies` 版本未变化。
- **原因**：npm 对 optional platform 依赖元数据的规范化差异；不是依赖变更。
- **处置**：以仓库基线 lock 为准；最终构建不改 lock；构建后如有无意义 diff 恢复基线即可。
- **是否阻塞**：否。
- **状态**：WONTFIX（工具链行为）

---

## KI-L10 `/mnt/e`（9p）上构建极慢 — **ENV，WONTFIX（已知）**

- **现象**：`CARGO_TARGET_DIR` 指向 `/mnt/e/...` 时 Rust 构建/打包耗时数倍增长，磁盘 IO 抖动。
- **处置**：`CARGO_TARGET_DIR` 放 ext4（如 `/home/<user>/targets/tauri-build`）；
  `node_modules` 保留在 9p 也可接受（npm 安装 36s 量级）。
- **是否阻塞**：否。
- **状态**：WONTFIX（环境约束，已写入 `docs/build.md`）

---

## KI-L11 待补充：本轮验证实际发现项

> 规则：本节的每条必须来自本轮实测（Python/前端/Rust/打包/冒烟），带命令与可复核输出。
> 若全部通过则保留一行「本轮自动化项无新增缺陷」。

- **状态**：待验证流水线完成后填写（见 `artifacts/logs/linux-verification.md`）

---

## 缺陷统计

| ID | 标题 | 阻塞? | 状态 |
| --- | --- | --- | --- |
| KI-L01 | WSLg 音频只能验证命令链路 | 阻塞最终音频验收（非构建） | ACCEPTED |
| KI-L02 | headless 无 Secret Service | 否 | ACCEPTED |
| KI-L03 | Wayland 快捷键/置顶受限 | 否 | ACCEPTED |
| KI-L04 | 无 AppIndicator 宿主降级 | 否 | ACCEPTED |
| KI-L05 | 纯 PipeWire 不保证 | 否 | ACCEPTED |
| KI-L06 | 更新不自动提权 | 否 | ACCEPTED |
| KI-L07 | Tauri 版本线耦合 | 曾阻塞打包（已缓解） | ACCEPTED（持续风险） |
| KI-L08 | sidecar onefile 体积/首启延迟 | 否 | ACCEPTED |
| KI-L09 | npm lock libc 元数据 diff | 否 | WONTFIX |
| KI-L10 | 9p 构建慢 | 否 | WONTFIX |
| KI-L11 | 本轮实测新增项 | 待定 | 待填 |

> 本文件不含推测的问题。每条都有复现命令或可复核输出。
> 「阻塞」仅指阻塞 QA 给出该验收项的结论，不等于产品不可发布。
