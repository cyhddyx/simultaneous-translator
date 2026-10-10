import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Captions,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Copy,
  Headphones,
  LoaderCircle,
  MessageSquareDashed,
  Mic,
  Radio,
  RefreshCw,
  Settings,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
  Volume2,
  VolumeX,
  Waves,
  WifiOff,
  X,
} from "./PixelIcons";

import { SettingsDialog } from "./SettingsDialog";
import { CaptionTail } from "./CaptionTail";
import { ResizeHandles, WindowControls } from "./TitleBar";
import { isConfigurationComplete, translatorApi } from "./tauri";
import {
  applyRuntimeState,
  describeRuntimeActionResult,
  describeRuntimeChange,
  runtimeChangeSignature,
  runtimeCoversService,
  runtimeErrorRows,
  shortcutFailureNotice,
  trayStatusLabel,
  type RuntimeChangeKind,
} from "./runtime";
import {
  applyRuntimeTranslatorEvent,
  captionStatusLabel,
  errorMessage,
  formatCaptionHistory,
  formatCaptionTime,
  isSessionActive,
  latestSessionCaption,
  reconcileRuntimeSession,
} from "./snapshot";
import {
  createInitialSnapshot,
  type AppSnapshot,
  type CaptionSegment,
  type HealthStatus,
  type RuntimeAction,
  type RuntimeState,
  type SessionPhase,
  type SettingsDraft,
  type TrayStatus,
  type TranslatorEvent,
} from "./types";
import { WaveformCanvas } from "./WaveformCanvas";

