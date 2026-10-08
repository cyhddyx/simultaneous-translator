//! 原生运行时控制层：系统托盘、全局快捷键、字幕悬浮窗，以及前端唯一订阅的
//! `RuntimeState` 快照。
//!
//! 契约（冻结 v1，本文件不得偏离）：
//! - `docs/tray-shortcuts-contract.md`：RuntimeState / RuntimeAction / 托盘 / 快捷键。
//! - `docs/subtitle-window.md`：字幕窗口标识、属性与生命周期。
//! - `docs/runtime-channel-control.md` 第 5 节：sidecar 事件 → RuntimeState 映射。
//!
//! 线程模型（重要，改动前先读）：
//! - `dispatch_action` 是同步实现，可能阻塞（启动会话最长 60s）。三个入口
//!   （托盘菜单、全局快捷键、`dispatch_native_action` 命令）都把它放到后台线程 /
//!   阻塞线程池上执行，绝不阻塞 Tauri 事件线程。
//! - 托盘与菜单句柄只能在主线程上访问，统一通过 [`on_main_thread`] 调度。该函数
//!   在调用方本身就是主线程时会内联执行（`tauri-runtime-wry` 的
//!   `send_user_message` 会检测主线程），因此主线程调用不会自锁。
//! - 锁顺序：`RuntimeState` → `EngineManager.process`，两者从不同时持有。
//!   动作去抖表、会话闸门、托盘句柄都是独立锁，且从不在等待主线程时持有
//!   （托盘锁只在主线程闭包内部获取，见 [`sync_tray`]）。
//! - 会话类动作由 `session_gate` 串行化：`starting` / `stopping` 期间的重复触发
//!   直接返回当前状态，不会创建第二个 session。

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use uuid::Uuid;

use crate::{
    active_session_blocking, cleanup_engine, load_public_settings, request_engine_blocking,
    start_translation_blocking, stop_translation_blocking, EngineManager, ShortcutSettings,
};

/// 运行时状态广播事件名（契约第 6 节，`app.emit` 广播到所有窗口）。
pub(crate) const RUNTIME_STATE_EVENT: &str = "runtime-state";
/// 托盘「设置」菜单项额外发给前端的打开设置事件。
pub(crate) const OPEN_SETTINGS_EVENT: &str = "open-settings";
/// 托盘 id（契约第 9 节）。
pub(crate) const TRAY_ID: &str = "main-tray";
/// 字幕悬浮窗 label（契约 subtitle-window.md 第 1 节，固定且唯一）。
pub(crate) const SUBTITLE_WINDOW_LABEL: &str = "subtitle";
/// 主窗口 label（`tauri.conf.json` 中没有显式 label，默认 `main`）。
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
/// 快捷键去抖窗口（契约第 8.4 节）。
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);
/// 运行时通道命令等待 sidecar 响应的时间上限。
const RUNTIME_COMMAND_TIMEOUT: Duration = Duration::from_millis(2_000);
/// 等待「切回主线程执行」的上限。
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);
/// 状态文案前缀，托盘 tooltip 为 `同传翻译 · <状态文案>`。
const TRAY_TOOLTIP_PREFIX: &str = "同传翻译";
const EPOCH_TIMESTAMP: &str = "1970-01-01T00:00:00Z";

// --------------------------------------------------------------------------- //
// 契约结构
// --------------------------------------------------------------------------- //

/// 契约第 2 节 `TrayStatus`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrayStatus {
    #[serde(rename = "not_started")]
    NotStarted,
    #[serde(rename = "connecting")]
    Connecting,
    #[serde(rename = "translating")]
    Translating,
    #[serde(rename = "audio_error")]
    AudioError,
    #[serde(rename = "network_error")]
    NetworkError,
}

/// 契约第 2 节 `RuntimeHealth`（复用前端 `HealthStatus` 取值）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeHealth {
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "connecting")]
    Connecting,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "degraded")]
    Degraded,
    #[serde(rename = "failed")]
    Failed,
}

impl RuntimeHealth {
    /// `audio.status` / `network.status` 的 `status` 字段 → 健康值。
    fn from_event_status(status: &str) -> Option<Self> {
        match status {
            "unknown" => Some(Self::Unknown),
            "connecting" => Some(Self::Connecting),
            "ready" => Some(Self::Ready),
            "degraded" => Some(Self::Degraded),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// 既有 `SessionPhase` 的 Rust 镜像（契约第 2 节）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionPhase {
    #[serde(rename = "needs_configuration")]
    NeedsConfiguration,
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "listening")]
    Listening,
    #[serde(rename = "stopping")]
    Stopping,
    #[serde(rename = "error")]
    Error,
}

/// 契约第 4 节 `RuntimeAction`：唯一动作模型，serde 名与契约字符串完全一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RuntimeAction {
    #[serde(rename = "start_or_stop_session")]
    StartOrStopSession,
    #[serde(rename = "toggle_speak_mute")]
    ToggleSpeakMute,
    #[serde(rename = "toggle_listen_channel")]
    ToggleListenChannel,
    #[serde(rename = "toggle_speak_channel")]
    ToggleSpeakChannel,
    #[serde(rename = "toggle_subtitle_window")]
    ToggleSubtitleWindow,
    #[serde(rename = "show_main_window")]
    ShowMainWindow,
    #[serde(rename = "quit_application")]
    QuitApplication,
}

/// 契约第 2 节 `RuntimeError.service`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorService {
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "configuration")]
    Configuration,
    #[serde(rename = "system")]
    System,
}

/// 契约第 2 节 `ShortcutFailure`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutFailure {
    accelerator: String,
    action: RuntimeAction,
    reason: String,
}

/// 契约第 2 节 `RuntimeError`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    id: String,
    service: ErrorService,
    code: String,
    message: String,
    recoverable: bool,
    session_id: Option<String>,
}

/// 契约第 2 节 `RuntimeState`：Rust → 前端的唯一运行时状态结构。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    revision: u64,
    tray_status: TrayStatus,
    session_phase: SessionPhase,
    session_id: Option<String>,
    audio_health: RuntimeHealth,
    network_health: RuntimeHealth,
    listen_enabled: bool,
    speak_enabled: bool,
    speak_muted: bool,
    subtitle_visible: bool,
    shortcut_failures: Vec<ShortcutFailure>,
    last_error: Option<RuntimeError>,
    updated_at: String,
}

impl Default for RuntimeState {
    /// 契约第 2 节的初始值（应用刚启动、尚未读取设置）。
    fn default() -> Self {
        Self {
            revision: 0,
            tray_status: TrayStatus::NotStarted,
            session_phase: SessionPhase::Idle,
            session_id: None,
            audio_health: RuntimeHealth::Unknown,
            network_health: RuntimeHealth::Unknown,
            listen_enabled: false,
            speak_enabled: false,
            speak_muted: false,
            subtitle_visible: false,
            shortcut_failures: Vec::new(),
            last_error: None,
            updated_at: EPOCH_TIMESTAMP.to_string(),
        }
    }
}

impl RuntimeState {
    /// `revision` / `updatedAt` 之外的内容比较：决定是否需要广播一次更新。
    fn content_eq(&self, other: &Self) -> bool {
        self.tray_status == other.tray_status
            && self.session_phase == other.session_phase
            && self.session_id == other.session_id
            && self.audio_health == other.audio_health
            && self.network_health == other.network_health
            && self.listen_enabled == other.listen_enabled
            && self.speak_enabled == other.speak_enabled
            && self.speak_muted == other.speak_muted
            && self.subtitle_visible == other.subtitle_visible
            && self.shortcut_failures == other.shortcut_failures
            && self.last_error == other.last_error
    }
}

// --------------------------------------------------------------------------- //
// 纯逻辑：契约第 3 节的唯一 trayStatus 实现
// --------------------------------------------------------------------------- //

