import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  LoaderCircle,
  MessageSquareDashed,
  Mic,
  Languages,
  Radio,
  RefreshCw,
  Settings,
  Square,
  Timer,
  Trash2,
  Volume2,
  Waves,
  X,
} from "lucide-react";

import { SettingsDialog } from "./SettingsDialog";
import { AmbientVisualizer } from "./AmbientVisualizer";
import { ResizeHandles, WindowControls } from "./TitleBar";
import { isConfigurationComplete, translatorApi } from "./tauri";
import {
  IDLE_HEALTH,
  createEmptyQueue,
  createInitialSnapshot,
  type AppSnapshot,
  type CaptionSegment,
  type HealthStatus,
  type SessionPhase,
  type SessionState,
  type SettingsDraft,
  type TranslatorEvent,
} from "./types";
import { WaveformCanvas } from "./WaveformCanvas";

const MAX_VISIBLE_HISTORY = 40;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

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

function formatCaptionTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
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

function sessionCanReceive(
  event: TranslatorEvent,
  snapshot: AppSnapshot,
): boolean {
  if (event.type === "settings") return true;
  const incomingSessionId = event.data.sessionId;
  if (incomingSessionId === snapshot.session.sessionId) return true;

  // The first "starting" event may arrive before startSession() resolves.
  if (
    !snapshot.session.sessionId &&
    event.type === "session" &&
    event.data.payload.phase === "starting" &&
    incomingSessionId
  ) {
    return true;
  }

  // Configuration errors are intentionally not tied to a live session.
  return (
    !incomingSessionId &&
    event.type === "error" &&
    event.data.payload.service === "configuration"
  );
}

function applyTranslatorEvent(
  snapshot: AppSnapshot,
  event: TranslatorEvent,
): AppSnapshot {
  if (
    event.data.revision < snapshot.revision ||
    !sessionCanReceive(event, snapshot)
  )
    return snapshot;
  const revision = Math.max(snapshot.revision, event.data.revision);

  if (event.type === "session") {
    const { health, channels, deviceNames, ...rest } = event.data.payload;
    const session: SessionState = { ...snapshot.session, ...rest };
    // Health and per-channel state arrive one entry at a time, so merge instead
    // of replacing the whole map.
    if (health) session.health = { ...snapshot.session.health, ...health };
    if (channels)
      session.channels = { ...snapshot.session.channels, ...channels };
    if (deviceNames)
      session.deviceNames = { ...snapshot.session.deviceNames, ...deviceNames };
    if (event.data.sessionId && !("sessionId" in event.data.payload)) {
      session.sessionId = event.data.sessionId;
    }
    return { ...snapshot, revision, session };
  }

  if (event.type === "caption") {
    const caption = event.data.payload;
    const index = snapshot.captions.findIndex((item) => item.id === caption.id);
    const captions = [...snapshot.captions];
    if (index === -1) captions.push(caption);
    else
      captions[index] = {
        ...captions[index],
        ...caption,
        createdAt: captions[index].createdAt,
      };
    captions.sort((left, right) => left.sequence - right.sequence);
    return {
      ...snapshot,
      revision,
      captions: captions.slice(-MAX_VISIBLE_HISTORY),
    };
  }

  if (event.type === "queue") {
    return {
      ...snapshot,
      revision,
      session: { ...snapshot.session, queue: event.data.payload },
    };
  }

  if (event.type === "error") {
    const health = { ...snapshot.session.health };
    if (event.data.payload.service === "audio") health.audio = "failed";
    if (event.data.payload.service === "recognition")
      health.recognition = "failed";
    if (event.data.payload.service === "translation")
      health.translation = "failed";
    return {
      ...snapshot,
      revision,
      session: {
        ...snapshot.session,
        lastError: event.data.payload,
        health,
      },
    };
  }

  return { ...snapshot, revision, settings: event.data.payload };
}

function formatCaptionHistory(captions: CaptionSegment[]): string {
  return captions
    .map((caption) => {
      const source = `${formatCaptionTime(caption.createdAt)}  ${caption.sourceText}`;
      const translation =
        caption.translationText ?? `（${captionStatusLabel(caption)}）`;
      return `${source}\n${translation}`;
    })
    .join("\n\n");
}

