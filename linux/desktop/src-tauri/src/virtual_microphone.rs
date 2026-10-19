//! Linux 虚拟麦克风：用 PulseAudio（或 PipeWire 的 `pipewire-pulse` 兼容层）
//! 内置模块实现，不需要安装任何驱动。
//!
//! 组成与固定命名见 `docs/linux-audio-routing.md` §4：
//!
//! * `translator_mic`：`module-null-sink`，译文语音的播放落点；
//! * `translator_mic_source`：`module-remap-source`，把 `translator_mic.monitor`
//!   重新发布成一个普通 source，会议软件（Zoom/Teams/Discord/浏览器）在麦克风
//!   列表里看到的是 **Translator Virtual Microphone**。
//!
//! `install_virtual_microphone` 的语义是「创建 / 确保」：已存在直接成功，残缺或
//! 重复的残留先清理再重建；不依赖引擎运行，也不做提权。

use std::{
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

/// 译文语音的落点（null sink），会议软件通过它的 monitor 取声。
const MIC_SINK: &str = "translator_mic";
/// 会议软件里显示为麦克风的 remap source。
const MIC_SOURCE: &str = "translator_mic_source";
const MIC_SINK_DESCRIPTION: &str = "TranslatorVirtualMicrophoneSink";
/// 会议软件里显示的设备名。`pactl` 的模块参数按 ASCII 空格切分字段，无法用
/// 引号包住带空格的 description，因此用不换行空格（U+00A0）分隔单词：显示效果
/// 与普通空格一致，但整段 `source_properties=...` 仍是单个参数（契约 D4 修正）。
const MIC_SOURCE_DESCRIPTION: &str = "Translator\u{a0}Virtual\u{a0}Microphone";
/// Linux 使用说明（虚拟麦克风一节在「虚拟麦克风（发言通道译文 → 会议软件）」）。
const HELP_URL: &str =
    "https://github.com/cyhddyx/simultaneous-translator/blob/main/linux/docs/linux-audio-routing.md";
const RELEASES_URL: &str = "https://github.com/cyhddyx/simultaneous-translator/releases";
const PACTL: &str = "pactl";
/// `pactl` 只在音频服务不可达时才会卡住；给一个短超时，避免退出流程被拖死。
const PACTL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DETAIL_CHARS: usize = 400;

#[derive(Default)]
pub struct InstallerState(Arc<Mutex<()>>);

// --------------------------------------------------------------------------- //
// pactl 调用
// --------------------------------------------------------------------------- //

fn run_pactl(args: &[String]) -> Result<Output, String> {
    run_tool(PACTL, args, PACTL_TIMEOUT)
}

fn run_tool(program: &str, args: &[String], timeout: Duration) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!(
                "未找到 PulseAudio 工具（{program}），请安装 pulseaudio-utils 或 pipewire-pulse"
            ),
            _ => format!("无法启动 {program}：{error}"),
        })?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program} 执行超时，请检查 PulseAudio / PipeWire 是否正在运行"
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法读取 {program} 执行状态：{error}"));
            }
        }
    }
    child
        .wait_with_output()
        .map_err(|error| format!("无法读取 {program} 输出：{error}"))
}