fn tray_status_label(status: TrayStatus) -> &'static str {
    match status {
        TrayStatus::NotStarted => "未启动",
        TrayStatus::Connecting => "正在连接",
        TrayStatus::Translating => "正常翻译",
        TrayStatus::AudioError => "音频异常",
        TrayStatus::NetworkError => "网络异常",
    }
}

/// 契约第 3 节：`network_error > audio_error > connecting > translating > not_started`。
fn derive_tray_status(state: &RuntimeState) -> TrayStatus {
    if state.network_health == RuntimeHealth::Failed {
        return TrayStatus::NetworkError;
    }
    if state.audio_health == RuntimeHealth::Failed {
        return TrayStatus::AudioError;
    }
    match state.session_phase {
        SessionPhase::Starting | SessionPhase::Stopping => TrayStatus::Connecting,
        SessionPhase::Listening if state.session_id.is_some() => TrayStatus::Translating,
        _ => TrayStatus::NotStarted,
    }
}

/// 应用一次变更：重算 `trayStatus`，只有内容真的变化才自增 `revision` 并更新时间戳。
/// 没有变化时把状态整体回滚，保证「只更新变化项」的语义。
fn reduce_at(state: &mut RuntimeState, now: &str, change: impl FnOnce(&mut RuntimeState)) -> bool {
    let before = state.clone();
    change(state);
    state.tray_status = derive_tray_status(state);
    if state.content_eq(&before) {
        *state = before;
        return false;
    }
    state.revision = before.revision.saturating_add(1);
    state.updated_at = now.to_string();
    true
}

fn reduce(state: &mut RuntimeState, change: impl FnOnce(&mut RuntimeState)) -> bool {
    reduce_at(state, &rfc3339_now(), change)
}

fn rfc3339_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    rfc3339_from_unix_seconds(seconds)
}

/// 不引入日期库的 RFC3339（UTC）格式化。
fn rfc3339_from_unix_seconds(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
}

/// Howard Hinnant `civil_from_days`：1970-01-01 起的天数 → (年, 月, 日)。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe as i64 + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

// --------------------------------------------------------------------------- //
// 纯逻辑：会话状态归约
// --------------------------------------------------------------------------- //

/// 会话真正结束：通道状态复位、健康状态回到 unknown、sessionId 清空。
fn reset_session(state: &mut RuntimeState) {
    state.session_id = None;
    state.session_phase = SessionPhase::Idle;
    state.audio_health = RuntimeHealth::Unknown;
    state.network_health = RuntimeHealth::Unknown;
    state.listen_enabled = false;
    state.speak_enabled = false;
    state.speak_muted = false;
}

/// 会话开始：写 sessionId，并按配置初始化运行时通道（契约 runtime-channel-control 第 1 节铁律 2）。
fn apply_session_starting(state: &mut RuntimeState, session_id: &str, listen: bool, speak: bool) {
    state.session_id = Some(session_id.to_string());
    state.session_phase = SessionPhase::Starting;
    state.listen_enabled = listen;
    state.speak_enabled = speak;
    state.speak_muted = false;
    state.audio_health = RuntimeHealth::Unknown;
    state.network_health = RuntimeHealth::Unknown;
    state.last_error = None;
}

fn apply_start_failure(state: &mut RuntimeState, message: &str) {
    reset_session(state);
    state.last_error = Some(RuntimeError {
        id: Uuid::new_v4().to_string(),
        service: ErrorService::System,
        code: "start_failed".to_string(),
        message: message.to_string(),
        recoverable: true,
        session_id: None,
    });
}

/// sidecar 事件名是否会影响 `RuntimeState`（其余事件只走既有 `translator-event`）。
fn is_runtime_event(event: &str) -> bool {
    matches!(
        event,
        "state" | "runtime.channel" | "runtime.mute" | "audio.status" | "network.status" | "error"
    )
}