function formatElapsed(startedAt: string | null, now: number): string {
  if (!startedAt) return "00:00";
  const duration = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  const minutes = Math.floor(duration / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (duration % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function phaseLabel(phase: SessionPhase): string {
  const labels: Record<SessionPhase, string> = {
    needs_configuration: "需要设置",
    idle: "准备就绪",
    starting: "正在连接",
    listening: "正在监听",
    stopping: "正在停止",
    error: "需要处理",
  };
  return labels[phase];
}

function healthLabel(health: HealthStatus): string {
  const labels: Record<HealthStatus, string> = {
    unknown: "未连接",
    connecting: "连接中",
    ready: "已连接",
    degraded: "不稳定",
    failed: "不可用",
  };
  return labels[health];
}

function statusClass(health: HealthStatus): string {
  return `status-dot status-dot--${health}`;
}

/** The least healthy entry wins, so a single dead channel is never hidden. */
function worstHealth(statuses: HealthStatus[]): HealthStatus {
  const order: HealthStatus[] = [
    "failed",
    "degraded",
    "connecting",
    "unknown",
    "ready",
  ];
  for (const candidate of order) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "unknown";
}

function channelLabel(health: HealthStatus): string {
  if (health === "ready") return "就绪";
  if (health === "failed") return "失败";
  if (health === "connecting") return "连接中";
  if (health === "degraded") return "不稳定";
  return "待机";
}

/** Five-state tray status: icon + text + colour, never colour alone. */
const TRAY_STATUS_ICONS: Record<TrayStatus, typeof Volume2> = {
  not_started: CircleDashed,
  connecting: LoaderCircle,
  translating: CheckCircle2,
  audio_error: VolumeX,
  network_error: WifiOff,
};

function useElapsed(startedAt: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  return now;
}

function StatusTile({
  icon: Icon,
  label,
  value,
  trailing,
}: {
  icon: typeof Volume2;
  label: string;
  value: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="status-tile">
      <span className="status-tile__icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="status-tile__copy">
        <span className="status-tile__label">{label}</span>
        <strong className="status-tile__value" title={value}>{value}</strong>
      </div>
      {trailing}
    </div>
  );
}

function CaptionStatus({ caption }: { caption: CaptionSegment }) {
  if (caption.status === "translated") {
    return (
      <span className="caption-state caption-state--translated">
        <CheckCircle2 size={14} aria-hidden="true" />
        已翻译
      </span>
    );
  }

  if (caption.status === "translating" || caption.status === "queued") {
    return (
      <span className="caption-state caption-state--working">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        {captionStatusLabel(caption)}
      </span>
    );
  }

  return (
    <span className="caption-state caption-state--error">
      <CircleAlert size={14} aria-hidden="true" />
      {captionStatusLabel(caption)}
    </span>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() =>
    createInitialSnapshot(),
  );
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dismissedErrorId, setDismissedErrorId] = useState<string | null>(null);
  const [dismissedRuntimeErrors, setDismissedRuntimeErrors] = useState<string[]>(
    [],
  );
  const [dismissedShortcutNotice, setDismissedShortcutNotice] = useState<
    string | null
  >(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const runtimeUnsubscribeRef = useRef<(() => void) | null>(null);
  const historyHydratedRef = useRef(false);
  // Last applied runtime state, so a change can be classified before rendering.
  const runtimeRef = useRef<RuntimeState | null>(null);
  const acceptedRuntimeRef = useRef<RuntimeState | null>(null);
  // Set by a local dispatch so the resulting state change does not toast twice.
  const suppressRuntimeToastRef = useRef<{
    signature: RuntimeChangeKind;
    revision: number;
  } | null>(null);
  const actionPendingRef = useRef(false);

  const applyEvent = useCallback((event: TranslatorEvent) => {
    setSnapshot((current) =>
      applyRuntimeTranslatorEvent(current, event, acceptedRuntimeRef.current),
    );
  }, []);

  const applyRuntimeEvent = useCallback((incoming: RuntimeState) => {
    const next = applyRuntimeState(acceptedRuntimeRef.current, incoming);
    if (next === acceptedRuntimeRef.current) return;
    acceptedRuntimeRef.current = next;
    setRuntime(next);
    setSnapshot((current) => reconcileRuntimeSession(current, next));
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = async () => {
      try {
        const unsubscribe = await translatorApi.subscribe(applyEvent);
        if (disposed) {
          unsubscribe();
          return;
        }
        unsubscribeRef.current = unsubscribe;
        const initial = await translatorApi.getSnapshot();
        if (!disposed) {
          setSnapshot((current) =>
            reconcileRuntimeSession(
              initial.revision >= current.revision ? initial : current,
              acceptedRuntimeRef.current,
            ),
          );
          historyHydratedRef.current = true;
        }
      } catch (error) {
        if (!disposed) {
          setSnapshot((current) => ({
            ...current,
            session: {
              ...current.session,
              phase: "error",
              lastError: {
                id: `bootstrap-${Date.now()}`,
                service: "system",
                title: "无法连接翻译引擎",
                message: errorMessage(error, "应用服务未能初始化。"),
                recoverable: true,
              },
            },
          }));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void connect();
    return () => {
      disposed = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [applyEvent]);

  // Tray menu item "设置" (tray-shortcuts-contract §9): the native layer shows
  // this window and then emits `open-settings`; the dialog is the only thing
  // left for the frontend to do. Also keeps the tray item from being the one
  // menu entry that shows a window without opening its target.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void translatorApi
      .subscribeOpenSettings(() => setSettingsOpen(true))
      .then((dispose) => {
        // React Strict Mode subscribes twice while verifying cleanup, and the
        // first cleanup runs before this promise resolves: drop the stale
        // registration instead of leaking it.
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        console.warn("托盘设置事件不可用：", errorMessage(error, "未知原因"));
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);

  // Runtime state (tray status, runtime channels, mute, shortcut failures) is
  // owned by the native layer; this window only mirrors it.
  useEffect(() => {
    let disposed = false;

    const connect = async () => {
      try {
        const unsubscribe =
          await translatorApi.subscribeRuntimeState(applyRuntimeEvent);
        if (disposed) {
          unsubscribe();
          return;
        }
        runtimeUnsubscribeRef.current = unsubscribe;
        const initial = await translatorApi.getRuntimeState();
        if (!disposed) {
          applyRuntimeEvent(initial);
        }
      } catch (error) {
        // A native build without the runtime channel must not break captions:
        // the runtime bar stays hidden and every action still reports its own
        // error when pressed.
        console.warn(
          "运行时状态不可用：",
          errorMessage(error, "未知原因"),
        );
      }
    };

    void connect();
    return () => {
      disposed = true;
      runtimeUnsubscribeRef.current?.();
      runtimeUnsubscribeRef.current = null;
    };
  }, [applyRuntimeEvent]);

  // Tray menu and global shortcuts change the runtime state without touching
  // this window, so every observed transition becomes a short toast. A change
  // caused by a local button press is suppressed: that button already reported
  // its own result.
  useEffect(() => {
    const previous = runtimeRef.current;
    runtimeRef.current = runtime;
    if (!previous || !runtime) return;
    if (runtime.revision <= previous.revision) return;
    const signature = runtimeChangeSignature(previous, runtime);
    if (!signature) return;
    const expected = suppressRuntimeToastRef.current;
    suppressRuntimeToastRef.current = null;
    if (
      expected &&
      expected.signature === signature &&
      expected.revision === runtime.revision
    ) {
      return;
    }
    const message = describeRuntimeChange(previous, runtime);
    if (message) setToast(message);
  }, [runtime]);

  useEffect(() => {
    if (historyHydratedRef.current) {
      translatorApi.persistCaptionHistory(snapshot.captions);
    }
  }, [snapshot.captions]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const session = snapshot.session;
  // The native runtime state owns the session phase.
  //
  // `needs_configuration` is the ONLY sanctioned exception — see
  // docs/runtime-channel-control.md §1.6: sidecar `state` events are the only
  // source of `sessionPhase` and the sidecar has no notion of an incomplete
  // configuration, so Rust never reports `needs_configuration`. Overriding the
  // phase keeps "开始同传" pointing at the settings dialog instead of failing;
  // it is not, and must never become, a derivation of `trayStatus`
  // (tray-shortcuts-contract §12.4).
  const phase: SessionPhase = runtime
    ? runtime.sessionPhase === "idle" && session.phase === "needs_configuration"
      ? session.phase
      : runtime.sessionPhase
    : session.phase;
  const active = isSessionActive(phase);
  const elapsed = useElapsed(session.startedAt, active);
  // A stopped session keeps its history below, but the live stage must not
  // imply that its final subtitle is still being translated.
  const currentCaption = active ? latestSessionCaption(snapshot) : null;
  const showCaptionCompanion =
    !currentCaption && !session.partialTranscript && !session.partialTranslation;
  const writeLocalError = useCallback((title: string, message: string) => {
    setSnapshot((current) => ({
      ...current,
      session: {
        ...current.session,
        lastError: {
          id: `local-${Date.now()}`,
          service: "system",
          title,
          message,
          recoverable: true,
          sessionId: current.session.sessionId,
        },
      },
    }));
  }, []);

  /**
   * The only way this window changes session or channel state. Tray menu and
   * global shortcuts call the same native dispatcher, so all three entry points
   * share one implementation.
   */
  const runRuntimeAction = useCallback(
    async (action: RuntimeAction) => {
      if (actionPendingRef.current) return;
      actionPendingRef.current = true;
      setActionPending(true);
      try {
        const before = runtimeRef.current;
        const next = await translatorApi.dispatchNativeAction(action);
        const signature = runtimeChangeSignature(before, next);
        if (signature) {
          suppressRuntimeToastRef.current = { signature, revision: next.revision };
        }
        applyRuntimeEvent(next);
        setDismissedErrorId(null);
        setDismissedRuntimeErrors([]);
        const message = describeRuntimeActionResult(action, before, next);
        if (message) setToast(message);
      } catch (error) {
        // The native layer returns a ready-to-display Chinese message.
        setToast(`操作失败：${errorMessage(error, "无法执行该操作。")}`);
      } finally {
        actionPendingRef.current = false;
        setActionPending(false);
      }
    },
    [applyRuntimeEvent],
  );

  const handleSessionControl = () => {
    if (actionPendingRef.current) return;
    if (phase === "needs_configuration") {
      setSettingsOpen(true);
      return;
    }
    void runRuntimeAction("start_or_stop_session");
  };

  const handleCopy = async () => {
    if (!snapshot.captions.length) return;
    try {
      await translatorApi.copyText(formatCaptionHistory(snapshot.captions));
      setToast("最近字幕已复制");
    } catch (error) {
      writeLocalError(
        "复制失败",
        errorMessage(error, "无法将字幕复制到剪贴板。"),
      );
    }
  };

  const handleClear = async () => {
    if (!snapshot.captions.length || active) return;
    try {
      await translatorApi.clearHistory();
      setSnapshot((current) => ({ ...current, captions: [] }));
      setToast("字幕历史已清空");
    } catch (error) {
      writeLocalError("清空失败", errorMessage(error, "无法清空字幕历史。"));
    }
  };

  const handleSaveSettings = async (draft: SettingsDraft) => {
    const settings = await translatorApi.saveSettings(draft);
    setSnapshot((current) => ({
      ...current,
      settings,
      session: active
        ? current.session
        : {
            ...current.session,
            phase: isConfigurationComplete(settings)
              ? "idle"
              : "needs_configuration",
            lastError: isConfigurationComplete(settings)
              ? null
              : current.session.lastError,
          },
    }));
    setToast("设置已保存");
  };

  const retry = () => {
    setDismissedErrorId(visibleError?.id ?? null);
    // handleSessionControl opens the settings dialog for needs_configuration and
    // starts a session for idle/error; anything else is already running.
    if (
      phase === "error" ||
      phase === "idle" ||
      phase === "needs_configuration"
    ) {
      handleSessionControl();
    }
  };

  const stageTranslation = currentCaption?.translationText;
  const stageTranslationState =
    currentCaption && currentCaption.status !== "translated";
  const liveChannel = session.partialChannel;
  const activeChannelNames = (["listen", "speak"] as const).filter(
    (id) => snapshot.settings.audio[id].enabled,
  );
  const channelTone: HealthStatus = worstHealth(
    activeChannelNames.map((id) => session.channels[id]),
  );
  const voiceChannels = activeChannelNames.filter(
    (id) => snapshot.settings.audio[id].playAudio,
  );
  const outputMode =
    voiceChannels.length === 0
      ? "语音转文字"
      : voiceChannels.length === activeChannelNames.length
        ? "语音转语音"
        : "文字 / 语音";
  // "收听 · 对方" reads better than a bare channel name, and the label follows
  // whichever direction is currently speaking.
  const partialChannelLabel =
    liveChannel === "speak"
      ? "我正在说"
      : liveChannel === "listen"
        ? "对方在说"
        : "";

  const trayStatus = runtime?.trayStatus ?? null;
  const TrayIcon = trayStatus ? TRAY_STATUS_ICONS[trayStatus] : CircleDashed;
  const trayStatusText = trayStatus ? trayStatusLabel(trayStatus) : "状态不可用";
  const listenConfigured = snapshot.settings.audio.listen.enabled;
  const speakConfigured = snapshot.settings.audio.speak.enabled;
  const listenOn = runtime?.listenEnabled ?? false;
  const speakOn = runtime?.speakEnabled ?? false;
  const speakMuted = runtime?.speakMuted ?? false;
  const subtitleVisible = runtime?.subtitleVisible ?? false;
  const runtimeReady = runtime !== null;
  const runtimeRows = runtimeErrorRows(runtime);
  const visibleRuntimeRows = runtimeRows.filter(
    (row) => !dismissedRuntimeErrors.includes(row.key),
  );
  const shortcutNotice = runtime
    ? shortcutFailureNotice(runtime.shortcutFailures)
    : null;
  const showShortcutNotice =
    shortcutNotice !== null && shortcutNotice !== dismissedShortcutNotice;
  const visibleError =
    session.lastError &&
    session.lastError.id !== dismissedErrorId &&
    // Audio / network failures are reported by the runtime area, with distinct
    // wording and colour; keeping both would report one error twice.
    !runtimeCoversService(runtimeRows, session.lastError.service)
      ? session.lastError
      : null;

  const listenChannelHint = !listenConfigured
    ? "收听通道未在设置中启用"
    : !active
      ? "请先开始同传，再使用通道控制"
      : listenOn
        ? "关闭收听通道"
        : "开启收听通道";
  const speakChannelHint = !speakConfigured
    ? "发言通道未在设置中启用"
    : !active
      ? "请先开始同传，再使用通道控制"
      : speakOn
        ? "关闭发言通道"
        : "开启发言通道";
  const muteHint = !active
    ? "请先开始同传，再使用通道控制"
    : !speakOn
      ? "发言通道未开启"
      : speakMuted
        ? "取消静音"
        : "静音发言";

  return (
    <main className="app-shell app-shell--pixel">
      <ResizeHandles />

      <div className="workspace">
        <aside className="ambient-panel" aria-label="同传会话">
          <header className="ambient-heading" data-tauri-drag-region>
            <div
              className="ambient-brand"
              role="img"
              aria-label="同传翻译"
              title="同传翻译"
            >
              <img
                src="/app-icon.png"
                alt=""
                width={128}
                height={128}
                draggable={false}
                aria-hidden="true"
              />
            </div>
            <span className="ambient-heading__copy" aria-hidden="true">
              AUDIO QUEST
              <small>PLAYER 01 // LIVE RUN</small>
            </span>
          </header>
          <div
            className="ambient-visualizer-container"
            data-phase={phase}
          >
            <img
              className="ambient-device-art"
              src="/translator-console-pixel.png"
              alt="像素风掌上同传翻译器，显示中文与 English 双语字幕"
            />
          </div>
          <div className="ambient-footer">
            <div className="ambient-session-label">
              <span>会话状态</span>
              <span>
                {activeChannelNames.length === 2 ? "双向同传" : "实时同传"}
              </span>
            </div>
            <section className="status-tiles" aria-label="会话状态">
              <StatusTile
                icon={Volume2}
                label="音频"
                value={session.deviceName ?? "等待设备"}
                trailing={
                  <span
                    className={statusClass(channelTone)}
                    aria-label={healthLabel(channelTone)}
                  />
                }
              />
              <StatusTile
                icon={Radio}
                label="同传通道"
                value={
                  activeChannelNames.length
                    ? activeChannelNames
                        .map(
                          (id) =>
                            `${id === "listen" ? "收听" : "发言"} ${channelLabel(session.channels[id])}`,
                        )
                        .join(" · ")
                    : "未启用通道"
                }
                trailing={
                  <span
                    className={statusClass(channelTone)}
                    aria-label={healthLabel(channelTone)}
                  />
                }
              />
              <StatusTile icon={Waves} label="输出模式" value={outputMode} />
              <StatusTile
                icon={Timer}
                label="本轮时长"
                value={formatElapsed(session.startedAt, elapsed)}
              />
            </section>
          </div>
        </aside>

        <div className="translation-panel">
          <header className="integrated-titlebar" data-tauri-drag-region>
            <span
              className="integrated-titlebar__title"
              data-tauri-drag-region
              aria-hidden="true"
            >
              TRANSLATION DECK <small>// ROOM 02</small>
            </span>
            <WindowControls />
          </header>
          <div className="translation-scroll-frame">
            <div
              className="translation-scroll"
              tabIndex={0}
              aria-label="翻译与会话记录"
            >
              <section className="runtime-bar" aria-label="运行时状态与通道控制">
                <span className="runtime-bar__legend" aria-hidden="true">
                  SYSTEM PANEL
                </span>
                <span
                  className={
                    trayStatus
                      ? `runtime-pill runtime-pill--${trayStatus}`
                      : "runtime-pill runtime-pill--unavailable"
                  }
                  role="status"
                  aria-live="polite"
                  title={`托盘状态：${trayStatusText}`}
                >
                  <TrayIcon
                    size={15}
                    className={trayStatus === "connecting" ? "spin" : undefined}
                    aria-hidden="true"
                  />
                  <span className="runtime-pill__label">{trayStatusText}</span>
                </span>

                <div className="runtime-switches">
                  <button
                    className={`runtime-switch${listenOn ? " is-on" : ""}`}
                    type="button"
                    onClick={() => void runRuntimeAction("toggle_listen_channel")}
                    disabled={!runtimeReady || actionPending || !active || !listenConfigured}
                    aria-pressed={listenOn}
                    aria-label={`收听通道：${listenOn ? "已开启" : "已关闭"}`}
                    title={listenChannelHint}
                  >
                    <Headphones size={15} aria-hidden="true" />
                    <span>收听</span>
                    <em>{listenOn ? "开" : "关"}</em>
                  </button>

                  <button
                    className={`runtime-switch${speakOn ? " is-on" : ""}`}
                    type="button"
                    onClick={() => void runRuntimeAction("toggle_speak_channel")}
                    disabled={!runtimeReady || actionPending || !active || !speakConfigured}
                    aria-pressed={speakOn}
                    aria-label={`发言通道：${speakOn ? "已开启" : "已关闭"}`}
                    title={speakChannelHint}
                  >
                    <Mic size={15} aria-hidden="true" />
                    <span>发言</span>
                    <em>{speakOn ? "开" : "关"}</em>
                  </button>

                  <button
                    className={`runtime-switch${speakMuted ? " is-muted" : ""}`}
                    type="button"
                    onClick={() => void runRuntimeAction("toggle_speak_mute")}
                    disabled={!runtimeReady || actionPending || !active || !speakOn}
                    aria-pressed={speakMuted}
                    aria-label={`发言静音：${speakMuted ? "已静音" : "未静音"}`}
                    title={muteHint}
                  >
                    {speakMuted ? (
                      <VolumeX size={15} aria-hidden="true" />
                    ) : (
                      <Volume2 size={15} aria-hidden="true" />
                    )}
                    <span>静音</span>
                    <em>{speakMuted ? "已静音" : "未静音"}</em>
                  </button>

                  <button
                    className={`runtime-switch${subtitleVisible ? " is-on" : ""}`}
                    type="button"
                    onClick={() => void runRuntimeAction("toggle_subtitle_window")}
                    disabled={!runtimeReady || actionPending}
                    aria-pressed={subtitleVisible}
                    aria-label={`字幕悬浮窗：${subtitleVisible ? "已显示" : "已隐藏"}`}
                    title={subtitleVisible ? "隐藏字幕悬浮窗" : "显示字幕悬浮窗"}
                  >
                    <Captions size={15} aria-hidden="true" />
                    <span>字幕窗</span>
                    <em>{subtitleVisible ? "显示中" : "已隐藏"}</em>
                  </button>
                </div>
              </section>

              <div className="translation-toolbar">
                <span className="translation-toolbar__badge" aria-hidden="true">
                  ROUND 01
                </span>
                <div
                  className={`session-chip session-chip--${phase}`}
                  aria-live="polite"
                >
                  {phase === "starting" || phase === "stopping" ? (
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <span className="session-chip__dot" aria-hidden="true" />
                  )}
                  <span>{loading ? "正在加载" : phaseLabel(phase)}</span>
                </div>
                <div className="translation-directions" aria-label="双向翻译语言">
                  {(["listen", "speak"] as const).map((id) => {
                    const channel = snapshot.settings.audio[id];
                    const Icon = id === "listen" ? Headphones : Mic;
                    const label = id === "listen" ? "我听到" : "对方听到";
                    return <button key={id}
                      className={`language-pair ${channel.enabled ? "" : "is-inactive"}`}
                      type="button" onClick={() => setSettingsOpen(true)} disabled={active}
                      aria-label={`设置${label}的语言`}
                      title={active ? "请先停止同传后修改语言" : `设置${label}的语言`}>
                      <Icon size={14} aria-hidden="true" />
                      <span>{label}</span><span className="language-pair__arrow" aria-hidden="true">→</span>
                      <strong>{channel.targetLanguage}</strong>
                      {!channel.enabled && <span className="direction-disabled">已停用</span>}
                    </button>;
                  })}
                </div>
              </div>

              {showShortcutNotice && shortcutNotice && (
                <section
                  className="runtime-notice runtime-notice--shortcut"
                  role="status"
                >
                  <TriangleAlert size={17} aria-hidden="true" />
                  <div className="runtime-notice__copy">
                    <strong>全局快捷键未全部生效</strong>
                    <span>{shortcutNotice}</span>
                  </div>
                  <button
                    className="icon-button icon-button--quiet"
                    type="button"
                    onClick={() => setDismissedShortcutNotice(shortcutNotice)}
                    aria-label="关闭快捷键提示"
                    title="关闭快捷键提示"
                  >
                    <X size={16} />
                  </button>
                </section>
              )}

              {visibleRuntimeRows.map((row) => (
                <section
                  key={row.key}
                  className={`runtime-error runtime-error--${row.service}${
                    row.severity === "warning" ? " runtime-error--warning" : ""
                  }`}
                  role={row.severity === "warning" ? "status" : "alert"}
                >
                  {row.service === "audio" ? (
                    <VolumeX size={18} aria-hidden="true" />
                  ) : row.service === "network" ? (
                    <WifiOff size={18} aria-hidden="true" />
                  ) : (
                    <CircleAlert size={18} aria-hidden="true" />
                  )}
                  <div className="runtime-error__copy">
                    <strong>{row.title}</strong>
                    <span>{row.message}</span>
                  </div>
                  <div className="runtime-error__actions">
                    {row.severity === "error" && row.recoverable && !active && (
                      // Retry reuses `start_or_stop_session` on purpose: the
                      // RuntimeAction set is frozen at the seven values in
                      // tray-shortcuts-contract §4 and a dedicated "reconnect"
                      // action would have to be added to the tray, the global
                      // shortcuts and this window at once. A future standalone
                      // reconnect must change the contract document first.
                      <button
                        className="button button--secondary button--compact"
                        type="button"
                        onClick={() => void runRuntimeAction("start_or_stop_session")}
                        disabled={actionPending}
                        title="重新开始同传"
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                        重试
                      </button>
                    )}
                    <button
                      className="icon-button icon-button--quiet"
                      type="button"
                      onClick={() =>
                        setDismissedRuntimeErrors((current) => [...current, row.key])
                      }
                      aria-label={`关闭${row.title}提示`}
                      title="关闭提示"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </section>
              ))}

              {visibleError && (
                <section className="error-banner" role="alert">
                  <CircleAlert size={18} aria-hidden="true" />
                  <div className="error-banner__copy">
                    <strong>{visibleError.title}</strong>
                    <span>{visibleError.message}</span>
                  </div>
                  <div className="error-banner__actions">
                    {visibleError.recoverable && !active && (
                      <button
                        className="button button--secondary button--compact"
                        type="button"
                        onClick={retry}
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                        重试
                      </button>
                    )}
                    {visibleError.service === "configuration" && (
                      <button
                        className="button button--secondary button--compact"
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                      >
                        设置
                      </button>
                    )}
                    <button
                      className="icon-button icon-button--quiet"
                      type="button"
                      onClick={() => setDismissedErrorId(visibleError.id)}
                      aria-label="关闭错误提示"
                      title="关闭错误提示"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </section>
              )}

              <section
                className={`panel caption-stage caption-stage--${snapshot.settings.subtitleSize}`}
                aria-labelledby="caption-stage-title"
              >
                <div className="stage-topline">
                  <div className="panel-heading">
                    <h2 id="caption-stage-title">实时翻译</h2>
                  </div>
                  <div className="waveform-wrap">
                    <WaveformCanvas
                      active={phase === "listening"}
                      strength={session.partialTranscript ? 0.9 : 0.36}
                    />
                  </div>
                </div>

                <div
                  className={`partial-line${showCaptionCompanion ? " partial-line--waiting" : ""}`}
                  aria-live="off"
                >
                  <span className="caption-label">
                    正在识别
                    {partialChannelLabel && (
                      <em className="channel-chip">{partialChannelLabel}</em>
                    )}
                  </span>
                  <div className="partial-line__body">
                    <CaptionTail lines={3}>
                      {session.partialTranscript ||
                        (phase === "listening"
                          ? "正在聆听…"
                          : "等待会话开始")}
                    </CaptionTail>
                    {session.partialTranslation && (
                      <CaptionTail lines={3} className="partial-line__translation">
                        {session.partialTranslation}
                      </CaptionTail>
                    )}
                  </div>
                  {showCaptionCompanion && (
                    <img
                      className="caption-companion"
                      src="/decorations/translator-bot.png"
                      alt=""
                      width={144}
                      height={217}
                      draggable={false}
                      aria-hidden="true"
                    />
                  )}
                </div>

                <div className="current-caption">
                  <div className="current-caption__source">
                    <span className="caption-label">原文</span>
                    <CaptionTail lines={3}>{currentCaption?.sourceText ?? "等待语音输入"}</CaptionTail>
                  </div>
                  <div className="current-caption__translation">
                    <span className="caption-label">译文</span>
                    {stageTranslationState ? (
                      <p className="translation-pending">
                        {currentCaption.status === "queued" ||
                        currentCaption.status === "translating" ? (
                          <LoaderCircle
                            size={18}
                            className="spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleAlert size={18} aria-hidden="true" />
                        )}
                        {currentCaption ? captionStatusLabel(currentCaption) : ""}
                      </p>
                    ) : (
                      <CaptionTail
                        lines={3}
                        aria-live="polite"
                        className={
                          !stageTranslation ? "is-placeholder" : undefined
                        }
                      >
                        {stageTranslation ?? "等待翻译"}
                      </CaptionTail>
                    )}
                  </div>
                </div>
              </section>

              <section
                className="panel history-section"
                aria-labelledby="history-title"
              >
                <header className="history-section__header">
                  <div className="panel-heading">
                    <h2 id="history-title">
                      会话记录{" "}
                      <span className="history-count">
                        {snapshot.captions.length}
                      </span>
                    </h2>
                  </div>
                  <img
                    className="history-section__tape"
                    src="/decorations/memory-tape.png"
                    alt=""
                    width={224}
                    height={143}
                    draggable={false}
                    aria-hidden="true"
                  />
                  <div className="history-actions">
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => void handleCopy()}
                      disabled={!snapshot.captions.length}
                      aria-label="复制最近字幕"
                      title="复制最近字幕"
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => void handleClear()}
                      disabled={!snapshot.captions.length || active}
                      aria-label="清空字幕历史"
                      title={active ? "停止同传后清空字幕历史" : "清空字幕历史"}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </header>

                {snapshot.captions.length ? (
                  <ol className="caption-history" aria-label="字幕历史">
                    {[...snapshot.captions].reverse().map((caption) => (
                      <li key={caption.id} className="caption-history__item">
                        <time dateTime={caption.createdAt}>
                          {formatCaptionTime(caption.createdAt)}
                          {caption.channel && (
                            <em className="channel-chip">
                              {caption.channel === "speak" ? "我说" : "对方"}
                            </em>
                          )}
                        </time>
                        <div className="caption-history__content">
                          <p className="history-source">{caption.sourceText}</p>
                          <p
                            className={
                              caption.status === "translated"
                                ? "history-translation"
                                : "history-translation is-pending"
                            }
                          >
                            {caption.translationText ??
                              caption.errorMessage ??
                              captionStatusLabel(caption)}
                          </p>
                        </div>
                        <CaptionStatus caption={caption} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="history-empty">
                    <span className="history-empty__icon" aria-hidden="true">
                      <MessageSquareDashed size={22} />
                    </span>
                    <p className="history-empty__title">尚无字幕记录</p>
                  </div>
                )}
              </section>
            </div>
          </div>
          <footer className="session-controls">
            <div className="control-dock">
              <button
                className="icon-button dock-secondary"
                type="button"
                onClick={() => setSettingsOpen(true)}
                disabled={active}
                aria-label="打开设置"
                title={active ? "请先停止同传后修改设置" : "设置"}
              >
                <Settings size={20} />
              </button>
              <button
                className={`microphone-button${active ? " is-active" : ""}`}
                type="button"
                onClick={handleSessionControl}
                disabled={
                  loading || actionPending || phase === "stopping"
                }
                aria-label={
                  phase === "needs_configuration"
                    ? "配置同传"
                    : active
                      ? "停止同传"
                      : "开始同传"
                }
                aria-pressed={active}
                title={
                  phase === "needs_configuration"
                    ? "配置同传"
                    : active
                      ? "停止同传"
                      : "开始同传"
                }
              >
                {actionPending ||
                phase === "starting" ||
                phase === "stopping" ? (
                  <LoaderCircle size={26} className="spin" />
                ) : active ? (
                  <Square size={24} />
                ) : (
                  <Mic size={28} />
                )}
              </button>
              <button
                className="icon-button dock-secondary"
                type="button"
                onClick={() => void handleCopy()}
                disabled={!snapshot.captions.length}
                aria-label="复制翻译记录"
                title="复制翻译记录"
              >
                <Copy size={20} />
              </button>
            </div>
            <div className="session-feedback">
              <span className="session-controls__label" role="status">
                {loading
                  ? "正在加载"
                  : phase === "needs_configuration"
                    ? "配置同传"
                    : phase === "stopping"
                      ? "正在停止"
                      : active
                        ? phaseLabel(phase)
                        : "开始同传"}
              </span>
              {toast && (
                <div className="session-message" role="status">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>{toast}</span>
                </div>
              )}
            </div>
          </footer>
        </div>
      </div>

      {settingsOpen && (
        <SettingsDialog
          settings={snapshot.settings}
          sessionActive={active}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onValidate={(draft) => translatorApi.validateSettings(draft)}
        />
      )}
    </main>
  );
}