fn pactl_stdout(args: &[String]) -> Result<String, String> {
    let output = run_pactl(args)?;
    if !output.status.success() {
        return Err(pactl_failure(args, &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn pactl_failure(args: &[String], output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    };
    let detail = tail_chars(&detail, MAX_DETAIL_CHARS);
    let operation = args.first().map(String::as_str).unwrap_or_default();
    if detail.is_empty() {
        format!(
            "pactl {operation} 执行失败（退出码 {:?}），请确认 PulseAudio / PipeWire 正在运行",
            output.status.code()
        )
    } else {
        format!("pactl {operation} 执行失败：{detail}")
    }
}

fn tail_chars(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    text.chars().skip(count - limit).collect()
}

fn load_module(arguments: Vec<String>) -> Result<String, String> {
    let stdout = pactl_stdout(&arguments)?;
    let index = stdout.trim().to_string();
    if index.is_empty() || !index.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!(
            "pactl 未返回模块编号（输出：{}）",
            tail_chars(stdout.trim(), MAX_DETAIL_CHARS)
        ));
    }
    Ok(index)
}

fn unload_module(index: &str) -> Result<(), String> {
    pactl_stdout(&["unload-module".to_string(), index.to_string()]).map(|_| ())
}

/// 创建 `translator_mic`（null sink）的 pactl 参数（audio routing §4.1）。
fn null_sink_arguments() -> Vec<String> {
    vec![
        "load-module".to_string(),
        "module-null-sink".to_string(),
        format!("sink_name={MIC_SINK}"),
        format!("sink_properties=device.description={MIC_SINK_DESCRIPTION}"),
    ]
}

/// 创建 `translator_mic_source`（remap source）的 pactl 参数（audio routing §4.1）。
///
/// description 用不换行空格，保证包含它的参数里没有 ASCII 空格（见上）。
fn remap_source_arguments() -> Vec<String> {
    vec![
        "load-module".to_string(),
        "module-remap-source".to_string(),
        format!("master={MIC_SINK}.monitor"),
        format!("source_name={MIC_SOURCE}"),
        format!("source_properties=device.description={MIC_SOURCE_DESCRIPTION}"),
    ]
}

// --------------------------------------------------------------------------- //
// `pactl list` 输出解析
// --------------------------------------------------------------------------- //

#[derive(Debug, PartialEq, Eq)]
struct Module {
    index: String,
    name: String,
    arguments: String,
}

/// `pactl list short ...` 的列：`索引 名称 其余参数`。pactl 用制表符分隔，
/// 这里同时容忍空格分隔（部分发行版的本地化或代理实现会改成空格）。
fn split_columns(line: &str) -> Option<(String, String, String)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut rest = line;
    let mut fields = Vec::with_capacity(2);
    for _ in 0..2 {
        let trimmed = rest.trim_start();
        let end = trimmed
            .find(|character: char| character == '\t' || character.is_whitespace())
            .unwrap_or(trimmed.len());
        if end == 0 {
            return None;
        }
        fields.push(trimmed[..end].to_string());
        rest = &trimmed[end..];
    }
    Some((
        fields[0].clone(),
        fields[1].clone(),
        rest.trim_start_matches(['\t', ' ']).trim_end().to_string(),
    ))
}

fn parse_modules(output: &str) -> Vec<Module> {
    output
        .lines()
        .filter_map(|line| {
            let (index, name, arguments) = split_columns(line)?;
            if index.is_empty() || name.is_empty() {
                return None;
            }
            Some(Module {
                index,
                name,
                arguments,
            })
        })
        .collect()
}

fn parse_source_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| split_columns(line).map(|(_, name, _)| name))
        .filter(|name| !name.is_empty())
        .collect()
}

fn module_has_argument(module: &Module, argument: &str) -> bool {
    module
        .arguments
        .split_whitespace()
        .any(|candidate| candidate == argument)
}

fn is_mic_null_sink(module: &Module) -> bool {
    module.name == "module-null-sink" && module_has_argument(module, &format!("sink_name={MIC_SINK}"))
}