/// 契约 runtime-channel-control 第 5 节的映射表（纯函数，可脱离 Tauri runtime 测试）。
///
/// 返回 `true` 表示该 payload 真的修改了状态。`session_id` 校验是硬性的：
/// 事件自带的 `session_id` 与当前 `RuntimeState.sessionId` 不一致时直接丢弃。
fn reduce_engine_payload(state: &mut RuntimeState, payload: &Value) -> bool {
    if payload.get("type").and_then(Value::as_str) != Some("event") {
        return false;
    }
    if let Some(event_session) = payload.get("session_id").and_then(Value::as_str) {
        if state.session_id.as_deref() != Some(event_session) {
            return false;
        }
    }
    let Some(event) = payload.get("event").and_then(Value::as_str) else {
        return false;
    };
    let data = payload.get("data");

    match event {
        "state" => {
            let name = data
                .and_then(|data| data.get("state"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let phase = match name {
                "needs_configuration" => Some(SessionPhase::NeedsConfiguration),
                "starting" => Some(SessionPhase::Starting),
                "listening" => Some(SessionPhase::Listening),
                "stopping" => Some(SessionPhase::Stopping),
                "error" => Some(SessionPhase::Error),
                "stopped" => None,
                _ => return false,
            };
            match phase {
                Some(phase) => {
                    state.session_phase = phase;
                    true
                }
                None => {
                    reset_session(state);
                    true
                }
            }
        }
        "runtime.channel" => {
            let channel = data
                .and_then(|data| data.get("channel"))
                .and_then(Value::as_str);
            let enabled = data
                .and_then(|data| data.get("enabled"))
                .and_then(Value::as_bool);
            match (channel, enabled) {
                (Some("listen"), Some(enabled)) => {
                    state.listen_enabled = enabled;
                    true
                }
                (Some("speak"), Some(enabled)) => {
                    state.speak_enabled = enabled;
                    true
                }
                _ => false,
            }
        }
        "runtime.mute" => {
            let Some(muted) = data
                .and_then(|data| data.get("muted"))
                .and_then(Value::as_bool)
            else {
                return false;
            };
            state.speak_muted = muted;
            true
        }
        "audio.status" => apply_health_event(state, data, true),
        "network.status" => apply_health_event(state, data, false),
        "error" => {
            let service = error_service(data);
            let code = data
                .and_then(|data| data.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("engine_error")
                .to_string();
            let message = data
                .and_then(|data| data.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("翻译引擎报告了一个错误。")
                .to_string();
            let recoverable = data
                .and_then(|data| data.get("recoverable"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let id = data
                .and_then(|data| data.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let session_id = payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            state.last_error = Some(RuntimeError {
                id,
                service,
                code,
                message,
                recoverable,
                session_id,
            });
            // 契约第 5 节：audio → audioHealth=failed；network → networkHealth=failed；
            // configuration / system 只记录 lastError，不推断健康状态。
            match service {
                ErrorService::Audio => state.audio_health = RuntimeHealth::Failed,
                ErrorService::Network => state.network_health = RuntimeHealth::Failed,
                ErrorService::Configuration | ErrorService::System => {}
            }
            true
        }
        _ => false,
    }
}

fn apply_health_event(state: &mut RuntimeState, data: Option<&Value>, audio: bool) -> bool {
    let Some(status) = data
        .and_then(|data| data.get("status"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Some(health) = RuntimeHealth::from_event_status(status) else {
        return false;
    };
    if audio {
        if state.audio_health == health {
            return false;
        }
        state.audio_health = health;
    } else {
        if state.network_health == health {
            return false;
        }
        state.network_health = health;
    }
    true
}

/// `error` 事件的 `service`：契约第 4.4 节的新字段是权威值；
/// 旧 sidecar 缺少该字段时按 `system` 处理，避免把未知错误误报成网络/音频异常。
fn error_service(data: Option<&Value>) -> ErrorService {
    match data
        .and_then(|data| data.get("service"))
        .and_then(Value::as_str)
    {
        Some("audio") => ErrorService::Audio,
        Some("network") => ErrorService::Network,
        Some("configuration") => ErrorService::Configuration,
        Some("system") => ErrorService::System,
        _ => ErrorService::System,
    }
}

/// 运行时通道命令的错误码 → 可直接展示的中文提示（契约 runtime-channel-control 第 3.2 节）。
fn runtime_error_message(code: &str, detail: &str) -> String {
    match code {
        "invalid_params" => "通道控制参数无效。".to_string(),
        "invalid_channel" => "不支持的通道类型。".to_string(),
        "no_active_session" => "当前没有进行中的同传会话。".to_string(),
        "session_mismatch" => "会话已结束或已被替换。".to_string(),
        "channel_not_configured" => "该通道未在设置中启用。".to_string(),
        "internal_error" => "翻译引擎内部错误，请重试。".to_string(),
        _ if !detail.is_empty() => detail.to_string(),
        _ => "翻译引擎返回了未知错误。".to_string(),
    }
}

/// `set_runtime_channel` / `set_speak_muted` 的 `response` → `RuntimeState`（纯函数）。
///
/// 成功时写入 `result` 里的**生效值**（幂等重复请求 `changed:false` 也是成功）；
/// 失败时记录 `lastError` 并返回可展示的中文提示。
fn reduce_runtime_response(
    state: &mut RuntimeState,
    command: &str,
    payload: &Value,
) -> Result<(), String> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = payload
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("internal_error");
        let detail = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = runtime_error_message(code, detail);
        state.last_error = Some(RuntimeError {
            id: Uuid::new_v4().to_string(),
            service: ErrorService::System,
            code: code.to_string(),
            message: message.clone(),
            recoverable: true,
            session_id: state.session_id.clone(),
        });
        return Err(message);
    }

    let result = payload.get("result");
    match command {
        "set_runtime_channel" => {
            let channel = result
                .and_then(|result| result.get("channel"))
                .and_then(Value::as_str);
            let enabled = result
                .and_then(|result| result.get("enabled"))
                .and_then(Value::as_bool);
            match (channel, enabled) {
                (Some("listen"), Some(enabled)) => state.listen_enabled = enabled,
                (Some("speak"), Some(enabled)) => state.speak_enabled = enabled,
                _ => {}
            }
        }
        "set_speak_muted" => {
            if let Some(muted) = result
                .and_then(|result| result.get("muted"))
                .and_then(Value::as_bool)
            {
                state.speak_muted = muted;
            }
        }
        _ => {}
    }
    Ok(())
}

// --------------------------------------------------------------------------- //
// 纯逻辑：全局快捷键表与去抖
// --------------------------------------------------------------------------- //

/// Five configurable global shortcuts in stable action order.
fn shortcut_bindings(settings: &ShortcutSettings) -> [(&str, RuntimeAction); 5] {
    [
        (
            &settings.start_or_stop_session,
            RuntimeAction::StartOrStopSession,
        ),
        (&settings.toggle_speak_mute, RuntimeAction::ToggleSpeakMute),
        (
            &settings.toggle_subtitle_window,
            RuntimeAction::ToggleSubtitleWindow,
        ),
        (
            &settings.toggle_listen_channel,
            RuntimeAction::ToggleListenChannel,
        ),
        (
            &settings.toggle_speak_channel,
            RuntimeAction::ToggleSpeakChannel,
        ),
    ]
}

// --------------------------------------------------------------------------- //
// RuntimeHub：状态 + 托盘 + 闸门 + 去抖
// --------------------------------------------------------------------------- //

/// 托盘与菜单项句柄。只更新变化项，绝不重建菜单（契约第 9 节）。
struct TrayHandle {
    tray: TrayIcon<Wry>,
    status_item: MenuItem<Wry>,
    start_stop_item: MenuItem<Wry>,
    speak_mute_item: CheckMenuItem<Wry>,
    listen_item: CheckMenuItem<Wry>,
    speak_item: CheckMenuItem<Wry>,
    subtitle_item: CheckMenuItem<Wry>,
    applied: Option<RuntimeState>,
}

impl TrayHandle {
    /// 把一次状态快照同步到托盘；逐项比较，只有变化项才调用 API。
    fn apply(&mut self, state: &RuntimeState) {
        let previous = self.applied.as_ref();

        if previous.map(|previous| previous.tray_status) != Some(state.tray_status) {
            let label = tray_status_label(state.tray_status);
            let _ = self.status_item.set_text(label);
            let _ = self
                .tray
                .set_tooltip(Some(format!("{TRAY_TOOLTIP_PREFIX} · {label}")));
        }

        let has_session = state.session_id.is_some();
        if previous.map(|previous| previous.session_id.is_some()) != Some(has_session) {
            let _ = self.start_stop_item.set_text(if has_session {
                "停止同传"
            } else {
                "开始同传"
            });
        }

        if previous.map(|previous| previous.speak_muted) != Some(state.speak_muted) {
            let _ = self.speak_mute_item.set_checked(state.speak_muted);
        }
        if previous.map(|previous| previous.listen_enabled) != Some(state.listen_enabled) {
            let _ = self.listen_item.set_checked(state.listen_enabled);
        }
        if previous.map(|previous| previous.speak_enabled) != Some(state.speak_enabled) {
            let _ = self.speak_item.set_checked(state.speak_enabled);
        }
        if previous.map(|previous| previous.subtitle_visible) != Some(state.subtitle_visible) {
            let _ = self.subtitle_item.set_checked(state.subtitle_visible);
        }

        self.applied = Some(state.clone());
    }
}

/// 进程级运行时状态载体（`app.manage` 的托管状态）。
#[derive(Clone)]
pub struct RuntimeHub {
    state: Arc<Mutex<RuntimeState>>,
    quitting: Arc<AtomicBool>,
    /// 会话动作闸门：`starting` / `stopping` 期间重复触发直接返回当前状态。
    session_gate: Arc<Mutex<()>>,
    /// 每个 action 的 `last_fired`，250ms 内的重复触发被吞掉。
    debounce: Arc<Mutex<HashMap<RuntimeAction, Instant>>>,
    /// Actions for the hotkeys that are currently registered with the OS.
    shortcut_actions: Arc<Mutex<HashMap<u32, RuntimeAction>>>,
    tray: Arc<Mutex<Option<TrayHandle>>>,
}

impl Default for RuntimeHub {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState::default())),
            quitting: Arc::new(AtomicBool::new(false)),
            session_gate: Arc::new(Mutex::new(())),
            debounce: Arc::new(Mutex::new(HashMap::new())),
            shortcut_actions: Arc::new(Mutex::new(HashMap::new())),
            tray: Arc::new(Mutex::new(None)),
        }
    }
}

impl RuntimeHub {
    fn snapshot(&self) -> RuntimeState {
        lock_or_recover(&self.state).clone()
    }

    /// 应用一次状态变更；内容真的变化时自增 revision 并广播 `runtime-state`，同时同步托盘。
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut RuntimeState)) -> RuntimeState {
        let (snapshot, changed) = {
            let mut state = lock_or_recover(&self.state);
            let changed = reduce(&mut state, change);
            (state.clone(), changed)
        };
        if changed {
            let _ = app.emit(RUNTIME_STATE_EVENT, snapshot.clone());
            sync_tray(app, &snapshot);
        }
        snapshot
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    /// 检查并记录动作触发时间：窗口内的重复触发返回 `false`（检查与记录在同一把锁内完成）。
    fn should_fire(&self, action: RuntimeAction, now: Instant) -> bool {
        let mut fired = lock_or_recover(&self.debounce);
        match fired.get(&action) {
            Some(last) if now.duration_since(*last) < DEBOUNCE_WINDOW => false,
            _ => {
                fired.insert(action, now);
                true
            }
        }
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        // 锁中毒只可能来自状态更新期间的 panic；继续使用最后一个一致快照，
        // 而不是让托盘/快捷键整体失效。
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn hub(app: &AppHandle) -> RuntimeHub {
    app.state::<RuntimeHub>().inner().clone()
}

/// 在主线程上执行 `task` 并等待结果。
///
/// 调用方已经在主线程时 `run_on_main_thread` 会内联执行（`tauri-runtime-wry`
/// 的 `send_user_message` 检测 `main_thread_id`），所以这里不会自锁。
fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(task(&handle));
    })
    .map_err(|error| format!("无法调度到主线程：{error}"))?;
    receiver
        .recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "等待主线程执行超时".to_string())
}