function captionStatusLabel(caption: CaptionSegment): string {
  const labels: Record<CaptionSegment["status"], string> = {
    queued: "等待翻译",
    translating: "正在翻译",
    translated: "已翻译",
    timed_out: "翻译超时",
    failed: "翻译失败",
    dropped: "为保持实时性已跳过",
  };
  return labels[caption.status];
}

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
        <strong className="status-tile__value">{value}</strong>
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
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dismissedErrorId, setDismissedErrorId] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const applyEvent = useCallback((event: TranslatorEvent) => {
    setSnapshot((current) => applyTranslatorEvent(current, event));
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
            initial.revision >= current.revision ? initial : current,
          );
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

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const session = snapshot.session;
  const active =
    session.phase === "starting" ||
    session.phase === "listening" ||
    session.phase === "stopping";
  const elapsed = useElapsed(session.startedAt, active);
  // A stopped session keeps its history below, but the live stage must not
  // imply that its final subtitle is still being translated.
  const currentCaption = active
    ? (snapshot.captions[snapshot.captions.length - 1] ?? null)
    : null;
  const visibleError =
    session.lastError && session.lastError.id !== dismissedErrorId
      ? session.lastError
      : null;
  const queueRatio =
    session.queue.limit > 0 ? session.queue.pending / session.queue.limit : 0;
  const queueTone =
    queueRatio >= 0.75 ? "warning" : queueRatio > 0 ? "active" : "idle";

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

  const handleSessionControl = async () => {
    if (actionPending || session.phase === "stopping") return;
    if (session.phase === "needs_configuration") {
      setSettingsOpen(true);
      return;
    }

    setActionPending(true);
    try {
      if (session.phase === "starting" || session.phase === "listening") {
        setSnapshot((current) => ({
          ...current,
          session: {
            ...current.session,
            phase: "stopping",
            partialTranscript: "",
          },
        }));
        await translatorApi.stopSession(session.sessionId);
        setSnapshot((current) => ({
          ...current,
          session: {
            ...current.session,
            phase: "idle",
            sessionId: null,
            startedAt: null,
            partialTranscript: "",
            health: { ...IDLE_HEALTH },
            queue: createEmptyQueue(),
            lastError: null,
          },
        }));
      } else {
        const result = await translatorApi.startSession();
        setDismissedErrorId(null);
        setSnapshot((current) => {
          if (current.session.sessionId === result.sessionId) return current;
          return {
            ...current,
            session: {
              ...current.session,
              phase: "starting",
              sessionId: result.sessionId,
              startedAt: new Date().toISOString(),
              partialTranscript: "",
            },
          };
        });
      }
    } catch (error) {
      const message = errorMessage(error, "无法更新同传会话状态。");
      if (session.phase === "starting" || session.phase === "listening") {
        setSnapshot((current) => ({
          ...current,
          session: {
            ...current.session,
            phase: "idle",
            sessionId: null,
            startedAt: null,
            partialTranscript: "",
            health: { ...IDLE_HEALTH },
            queue: createEmptyQueue(),
            lastError: {
              id: `stop-${Date.now()}`,
              service: "system",
              title: "停止会话失败",
              message,
              recoverable: true,
            },
          },
        }));
      } else {
        writeLocalError("会话操作失败", message);
      }
    } finally {
      setActionPending(false);
    }
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
      session.phase === "error" ||
      session.phase === "idle" ||
      session.phase === "needs_configuration"
    ) {
      void handleSessionControl();
    }
  };

  const stageTranslation = currentCaption?.translationText;
  const stageTranslationState =
    currentCaption && currentCaption.status !== "translated";
  const realtimeEngine = snapshot.settings.engine === "realtime";
  const liveChannel = session.partialChannel;
  const channelTone: HealthStatus = worstHealth([
    session.channels.listen,
    session.channels.speak,
  ]);
  const activeChannelNames = realtimeEngine
    ? (["listen", "speak"] as const).filter(
        (id) => snapshot.settings.audio[id].enabled,
      )
    : [];
  // "收听 · 对方" reads better than a bare channel name, and the label follows
  // whichever direction is currently speaking.
  const partialChannelLabel =
    liveChannel === "speak"
      ? "我正在说"
      : liveChannel === "listen"
        ? "对方在说"
        : "";

  return (
    <main className="app-shell">
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
              <Languages size={25} aria-hidden="true" />
            </div>
          </header>
          <AmbientVisualizer
            active={session.phase === "listening"}
            strength={session.partialTranscript ? 0.9 : 0.36}
          />
          <div className="ambient-footer">
            <div className="ambient-session-label">
              <span>会话状态</span>
              <span>{realtimeEngine ? "双向同传" : "语音翻译"}</span>
            </div>
            <section className="status-tiles" aria-label="会话状态">
              <StatusTile
                icon={Volume2}
                label="音频"
                value={session.deviceName ?? "等待设备"}
                trailing={
                  <span
                    className={statusClass(
                      realtimeEngine ? channelTone : session.health.audio,
                    )}
                    aria-label={healthLabel(
                      realtimeEngine ? channelTone : session.health.audio,
                    )}
                  />
                }
              />
              {realtimeEngine ? (
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
              ) : (
                <StatusTile
                  icon={Radio}
                  label="语音识别"
                  value={healthLabel(session.health.recognition)}
                  trailing={
                    <span
                      className={statusClass(session.health.recognition)}
                      aria-label={healthLabel(session.health.recognition)}
                    />
                  }
                />
              )}
              <StatusTile
                icon={Waves}
                label="翻译队列"
                value={`${session.queue.pending} / ${session.queue.limit}`}
                trailing={
                  <span
                    className={`queue-indicator queue-indicator--${queueTone}`}
                    aria-label={`队列 ${session.queue.pending} / ${session.queue.limit}`}
                  />
                }
              />
              <StatusTile
                icon={Timer}
                label="本轮时长"
                value={formatElapsed(session.startedAt, elapsed)}
              />
              {session.queue.skipped > 0 && (
                <p className="skipped-note">
                  为保持实时性已跳过 {session.queue.skipped} 句
                </p>
              )}
            </section>
          </div>
        </aside>

        <div className="translation-panel">
          <header className="integrated-titlebar" data-tauri-drag-region>
            <WindowControls />
          </header>
          <div className="translation-scroll">
            <div className="translation-toolbar">
              <div
                className={`session-chip session-chip--${session.phase}`}
                aria-live="polite"
              >
                {session.phase === "starting" ||
                session.phase === "stopping" ? (
                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                ) : (
                  <span className="session-chip__dot" aria-hidden="true" />
                )}
                <span>{loading ? "正在加载" : phaseLabel(session.phase)}</span>
              </div>
              <button
                className="language-pair"
                type="button"
                onClick={() => setSettingsOpen(true)}
                disabled={active}
                aria-label="设置翻译语言"
                title={active ? "请先停止同传后修改语言" : "设置翻译语言"}
              >
                <span>{snapshot.settings.sourceLanguage}</span>
                <span className="language-pair__arrow" aria-hidden="true">
                  →
                </span>
                <strong>{snapshot.settings.targetLanguage}</strong>
              </button>
            </div>
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
                    active={session.phase === "listening"}
                    strength={session.partialTranscript ? 0.9 : 0.36}
                  />
                </div>
              </div>

              <div className="partial-line" aria-live="off">
                <span className="caption-label">
                  正在识别
                  {partialChannelLabel && (
                    <em className="channel-chip">{partialChannelLabel}</em>
                  )}
                </span>
                <div className="partial-line__body">
                  <p>
                    {session.partialTranscript ||
                      (session.phase === "listening"
                        ? "正在聆听…"
                        : "等待会话开始")}
                  </p>
                  {session.partialTranslation && (
                    <p className="partial-line__translation">
                      {session.partialTranslation}
                    </p>
                  )}
                </div>
              </div>

              <div className="current-caption">
                <div className="current-caption__source">
                  <span className="caption-label">原文</span>
                  <p>{currentCaption?.sourceText ?? "等待语音输入"}</p>
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
                    <p
                      aria-live="polite"
                      className={
                        !stageTranslation ? "is-placeholder" : undefined
                      }
                    >
                      {stageTranslation ?? "等待翻译"}
                    </p>
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
                onClick={() => void handleSessionControl()}
                disabled={
                  loading || actionPending || session.phase === "stopping"
                }
                aria-label={
                  session.phase === "needs_configuration"
                    ? "配置同传"
                    : active
                      ? "停止同传"
                      : "开始同传"
                }
                aria-pressed={active}
                title={
                  session.phase === "needs_configuration"
                    ? "配置同传"
                    : active
                      ? "停止同传"
                      : "开始同传"
                }
              >
                {actionPending ||
                session.phase === "starting" ||
                session.phase === "stopping" ? (
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
            <span className="session-controls__label" role="status">
              {loading
                ? "正在加载"
                : session.phase === "needs_configuration"
                  ? "配置同传"
                  : session.phase === "stopping"
                    ? "正在停止"
                    : active
                      ? phaseLabel(session.phase)
                      : "开始同传"}
            </span>
          </footer>
        </div>
      </div>

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          {toast}
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={snapshot.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onValidate={(draft) => translatorApi.validateSettings(draft)}
        />
      )}
    </main>
  );
}