fn is_mic_remap_source(module: &Module) -> bool {
    module.name == "module-remap-source"
        && module_has_argument(module, &format!("source_name={MIC_SOURCE}"))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MicrophoneState {
    /// 已加载的 `translator_mic` null-sink 模块索引。
    sink_modules: Vec<String>,
    /// 已加载的 `translator_mic_source` remap-source 模块索引。
    source_modules: Vec<String>,
    /// `pactl list short sources` 里是否能看到 `translator_mic_source`。
    visible_source: bool,
}

impl MicrophoneState {
    /// 恰好一个 sink + 一个 source，并且 source 对上层可见，才算「可用」。
    fn is_ready(&self) -> bool {
        self.sink_modules.len() == 1 && self.source_modules.len() == 1 && self.visible_source
    }

    /// 需要清理的模块：先卸 remap source（依赖 null sink 的 monitor），再卸 sink。
    fn stale_modules(&self) -> Vec<String> {
        self.source_modules
            .iter()
            .chain(self.sink_modules.iter())
            .cloned()
            .collect()
    }
}

fn state_from(modules: &[Module], source_names: &[String]) -> MicrophoneState {
    MicrophoneState {
        sink_modules: modules
            .iter()
            .filter(|module| is_mic_null_sink(module))
            .map(|module| module.index.clone())
            .collect(),
        source_modules: modules
            .iter()
            .filter(|module| is_mic_remap_source(module))
            .map(|module| module.index.clone())
            .collect(),
        visible_source: source_names.iter().any(|name| name == MIC_SOURCE),
    }
}

/// 「已可用」以外的情况一律先清理残留再重建（含残缺、重复）。
#[derive(Debug, PartialEq, Eq)]
enum MicrophonePlan {
    Ready,
    Recreate { unload: Vec<String> },
}

fn plan_microphone(state: &MicrophoneState) -> MicrophonePlan {
    if state.is_ready() {
        MicrophonePlan::Ready
    } else {
        MicrophonePlan::Recreate {
            unload: state.stale_modules(),
        }
    }
}

// --------------------------------------------------------------------------- //
// 状态查询 / 生命周期
// --------------------------------------------------------------------------- //

fn current_state() -> Result<MicrophoneState, String> {
    let modules = parse_modules(&pactl_stdout(&[
        "list".to_string(),
        "short".to_string(),
        "modules".to_string(),
    ])?);
    let sources = parse_source_names(&pactl_stdout(&[
        "list".to_string(),
        "short".to_string(),
        "sources".to_string(),
    ])?);
    Ok(state_from(&modules, &sources))
}

fn ensure_microphone() -> Result<(), String> {
    let state = current_state()?;
    match plan_microphone(&state) {
        MicrophonePlan::Ready => Ok(()),
        MicrophonePlan::Recreate { unload } => {
            // 清理残缺/重复的残留。卸载失败不阻塞重建：后面的二次确认会兜底。
            for index in &unload {
                let _ = unload_module(index);
            }
            load_module(null_sink_arguments())
                .map_err(|error| format!("无法创建虚拟麦克风（translator_mic）：{error}"))?;
            if let Err(error) = load_module(remap_source_arguments()) {
                // 回滚刚创建的 null sink，避免留下无法使用的半成品。
                if let Ok(residual) = current_state() {
                    for index in &residual.sink_modules {
                        let _ = unload_module(index);
                    }
                }
                return Err(format!(
                    "无法创建虚拟麦克风输入源（translator_mic_source）：{error}"
                ));
            }
            let confirmed = current_state()?;
            if confirmed.is_ready() {
                Ok(())
            } else {
                Err("虚拟麦克风模块已创建，但系统未列出 Translator Virtual Microphone；\
                     请检查音频服务（PulseAudio / pipewire-pulse）后重试。"
                    .into())
            }
        }
    }
}

/// 应用启动时的残留清理（audio routing §4.3）。
///
/// 已完整存在时视为「正在被使用」，不卸载也不重建；只有残缺或重复的残留才清理。
pub(crate) fn cleanup_stale_modules() -> Result<(), String> {
    let state = current_state()?;
    if state.is_ready() {
        return Ok(());
    }
    for index in state.stale_modules() {
        let _ = unload_module(&index);
    }
    Ok(())
}

/// 应用退出时卸载虚拟麦克风（audio routing §4.3：停止同传不卸载，退出应用卸载）。
pub(crate) fn unload_microphone() {
    if let Ok(state) = current_state() {
        for index in state.stale_modules() {
            let _ = unload_module(&index);
        }
    }
}

// --------------------------------------------------------------------------- //
// Tauri 命令（命令名、参数名保持不变）
// --------------------------------------------------------------------------- //

#[tauri::command]
pub async fn install_virtual_microphone(
    state: tauri::State<'_, InstallerState>,
) -> Result<(), String> {
    let gate = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .try_lock()
            .map_err(|_| "正在准备虚拟麦克风，请稍候。".to_string())?;
        ensure_microphone()
    })
    .await
    .map_err(|error| error.to_string())?
}

fn link_url(kind: &str) -> Result<&'static str, String> {
    match kind {
        "help" => Ok(HELP_URL),
        "releases" => Ok(RELEASES_URL),
        _ => Err("未知链接".into()),
    }
}