/// 把状态快照同步到托盘。托盘句柄是主线程专属资源（`tray-icon` 内部为
/// `Rc<RefCell<..>>`），因此锁只在主线程闭包内部获取——绝不能在外面持有它等主线程。
fn sync_tray(app: &AppHandle, snapshot: &RuntimeState) {
    let hub = hub(app);
    let snapshot = snapshot.clone();
    let _ = on_main_thread(app, move |_app| {
        let mut guard = lock_or_recover(&hub.tray);
        if let Some(handle) = guard.as_mut() {
            handle.apply(&snapshot);
        }
    });
}

// --------------------------------------------------------------------------- //
// 初始化：托盘 + 快捷键
// --------------------------------------------------------------------------- //

/// 创建系统托盘（id `main-tray`，契约第 9 节）。必须在主线程上调用（`setup` 内）。
pub(crate) fn init(app: &AppHandle) -> Result<(), String> {
    let hub = hub(app);
    let snapshot = hub.snapshot();
    let status_label = tray_status_label(snapshot.tray_status);

    let status_item = MenuItem::with_id(app, "tray-status", status_label, false, None::<&str>)
        .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let start_stop_item = MenuItem::with_id(app, "tray-start-stop", "开始同传", true, None::<&str>)
        .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let speak_mute_item = CheckMenuItem::with_id(
        app,
        "tray-speak-mute",
        "静音发言",
        true,
        snapshot.speak_muted,
        None::<&str>,
    )
    .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let listen_item = CheckMenuItem::with_id(
        app,
        "tray-listen",
        "收听通道",
        true,
        snapshot.listen_enabled,
        None::<&str>,
    )
    .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let speak_item = CheckMenuItem::with_id(
        app,
        "tray-speak",
        "发言通道",
        true,
        snapshot.speak_enabled,
        None::<&str>,
    )
    .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let subtitle_item = CheckMenuItem::with_id(
        app,
        "tray-subtitle",
        "字幕悬浮窗",
        true,
        snapshot.subtitle_visible,
        None::<&str>,
    )
    .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let show_item = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)
        .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let settings_item = MenuItem::with_id(app, "tray-settings", "设置", true, None::<&str>)
        .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "退出应用", true, None::<&str>)
        .map_err(|error| format!("无法创建托盘菜单：{error}"))?;

    let separators = (
        PredefinedMenuItem::separator(app).map_err(|error| format!("无法创建托盘菜单：{error}"))?,
        PredefinedMenuItem::separator(app).map_err(|error| format!("无法创建托盘菜单：{error}"))?,
        PredefinedMenuItem::separator(app).map_err(|error| format!("无法创建托盘菜单：{error}"))?,
        PredefinedMenuItem::separator(app).map_err(|error| format!("无法创建托盘菜单：{error}"))?,
    );

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &separators.0,
            &start_stop_item,
            &separators.1,
            &speak_mute_item,
            &listen_item,
            &speak_item,
            &subtitle_item,
            &separators.2,
            &show_item,
            &settings_item,
            &separators.3,
            &quit_item,
        ],
    )
    .map_err(|error| format!("无法创建托盘菜单：{error}"))?;

    // 复用已打包的 32x32 图标，不新增资源（契约第 9 节）。
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("无法加载托盘图标：{error}"))?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(icon)
        .tooltip(format!("{TRAY_TOOLTIP_PREFIX} · {status_label}"))
        .on_menu_event(|app, event| on_tray_menu_event(app, event))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let app = tray.app_handle().clone();
                thread::spawn(move || {
                    let _ = dispatch_action(&app, RuntimeAction::ShowMainWindow);
                });
            }
        })
        .build(app)
        .map_err(|error| format!("无法创建系统托盘：{error}"))?;

    *lock_or_recover(&hub.tray) = Some(TrayHandle {
        tray,
        status_item,
        start_stop_item,
        speak_mute_item,
        listen_item,
        speak_item,
        subtitle_item,
        applied: None,
    });

    sync_tray(app, &snapshot);
    Ok(())
}

/// Replaces the registered shortcuts; one unavailable shortcut does not block the others.
pub(crate) fn register_global_shortcuts(app: &AppHandle, settings: &ShortcutSettings) {
    let hub = hub(app);
    lock_or_recover(&hub.shortcut_actions).clear();
    let _ = app.global_shortcut().unregister_all();

    let mut failures = Vec::new();
    let mut actions = HashMap::new();
    for (accelerator, action) in shortcut_bindings(settings) {
        let shortcut: Shortcut = match accelerator.parse() {
            Ok(shortcut) => shortcut,
            Err(error) => {
                failures.push(ShortcutFailure {
                    accelerator: accelerator.to_string(),
                    action,
                    reason: error.to_string(),
                });
                continue;
            }
        };
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                actions.insert(shortcut.id(), action);
            }
            Err(error) => failures.push(ShortcutFailure {
                accelerator: accelerator.to_string(),
                action,
                reason: error.to_string(),
            }),
        }
    }
    *lock_or_recover(&hub.shortcut_actions) = actions;
    hub.update(app, |state| {
        state.shortcut_failures = failures;
    });
}

/// 全局快捷键回调：只响应 `Pressed`，只做一件事——调用 `dispatch_action`。
pub(crate) fn on_global_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    let id = shortcut.id();
    let runtime = hub(app);
    let action = lock_or_recover(&runtime.shortcut_actions).get(&id).copied();
    let Some(action) = action else {
        return;
    };
    let app = app.clone();
    // 回调本身必须立刻返回：动作执行（可能启动/停止会话）放到后台线程。
    thread::spawn(move || {
        let _ = dispatch_action(&app, action);
    });
}

fn on_tray_menu_event(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    let action = match id {
        "tray-start-stop" => Some(RuntimeAction::StartOrStopSession),
        "tray-speak-mute" => Some(RuntimeAction::ToggleSpeakMute),
        "tray-listen" => Some(RuntimeAction::ToggleListenChannel),
        "tray-speak" => Some(RuntimeAction::ToggleSpeakChannel),
        "tray-subtitle" => Some(RuntimeAction::ToggleSubtitleWindow),
        "tray-show" => Some(RuntimeAction::ShowMainWindow),
        "tray-quit" => Some(RuntimeAction::QuitApplication),
        "tray-settings" => None,
        _ => return,
    };

    let app = app.clone();
    if let Some(action) = action {
        thread::spawn(move || {
            let _ = dispatch_action(&app, action);
        });
        return;
    }

    // 契约第 9 节：设置 = 显示主窗口 + 向前端发 `open-settings`。
    thread::spawn(move || {
        if dispatch_action(&app, RuntimeAction::ShowMainWindow).is_ok() {
            let _ = app.emit(OPEN_SETTINGS_EVENT, ());
        }
    });
}

// --------------------------------------------------------------------------- //
// 唯一动作分发入口
// --------------------------------------------------------------------------- //

/// 契约第 7 节的唯一动作实现：托盘菜单、全局快捷键、`dispatch_native_action` 都只调用它。
///
/// 同步实现，可能阻塞（启动会话最长 `ENGINE_START_TIMEOUT`），调用方必须放在
/// 后台线程 / 阻塞线程池上。
pub(crate) fn dispatch_action(
    app: &AppHandle,
    action: RuntimeAction,
) -> Result<RuntimeState, String> {
    let hub = hub(app);
    if hub.is_quitting() {
        return Ok(hub.snapshot());
    }
    // 幂等 / 去抖：同一次按键的 Windows 重复消息、连点，在 250ms 内被吞掉且不报错。
    if !hub.should_fire(action, Instant::now()) {
        return Ok(hub.snapshot());
    }

    match action {
        RuntimeAction::StartOrStopSession => toggle_session(app, &hub),
        RuntimeAction::ToggleSpeakMute => toggle_speak_mute(app, &hub),
        RuntimeAction::ToggleListenChannel => toggle_channel(app, &hub, Channel::Listen),
        RuntimeAction::ToggleSpeakChannel => toggle_channel(app, &hub, Channel::Speak),
        RuntimeAction::ToggleSubtitleWindow => toggle_subtitle_window(app, &hub),
        RuntimeAction::ShowMainWindow => {
            show_main_window(app)?;
            Ok(hub.snapshot())
        }
        RuntimeAction::QuitApplication => quit_application(app, &hub),
    }
}

fn toggle_session(app: &AppHandle, hub: &RuntimeHub) -> Result<RuntimeState, String> {
    let _gate = match hub.session_gate.try_lock() {
        Ok(gate) => gate,
        // starting / stopping 期间的重复触发：返回当前状态，不创建第二个 session。
        Err(_) => return Ok(hub.snapshot()),
    };

    let manager = app.state::<EngineManager>().inner().clone();
    // `active_session_blocking` 会顺手回收已经退出的 sidecar。
    let active = active_session_blocking(&manager)?;
    match active.session_id {
        Some(session_id) => stop_translation_blocking(app, &manager, &session_id)?,
        None => {
            start_translation_blocking(app.clone(), &manager)?;
        }
    }
    Ok(hub.snapshot())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Channel {
    Listen,
    Speak,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Channel::Listen => "listen",
            Channel::Speak => "speak",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Channel::Listen => "收听通道",
            Channel::Speak => "发言通道",
        }
    }
}

fn toggle_channel(
    app: &AppHandle,
    hub: &RuntimeHub,
    channel: Channel,
) -> Result<RuntimeState, String> {
    let state = hub.snapshot();
    let Some(session_id) = state.session_id.clone() else {
        return Err("请先开始同传，再使用通道控制。".to_string());
    };

    // 配置未启用的通道不允许「伪造开启」（运行时空开关契约铁律 3）。
    let settings = load_public_settings(app)?;
    let configured = match channel {
        Channel::Listen => settings.audio.listen.enabled,
        Channel::Speak => settings.audio.speak.enabled,
    };
    if !configured {
        return Err(format!(
            "{}未在设置中启用，请先在设置中开启。",
            channel.label()
        ));
    }

    let enabled = !match channel {
        Channel::Listen => state.listen_enabled,
        Channel::Speak => state.speak_enabled,
    };
    let params = json!({
        "session_id": session_id,
        "channel": channel.name(),
        "enabled": enabled,
    });
    apply_engine_response(app, hub, "set_runtime_channel", params)?;
    Ok(hub.snapshot())
}

fn toggle_speak_mute(app: &AppHandle, hub: &RuntimeHub) -> Result<RuntimeState, String> {
    let state = hub.snapshot();
    let Some(session_id) = state.session_id.clone() else {
        return Err("请先开始同传，再使用通道控制。".to_string());
    };
    if !state.speak_enabled {
        return Err("发言通道未启用，无法静音。".to_string());
    }

    let params = json!({
        "session_id": session_id,
        "muted": !state.speak_muted,
    });
    apply_engine_response(app, hub, "set_speak_muted", params)?;
    Ok(hub.snapshot())
}

/// 发送一条 sidecar 运行时命令并把它写回 `RuntimeState`。
///
/// 请求 id 由 `request_engine_blocking` 生成；`start_stdout_forwarder` 会把
/// `type == "response"` 的 payload 交给等待者（而不是当成事件转发），因此这里
/// 拿到的是权威的生效值。等待超时视为「sidecar 尚未确认」：请求已经写入，
/// sidecar 变化时仍会通过 `runtime.channel` / `runtime.mute` 事件纠正状态。
fn apply_engine_response(
    app: &AppHandle,
    hub: &RuntimeHub,
    command: &str,
    params: Value,
) -> Result<(), String> {
    let session_id = hub
        .snapshot()
        .session_id
        .ok_or_else(|| "当前没有进行中的同传会话。".to_string())?;
    let manager = app.state::<EngineManager>().inner().clone();
    let response = request_engine_blocking(
        &manager,
        &session_id,
        command,
        params,
        RUNTIME_COMMAND_TIMEOUT,
    )?;
    let Some(response) = response else {
        return Ok(());
    };

    let mut failure = None;
    hub.update(app, |state| {
        if let Err(error) = reduce_runtime_response(state, command, &response) {
            failure = Some(error);
        }
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    on_main_thread(app, |app| -> Result<(), String> {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| "主窗口不存在。".to_string())?;
        let _ = window.unminimize();
        window
            .show()
            .map_err(|error| format!("无法显示主窗口：{error}"))?;
        let _ = window.set_focus();
        Ok(())
    })?
}

fn ensure_subtitle_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    // 复用规则：先查再建，绝不重复创建（契约 subtitle-window.md 第 1 节）。
    if let Some(existing) = app.get_webview_window(SUBTITLE_WINDOW_LABEL) {
        return Ok(existing);
    }
    WebviewWindowBuilder::new(
        app,
        SUBTITLE_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=subtitle".into()),
    )
    .title("字幕悬浮窗")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(false)
    .inner_size(880.0, 220.0)
    .min_inner_size(420.0, 120.0)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| format!("无法创建字幕窗口：{error}"))
}

fn toggle_subtitle_window(app: &AppHandle, hub: &RuntimeHub) -> Result<RuntimeState, String> {
    let visible = on_main_thread(app, |app| -> Result<bool, String> {
        let window = ensure_subtitle_window(app)?;
        let currently_visible = window.is_visible().unwrap_or(false);
        if currently_visible {
            window
                .hide()
                .map_err(|error| format!("无法隐藏字幕窗口：{error}"))?;
        } else {
            let _ = window.set_always_on_top(true);
            window
                .show()
                .map_err(|error| format!("无法显示字幕窗口：{error}"))?;
        }
        // subtitleVisible 以实际可见性为准（主线程上窗口操作同步生效）。
        Ok(window.is_visible().unwrap_or(!currently_visible))
    })??;

    hub.update(app, |state| {
        state.subtitle_visible = visible;
    });
    Ok(hub.snapshot())
}

/// 字幕窗口被用户关闭（非退出中）时由窗口事件回写状态。
pub(crate) fn set_subtitle_visible(app: &AppHandle, visible: bool) {
    let hub = hub(app);
    hub.update(app, |state| {
        state.subtitle_visible = visible;
    });
}

fn quit_application(app: &AppHandle, hub: &RuntimeHub) -> Result<RuntimeState, String> {
    hub.begin_quit();
    // 1) 关闭字幕窗口（quitting 标志已置位，CloseRequested 会放行）。
    let _ = on_main_thread(app, |app| {
        if let Some(window) = app.get_webview_window(SUBTITLE_WINDOW_LABEL) {
            let _ = window.close();
        }
    });
    // 2) 结束 sidecar 进程（既有清理路径）。
    let manager = app.state::<EngineManager>().inner().clone();
    cleanup_engine(&manager);
    // 3) 成对注销全局快捷键（契约第 8.7 节）。
    let _ = app.global_shortcut().unregister_all();
    // 4) 退出应用。
    app.exit(0);
    Ok(hub.snapshot())
}

// --------------------------------------------------------------------------- //
// 事件旁路：sidecar → RuntimeState
// --------------------------------------------------------------------------- //