#[tauri::command]
pub fn open_virtual_microphone_link(kind: String) -> Result<(), String> {
    let url = link_url(&kind)?;
    crate::open_with_default_app(url)
        .map_err(|error| format!("无法打开帮助页面，请手动访问 {url}：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(index: &str, name: &str, arguments: &str) -> Module {
        Module {
            index: index.into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }

    #[test]
    fn null_sink_command_matches_the_audio_routing_contract() {
        assert_eq!(
            null_sink_arguments(),
            vec![
                "load-module",
                "module-null-sink",
                "sink_name=translator_mic",
                "sink_properties=device.description=TranslatorVirtualMicrophoneSink",
            ]
        );
    }

    #[test]
    fn remap_source_mirrors_the_null_sink_monitor() {
        assert_eq!(
            remap_source_arguments(),
            vec![
                "load-module",
                "module-remap-source",
                "master=translator_mic.monitor",
                "source_name=translator_mic_source",
                "source_properties=device.description=Translator\u{a0}Virtual\u{a0}Microphone",
            ]
        );
    }

    #[test]
    fn load_arguments_never_contain_ascii_spaces() {
        // pactl 按空格切分模块参数；任何带 ASCII 空格的参数都会被拆坏。
        for arguments in [null_sink_arguments(), remap_source_arguments()] {
            for argument in arguments {
                assert!(
                    !argument.contains(' '),
                    "module argument must not contain an ASCII space: {argument:?}"
                );
            }
        }
        // 显示名保持可读（NBSP 分隔），且 sink/source 命名不变。
        assert!(null_sink_arguments().contains(&"sink_name=translator_mic".to_string()));
        assert_eq!(MIC_SINK, "translator_mic");
        assert_eq!(MIC_SOURCE, "translator_mic_source");
        assert_eq!(
            MIC_SOURCE_DESCRIPTION.replace('\u{a0}', " "),
            "Translator Virtual Microphone"
        );
    }

    #[test]
    fn parses_tab_and_space_separated_pactl_output() {
        let tabbed = "31\tmodule-null-sink\tsink_name=translator_mic sink_properties=device.description=TranslatorVirtualMicrophoneSink\n32\tmodule-remap-source\tmaster=translator_mic.monitor source_name=translator_mic_source\n";
        let modules = parse_modules(tabbed);
        assert_eq!(modules.len(), 2);
        assert_eq!(modules[0].index, "31");
        assert_eq!(modules[1].name, "module-remap-source");
        assert!(is_mic_null_sink(&modules[0]));
        assert!(is_mic_remap_source(&modules[1]));

        let spaced = "5 module-null-sink sink_name=translator_mic\n";
        let modules = parse_modules(spaced);
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].index, "5");
        assert_eq!(modules[0].arguments, "sink_name=translator_mic");
    }

    #[test]
    fn only_exact_module_arguments_count_as_our_modules() {
        assert!(!is_mic_null_sink(&module(
            "1",
            "module-null-sink",
            "sink_name=translator_mic_backup"
        )));
        assert!(!is_mic_null_sink(&module(
            "2",
            "module-remap-source",
            "sink_name=translator_mic"
        )));
        assert!(!is_mic_remap_source(&module(
            "3",
            "module-remap-source",
            "source_name=other_source"
        )));
    }

    #[test]
    fn complete_configuration_is_ready_and_untouched() {
        let modules = vec![
            module("7", "module-null-sink", "sink_name=translator_mic"),
            module(
                "8",
                "module-remap-source",
                "master=translator_mic.monitor source_name=translator_mic_source",
            ),
        ];
        let state = state_from(&modules, &["translator_mic_source".to_string()]);
        assert!(state.is_ready());
        assert_eq!(plan_microphone(&state), MicrophonePlan::Ready);
    }

    #[test]
    fn partial_or_duplicated_configuration_is_recreated_after_cleanup() {
        // 只有 null sink（上次创建到一半失败）。
        let partial = state_from(
            &[module("7", "module-null-sink", "sink_name=translator_mic")],
            &[],
        );
        assert_eq!(
            plan_microphone(&partial),
            MicrophonePlan::Recreate {
                unload: vec!["7".to_string()]
            }
        );

        // null sink 与 remap source 都在，但 source 没有出现在 source 列表里。
        let invisible = state_from(
            &[
                module("7", "module-null-sink", "sink_name=translator_mic"),
                module(
                    "8",
                    "module-remap-source",
                    "master=translator_mic.monitor source_name=translator_mic_source",
                ),
            ],
            &[],
        );
        assert!(!invisible.is_ready());
        // 先卸 remap source，再卸 null sink。
        assert_eq!(
            plan_microphone(&invisible),
            MicrophonePlan::Recreate {
                unload: vec!["8".to_string(), "7".to_string()]
            }
        );

        // 重复加载的残留。
        let duplicated = state_from(
            &[
                module("7", "module-null-sink", "sink_name=translator_mic"),
                module("9", "module-null-sink", "sink_name=translator_mic"),
                module(
                    "8",
                    "module-remap-source",
                    "master=translator_mic.monitor source_name=translator_mic_source",
                ),
            ],
            &["translator_mic_source".to_string()],
        );
        assert_eq!(
            plan_microphone(&duplicated),
            MicrophonePlan::Recreate {
                unload: vec!["8".to_string(), "7".to_string(), "9".to_string()]
            }
        );
    }

    #[test]
    fn empty_configuration_creates_both_modules() {
        let state = state_from(&[], &[]);
        assert_eq!(
            plan_microphone(&state),
            MicrophonePlan::Recreate { unload: vec![] }
        );
    }

    #[test]
    fn parses_source_names_from_short_source_listing() {
        let listing = "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule-alsa-sink\t...\n1\ttranslator_mic_source\tmodule-remap-source\t...\n2\talsa_input.usb-mic\tmodule-alsa-source\t...\n";
        assert_eq!(
            parse_source_names(listing),
            vec![
                "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor".to_string(),
                "translator_mic_source".to_string(),
                "alsa_input.usb-mic".to_string(),
            ]
        );
    }

    #[test]
    fn startup_cleanup_never_touches_the_engine_capture_modules() {
        // engine-port 的采集模块（translator_mix null-sink + loopback）与虚拟麦克风
        // 是两套独立生命周期：Rust 只允许动 translator_mic / translator_mic_source。
        let modules = vec![
            module(
                "1",
                "module-null-sink",
                "sink_name=translator_mix sink_properties=device.description=TranslatorSystemMix",
            ),
            module(
                "2",
                "module-loopback",
                "source=translator_mix.monitor sink=alsa_output.pci-0.analog-stereo latency_msec=20",
            ),
            module("3", "module-null-sink", "sink_name=translator_mic"),
        ];
        let state = state_from(&modules, &[]);
        assert_eq!(state.stale_modules(), vec!["3".to_string()]);
        assert!(!state.is_ready());

        // 虚拟麦克风完整时启动清理完全不动作（引擎模块也不受影响）。
        let ready = state_from(
            &[
                module("1", "module-null-sink", "sink_name=translator_mix"),
                module("2", "module-loopback", "source=translator_mix.monitor"),
                module("3", "module-null-sink", "sink_name=translator_mic"),
                module(
                    "4",
                    "module-remap-source",
                    "master=translator_mic.monitor source_name=translator_mic_source",
                ),
            ],
            &["translator_mic_source".to_string()],
        );
        assert!(ready.is_ready());
        assert_eq!(plan_microphone(&ready), MicrophonePlan::Ready);
    }

    #[test]
    fn link_kinds_resolve_to_the_linux_help_pages() {
        assert!(link_url("help").unwrap().starts_with("https://github.com/"));
        assert!(link_url("releases").unwrap().ends_with("/releases"));
        assert_eq!(link_url("product").unwrap_err(), "未知链接");
        assert_eq!(link_url("").unwrap_err(), "未知链接");
    }

    #[test]
    fn missing_pactl_reports_an_install_hint() {
        let error = run_tool(
            "definitely-not-a-real-pactl-binary",
            &["list".to_string()],
            Duration::from_millis(100),
        )
        .expect_err("a missing tool must not be treated as success");
        assert!(error.contains("pulseaudio-utils") || error.contains("pipewire-pulse"));
    }
}