/// `forward_engine_payload` 的旁路：既有的 `translator-event` 转发保持不变，
/// 这里额外把事件归约进 `RuntimeState`（契约 runtime-channel-control 第 5 节）。
pub(crate) fn observe_engine_payload(app: &AppHandle, payload: &Value) {
    if payload.get("type").and_then(Value::as_str) != Some("event") {
        // `response` 由 `request_engine_blocking` 的等待者消费，不是事件。
        return;
    }
    let event = payload
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_runtime_event(event) {
        // 字幕/部分结果等高频事件不触碰 RuntimeState。
        return;
    }
    let hub = hub(app);
    hub.update(app, |state| {
        let _ = reduce_engine_payload(state, payload);
    });
}

/// 会话开始：在把 `start` 请求写给 sidecar 之前调用，旧 session 的事件因此被丢弃。
pub(crate) fn publish_session_starting(
    app: &AppHandle,
    session_id: &str,
    listen_enabled: bool,
    speak_enabled: bool,
) {
    let hub = hub(app);
    hub.update(app, |state| {
        apply_session_starting(state, session_id, listen_enabled, speak_enabled);
    });
}

/// 会话启动失败：清空 sessionId（否则下一次 `start_or_stop_session` 会误判为「有会话」）。
pub(crate) fn publish_start_failure(app: &AppHandle, message: &str) {
    let hub = hub(app);
    hub.update(app, |state| {
        apply_start_failure(state, message);
    });
}

/// 会话结束：通道状态与健康状态复位（契约第 5 节 `stopped` 行）。
pub(crate) fn publish_session_stopped(app: &AppHandle) {
    let hub = hub(app);
    hub.update(app, |state| {
        reset_session(state);
    });
}

pub(crate) fn is_quitting(app: &AppHandle) -> bool {
    app.try_state::<RuntimeHub>()
        .map(|hub| hub.is_quitting())
        .unwrap_or(false)
}

/// 进程退出兜底：确保 sidecar 不残留（契约第 10 节）。
///
/// 这里刻意不再调用 `unregister_all`：它内部要等主线程处理消息，而 `RunEvent::Exit`
/// 之后事件循环已经停止，等待会卡住退出流程；`quit_application` 路径已经成对注销，
/// 进程结束时操作系统也会回收热键。
pub(crate) fn on_app_exit(app: &AppHandle) {
    if let Some(hub) = app.try_state::<RuntimeHub>() {
        hub.begin_quit();
    }
    let manager = app.state::<EngineManager>().inner().clone();
    cleanup_engine(&manager);
}

// --------------------------------------------------------------------------- //
// Tauri 命令（契约第 5 节）
// --------------------------------------------------------------------------- //

/// `get_runtime_state`：启动 / 刷新后拉取初始状态。
#[tauri::command]
pub(crate) fn get_runtime_state(hub: tauri::State<'_, RuntimeHub>) -> RuntimeState {
    hub.snapshot()
}

/// `dispatch_native_action`：统一动作入口，返回动作执行后的最新快照。
#[tauri::command]
pub(crate) async fn dispatch_native_action(
    app: AppHandle,
    action: RuntimeAction,
) -> Result<RuntimeState, String> {
    crate::spawn_command(move || dispatch_action(&app, action)).await
}

// --------------------------------------------------------------------------- //
// 测试：全部针对不依赖 Tauri runtime 的纯函数
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    fn session_state() -> RuntimeState {
        let mut state = RuntimeState::default();
        apply_session_starting(&mut state, "session-1", true, false);
        state
    }

    #[test]
    fn runtime_state_default_matches_the_frozen_initial_payload() {
        let value = serde_json::to_value(RuntimeState::default()).unwrap();
        assert_eq!(
            value,
            json!({
                "revision": 0,
                "trayStatus": "not_started",
                "sessionPhase": "idle",
                "sessionId": null,
                "audioHealth": "unknown",
                "networkHealth": "unknown",
                "listenEnabled": false,
                "speakEnabled": false,
                "speakMuted": false,
                "subtitleVisible": false,
                "shortcutFailures": [],
                "lastError": null,
                "updatedAt": "1970-01-01T00:00:00Z"
            })
        );
    }

    #[test]
    fn tray_status_follows_the_contract_priority() {
        let mut state = RuntimeState::default();
        assert_eq!(derive_tray_status(&state), TrayStatus::NotStarted);

        state.session_phase = SessionPhase::Starting;
        assert_eq!(derive_tray_status(&state), TrayStatus::Connecting);
        state.session_phase = SessionPhase::Stopping;
        assert_eq!(derive_tray_status(&state), TrayStatus::Connecting);

        state.session_phase = SessionPhase::Listening;
        state.session_id = Some("session-1".into());
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);

        state.audio_health = RuntimeHealth::Failed;
        assert_eq!(derive_tray_status(&state), TrayStatus::AudioError);
        state.network_health = RuntimeHealth::Failed;
        assert_eq!(derive_tray_status(&state), TrayStatus::NetworkError);
        // 网络异常优先级最高：音频异常仍在，但主状态显示网络异常。
        assert_eq!(state.audio_health, RuntimeHealth::Failed);

        // listening 但 sessionId 为空 → 未启动（不显示「正常翻译」）。
        let mut orphan = RuntimeState::default();
        orphan.session_phase = SessionPhase::Listening;
        assert_eq!(derive_tray_status(&orphan), TrayStatus::NotStarted);
    }

    #[test]
    fn tray_status_values_and_labels_match_the_contract() {
        for (status, name, label) in [
            (TrayStatus::NotStarted, "not_started", "未启动"),
            (TrayStatus::Connecting, "connecting", "正在连接"),
            (TrayStatus::Translating, "translating", "正常翻译"),
            (TrayStatus::AudioError, "audio_error", "音频异常"),
            (TrayStatus::NetworkError, "network_error", "网络异常"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<TrayStatus>(json!(name)).unwrap(),
                status
            );
            assert_eq!(tray_status_label(status), label);
        }
    }

    #[test]
    fn runtime_health_and_error_service_serde_names_match_the_contract() {
        for (health, name) in [
            (RuntimeHealth::Unknown, "unknown"),
            (RuntimeHealth::Connecting, "connecting"),
            (RuntimeHealth::Ready, "ready"),
            (RuntimeHealth::Degraded, "degraded"),
            (RuntimeHealth::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(health).unwrap(), json!(name));
        }
        for (service, name) in [
            (ErrorService::Audio, "audio"),
            (ErrorService::Network, "network"),
            (ErrorService::Configuration, "configuration"),
            (ErrorService::System, "system"),
        ] {
            assert_eq!(serde_json::to_value(service).unwrap(), json!(name));
        }
        for (phase, name) in [
            (SessionPhase::NeedsConfiguration, "needs_configuration"),
            (SessionPhase::Idle, "idle"),
            (SessionPhase::Starting, "starting"),
            (SessionPhase::Listening, "listening"),
            (SessionPhase::Stopping, "stopping"),
            (SessionPhase::Error, "error"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), json!(name));
        }
    }

    #[test]
    fn runtime_action_serde_names_match_the_contract() {
        for (action, name) in [
            (RuntimeAction::StartOrStopSession, "start_or_stop_session"),
            (RuntimeAction::ToggleSpeakMute, "toggle_speak_mute"),
            (RuntimeAction::ToggleListenChannel, "toggle_listen_channel"),
            (RuntimeAction::ToggleSpeakChannel, "toggle_speak_channel"),
            (
                RuntimeAction::ToggleSubtitleWindow,
                "toggle_subtitle_window",
            ),
            (RuntimeAction::ShowMainWindow, "show_main_window"),
            (RuntimeAction::QuitApplication, "quit_application"),
        ] {
            assert_eq!(serde_json::to_value(action).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<RuntimeAction>(json!(name)).unwrap(),
                action
            );
        }
    }

    #[test]
    fn revision_and_timestamp_only_advance_on_real_change() {
        let mut state = RuntimeState::default();
        assert!(!reduce_at(&mut state, "2026-10-07T00:00:00Z", |_| {}));
        assert_eq!(state.revision, 0);
        assert_eq!(state.updated_at, EPOCH_TIMESTAMP);

        assert!(reduce_at(&mut state, "2026-10-07T00:00:01Z", |state| {
            state.subtitle_visible = true;
        }));
        assert_eq!(state.revision, 1);
        assert_eq!(state.updated_at, "2026-10-07T00:00:01Z");

        // 写入同样的值：内容没变 → 不广播、不自增 revision。
        assert!(!reduce_at(&mut state, "2026-10-07T00:00:02Z", |state| {
            state.subtitle_visible = true;
        }));
        assert_eq!(state.revision, 1);
        assert_eq!(state.updated_at, "2026-10-07T00:00:01Z");

        // 只改 revision 的「伪变化」会被整体回滚。
        assert!(!reduce_at(&mut state, "2026-10-07T00:00:03Z", |state| {
            state.revision = 99;
        }));
        assert_eq!(state.revision, 1);
    }

    #[test]
    fn session_start_initializes_channels_and_failure_clears_session_id() {
        let mut state = RuntimeState::default();
        apply_session_starting(&mut state, "session-1", true, false);
        assert_eq!(state.session_id.as_deref(), Some("session-1"));
        assert_eq!(state.session_phase, SessionPhase::Starting);
        assert!(state.listen_enabled);
        assert!(!state.speak_enabled);
        assert!(!state.speak_muted);
        assert_eq!(derive_tray_status(&state), TrayStatus::Connecting);

        apply_start_failure(&mut state, "翻译引擎无法启动：boom");
        assert_eq!(state.session_id, None);
        assert_eq!(state.session_phase, SessionPhase::Idle);
        assert!(!state.listen_enabled);
        assert_eq!(derive_tray_status(&state), TrayStatus::NotStarted);
        assert_eq!(
            state.last_error.as_ref().unwrap().message,
            "翻译引擎无法启动：boom"
        );
    }

    #[test]
    fn session_state_events_drive_phase_and_reset_on_stop() {
        let mut state = session_state();
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"state","session_id":"session-1","data":{"state":"starting"}})
        ));
        assert_eq!(state.session_phase, SessionPhase::Starting);

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"state","session_id":"session-1","data":{"state":"listening"}})
        ));
        assert_eq!(state.session_phase, SessionPhase::Listening);

        state.audio_health = RuntimeHealth::Ready;
        state.network_health = RuntimeHealth::Degraded;
        state.speak_enabled = true;
        state.speak_muted = true;

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"state","session_id":"session-1","data":{"state":"stopped"}})
        ));
        assert_eq!(state.session_phase, SessionPhase::Idle);
        assert_eq!(state.session_id, None);
        assert_eq!(state.audio_health, RuntimeHealth::Unknown);
        assert_eq!(state.network_health, RuntimeHealth::Unknown);
        assert!(!state.listen_enabled);
        assert!(!state.speak_enabled);
        assert!(!state.speak_muted);
    }

    #[test]
    fn stale_session_events_are_dropped() {
        let mut state = session_state();
        state.session_phase = SessionPhase::Listening;
        let before = state.clone();

        assert!(!reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"state","session_id":"old-session","data":{"state":"stopped"}})
        ));
        assert!(!reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"runtime.channel","session_id":"old-session","data":{"channel":"listen","enabled":false}})
        ));
        assert!(!reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"old-session","data":{"status":"failed"}})
        ));
        assert_eq!(state, before);

        // 会话已结束后到达的旧 session 事件同样被丢弃。
        let mut idle = RuntimeState::default();
        assert!(!reduce_engine_payload(
            &mut idle,
            &json!({"type":"event","event":"runtime.mute","session_id":"old-session","data":{"muted":true}})
        ));
        assert_eq!(idle, RuntimeState::default());
    }

    #[test]
    fn runtime_channel_health_and_mute_events_update_state() {
        let mut state = session_state();
        state.session_phase = SessionPhase::Listening;

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"runtime.channel","session_id":"session-1","data":{"channel":"listen","enabled":false,"configured":true}})
        ));
        assert!(!state.listen_enabled);
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"runtime.channel","session_id":"session-1","data":{"channel":"speak","enabled":true}})
        ));
        assert!(state.speak_enabled);

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"runtime.mute","session_id":"session-1","data":{"muted":true}})
        ));
        assert!(state.speak_muted);

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"degraded","detail":"WebSocket 重连中（第 2 次）"}})
        ));
        assert_eq!(state.network_health, RuntimeHealth::Degraded);
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"audio.status","session_id":"session-1","data":{"status":"failed","channel":"listen","detail":"音频设备已断开"}})
        ));
        assert_eq!(state.audio_health, RuntimeHealth::Failed);
        assert_eq!(derive_tray_status(&state), TrayStatus::AudioError);

        // 非法 status / 非法 channel 不改变状态。
        assert!(!reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"audio.status","session_id":"session-1","data":{"status":"weird"}})
        ));
        assert!(!reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"runtime.channel","session_id":"session-1","data":{"channel":"video","enabled":true}})
        ));
    }

    /// 契约 runtime-channel-control §4.4.1（D2 裁决）：只有 `failed` 把 trayStatus
    /// 推成错误状态，`degraded` 不得推成 `network_error` / `audio_error`。
    #[test]
    fn degraded_health_never_becomes_an_error_tray_status() {
        let mut state = session_state();
        state.session_phase = SessionPhase::Listening;

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"degraded","detail":"部分通道重连中"}})
        ));
        assert_eq!(state.network_health, RuntimeHealth::Degraded);
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);

        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"audio.status","session_id":"session-1","data":{"status":"degraded","channel":"speak"}})
        ));
        assert_eq!(state.audio_health, RuntimeHealth::Degraded);
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);

        // `connecting` / `ready` 同样不进入错误状态。
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"ready"}})
        ));
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"connecting"}})
        ));
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);

        // 只有 failed 升级为错误状态。
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"failed"}})
        ));
        assert_eq!(derive_tray_status(&state), TrayStatus::NetworkError);

        // 从 failed 回到 degraded 也要能降级回去。
        assert!(reduce_engine_payload(
            &mut state,
            &json!({"type":"event","event":"network.status","session_id":"session-1","data":{"status":"degraded"}})
        ));
        assert_eq!(derive_tray_status(&state), TrayStatus::Translating);
    }

    #[test]
    fn error_events_classify_service_and_never_infer_health_for_system_errors() {
        let mut network = session_state();
        assert!(reduce_engine_payload(
            &mut network,
            &json!({"type":"event","event":"error","session_id":"session-1","data":{"scope":"asr","service":"network","code":"websocket_closed","message":"翻译服务连接已断开。","recoverable":true}})
        ));
        assert_eq!(network.network_health, RuntimeHealth::Failed);
        assert_eq!(network.audio_health, RuntimeHealth::Unknown);
        assert_eq!(derive_tray_status(&network), TrayStatus::NetworkError);
        let last = network.last_error.as_ref().unwrap();
        assert_eq!(last.service, ErrorService::Network);
        assert_eq!(last.code, "websocket_closed");
        assert_eq!(last.message, "翻译服务连接已断开。");
        assert!(last.recoverable);
        assert_eq!(last.session_id.as_deref(), Some("session-1"));
        assert!(!last.id.is_empty());

        let mut audio = session_state();
        assert!(reduce_engine_payload(
            &mut audio,
            &json!({"type":"event","event":"error","session_id":"session-1","data":{"scope":"audio","service":"audio","code":"audio_device_lost","message":"音频设备已断开","recoverable":true}})
        ));
        assert_eq!(audio.audio_health, RuntimeHealth::Failed);
        assert_eq!(derive_tray_status(&audio), TrayStatus::AudioError);

        // configuration / system 只记 lastError，不推断健康状态。
        let mut configuration = RuntimeState::default();
        assert!(reduce_engine_payload(
            &mut configuration,
            &json!({"type":"event","event":"error","data":{"service":"configuration","code":"invalid_language","message":"语言不受支持。","recoverable":false}})
        ));
        assert_eq!(configuration.audio_health, RuntimeHealth::Unknown);
        assert_eq!(configuration.network_health, RuntimeHealth::Unknown);
        assert_eq!(
            configuration.last_error.as_ref().unwrap().service,
            ErrorService::Configuration
        );
        assert!(!configuration.last_error.as_ref().unwrap().recoverable);

        // 缺少 service 的旧事件按 system 处理，不误报网络/音频异常。
        let mut legacy = RuntimeState::default();
        assert!(reduce_engine_payload(
            &mut legacy,
            &json!({"type":"event","event":"error","data":{"scope":"asr","code":"asr_error","message":"识别失败"}})
        ));
        assert_eq!(
            legacy.last_error.as_ref().unwrap().service,
            ErrorService::System
        );
        assert_eq!(legacy.network_health, RuntimeHealth::Unknown);
        assert_eq!(legacy.audio_health, RuntimeHealth::Unknown);
    }

    #[test]
    fn non_runtime_events_and_responses_do_not_touch_state() {
        let mut state = session_state();
        let before = state.clone();
        for payload in [
            json!({"type":"event","event":"translation.partial","session_id":"session-1","data":{"text":"你好"}}),
            json!({"type":"event","event":"source.final","session_id":"session-1","data":{"text":"hello"}}),
            json!({"type":"response","id":"req-1","ok":true,"result":{"session_id":"session-1"}}),
        ] {
            assert!(!reduce_engine_payload(&mut state, &payload));
        }
        assert_eq!(state, before);
        assert!(!is_runtime_event("translation.partial"));
        assert!(is_runtime_event("runtime.channel"));
        assert!(is_runtime_event("error"));
    }

    #[test]
    fn runtime_channel_responses_apply_effective_values_and_readable_errors() {
        let mut state = session_state();
        state.listen_enabled = true;

        assert!(reduce_runtime_response(
            &mut state,
            "set_runtime_channel",
            &json!({"type":"response","id":"req-1","ok":true,"result":{"session_id":"session-1","channel":"listen","enabled":false,"changed":true}})
        )
        .is_ok());
        assert!(!state.listen_enabled);

        // 幂等重复：changed:false 也是成功，并写入生效值。
        assert!(reduce_runtime_response(
            &mut state,
            "set_runtime_channel",
            &json!({"type":"response","id":"req-2","ok":true,"result":{"session_id":"session-1","channel":"listen","enabled":false,"changed":false}})
        )
        .is_ok());
        assert!(!state.listen_enabled);

        assert!(reduce_runtime_response(
            &mut state,
            "set_speak_muted",
            &json!({"type":"response","id":"req-3","ok":true,"result":{"session_id":"session-1","muted":true,"changed":true}})
        )
        .is_ok());
        assert!(state.speak_muted);

        let error = reduce_runtime_response(
            &mut state,
            "set_runtime_channel",
            &json!({"type":"response","id":"req-4","ok":false,"error":{"code":"session_mismatch","message":"会话已结束或已被替换。"}}),
        )
        .unwrap_err();
        assert_eq!(error, "会话已结束或已被替换。");
        assert_eq!(state.last_error.as_ref().unwrap().code, "session_mismatch");

        assert_eq!(
            runtime_error_message("channel_not_configured", ""),
            "该通道未在设置中启用。"
        );
        assert_eq!(
            runtime_error_message("internal_error", ""),
            "翻译引擎内部错误，请重试。"
        );
        assert_eq!(
            runtime_error_message("weird_code", "服务端原始说明"),
            "服务端原始说明"
        );
        assert_eq!(
            runtime_error_message("weird_code", ""),
            "翻译引擎返回了未知错误。"
        );
    }

    #[test]
    fn default_shortcut_table_matches_the_action_order() {
        let settings = ShortcutSettings::default();
        let bindings = shortcut_bindings(&settings);
        let table: Vec<(&str, RuntimeAction)> = bindings.to_vec();
        assert_eq!(
            table,
            vec![
                ("Ctrl+Shift+Space", RuntimeAction::StartOrStopSession),
                ("Ctrl+Shift+M", RuntimeAction::ToggleSpeakMute),
                ("Ctrl+Shift+O", RuntimeAction::ToggleSubtitleWindow),
                ("Ctrl+Shift+L", RuntimeAction::ToggleListenChannel),
                ("Ctrl+Shift+S", RuntimeAction::ToggleSpeakChannel),
            ]
        );

        // Each configured accelerator must resolve to a unique id for dispatch.
        let ids: Vec<u32> = bindings
            .iter()
            .map(|(accelerator, _)| {
                accelerator
                    .parse::<Shortcut>()
                    .expect("default accelerator must parse")
                    .id()
            })
            .collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
    }

    #[test]
    fn shortcut_action_mapping_uses_saved_accelerators() {
        let mut settings = ShortcutSettings::default();
        settings.toggle_subtitle_window = "Alt+F8".into();
        assert_eq!(
            shortcut_bindings(&settings)[2],
            ("Alt+F8", RuntimeAction::ToggleSubtitleWindow)
        );
    }

    #[test]
    fn debounce_swallows_repeats_inside_the_window() {
        let hub = RuntimeHub::default();
        let start = Instant::now();

        assert!(hub.should_fire(RuntimeAction::StartOrStopSession, start));
        assert!(!hub.should_fire(
            RuntimeAction::StartOrStopSession,
            start + Duration::from_millis(249)
        ));
        assert!(hub.should_fire(RuntimeAction::StartOrStopSession, start + DEBOUNCE_WINDOW));

        // 不同 action 各自维护 last_fired。
        assert!(hub.should_fire(RuntimeAction::ToggleSubtitleWindow, start));
        assert!(!hub.should_fire(RuntimeAction::ToggleSubtitleWindow, start));
        assert!(hub.should_fire(
            RuntimeAction::ToggleSubtitleWindow,
            start + Duration::from_millis(250)
        ));
    }

    #[test]
    fn session_gate_is_held_while_a_session_action_is_running() {
        let hub = RuntimeHub::default();
        {
            let _gate = hub
                .session_gate
                .try_lock()
                .expect("first caller takes the gate");
            assert!(
                hub.session_gate.try_lock().is_err(),
                "starting/stopping 期间第二次触发必须拿不到闸门"
            );
        }
        assert!(hub.session_gate.try_lock().is_ok());
        assert!(!hub.is_quitting());
        hub.begin_quit();
        assert!(hub.is_quitting());
    }

    #[test]
    fn shortcut_failure_serializes_for_the_frontend() {
        let failure = ShortcutFailure {
            accelerator: "Ctrl+Shift+Space".to_string(),
            action: RuntimeAction::StartOrStopSession,
            reason: "already registered".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            json!({
                "accelerator": "Ctrl+Shift+Space",
                "action": "start_or_stop_session",
                "reason": "already registered"
            })
        );
    }

    #[test]
    fn rfc3339_timestamps_are_utc_and_well_formed() {
        assert_eq!(rfc3339_from_unix_seconds(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339_from_unix_seconds(951_782_400),
            "2000-02-29T00:00:00Z"
        );
        assert_eq!(
            rfc3339_from_unix_seconds(1_700_000_000),
            "2023-11-14T22:13:20Z"
        );
        let now = rfc3339_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z'), "{now}");
    }
}
