/**
 * Translator snapshot reducer and selectors.
 *
 * These helpers were lifted out of `App.tsx` unchanged so the subtitle window
 * can reuse the *same* reducer and the same revision counter instead of
 * building a second subscription protocol (docs/subtitle-window.md §4).
 *
 * This module is deliberately dependency free (type-only import from
 * `./types`), so `node --experimental-strip-types --test` can load it directly.
 */

import type {
  AppSnapshot,
  CaptionSegment,
  ChannelId,
  EngineError,
  ErrorService,
  RuntimeState,
  SessionPhase,
  TranslatorEvent,
} from "./types";

export const MAX_VISIBLE_HISTORY = 40;

export function isSessionActive(phase: SessionPhase): boolean {
  return phase === "starting" || phase === "listening" || phase === "stopping";
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

export function formatCaptionTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function captionStatusLabel(caption: CaptionSegment): string {
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

export function formatCaptionHistory(captions: CaptionSegment[]): string {
  return captions
    .map((caption) => {
      const source = `${formatCaptionTime(caption.createdAt)}  ${caption.sourceText}`;
      const translation =
        caption.translationText ?? `（${captionStatusLabel(caption)}）`;
      return `${source}\n${translation}`;
    })
    .join("\n\n");
}

/**
 * `error.service` was added by docs/runtime-channel-control.md §4.4
 * (audio | network | configuration | system) and is the authoritative
 * classifier: `code` is shown as detail only.
 *
 * The legacy `scope` mapping is kept as the fallback for older sidecars.
 */
export function errorServiceFromEvent(
  rawService: unknown,
  scope: string,
): ErrorService {
  if (
    rawService === "audio" ||
    rawService === "network" ||
    rawService === "configuration" ||
    rawService === "system"
  ) {
    return rawService;
  }
  if (scope === "audio") return "audio";
  if (scope === "asr") return "recognition";
  if (scope === "translation") return "translation";
  return "system";
}

/** Display title for a classified engine error. `code` only refines wording. */
export function engineErrorTitle(service: ErrorService, code: string): string {
  if (service === "audio") {
    return code === "audio_playback_failed" ? "译文播放失败" : "音频采集失败";
  }
  if (service === "recognition") return "语音识别失败";
  if (service === "translation") return "翻译服务失败";
  if (service === "network") return "网络连接异常";
  if (service === "configuration") return "配置有问题";
  return "翻译引擎错误";
}

export function sessionCanReceive(
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

export function applyTranslatorEvent(
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
    const session = { ...snapshot.session, ...rest };
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
    return {
      ...snapshot,
      revision,
      session,
    };
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
    // `sequence` is local to a sidecar session. Timestamps keep records in
    // arrival order when the UI survives a stop/start cycle.
    captions.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id),
    );
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
    if (event.data.payload.service === "network") health.translation = "failed";
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

/** Native lifecycle updates also arrive when a stopped sidecar cannot emit. */
export function reconcileRuntimeSession(
  snapshot: AppSnapshot,
  runtime: RuntimeState | null,
): AppSnapshot {
  if (!runtime) return snapshot;
  const phase =
    runtime.sessionPhase === "idle" && snapshot.session.phase === "needs_configuration"
      ? "needs_configuration"
      : runtime.sessionPhase;
  const replaced = snapshot.session.sessionId !== runtime.sessionId;
  if (!replaced && snapshot.session.phase === phase) return snapshot;

  if (!replaced) {
    return {
      ...snapshot,
      session: {
        ...snapshot.session,
        phase,
        ...(phase === "stopping"
          ? { partialTranscript: "", partialTranslation: "", partialChannel: null }
          : {}),
      },
    };
  }

  const health = runtime.sessionId ? "connecting" : "unknown";
  return {
    ...snapshot,
    // Runtime and translator revisions are separate counters; keep this one.
    session: {
      ...snapshot.session,
      phase,
      sessionId: runtime.sessionId,
      startedAt: runtime.sessionId ? runtime.updatedAt : null,
      deviceName: null,
      partialTranscript: "",
      partialTranslation: "",
      partialChannel: null,
      deviceNames: {},
      channels: {
        listen: runtime.listenEnabled ? health : "unknown",
        speak: runtime.speakEnabled ? health : "unknown",
      },
      health: { audio: health, recognition: health, translation: health },
      queue: { ...snapshot.session.queue, pending: 0, skipped: 0, lagMs: 0 },
      lastError: null,
    },
  };
}

export function applyRuntimeTranslatorEvent(
  snapshot: AppSnapshot,
  event: TranslatorEvent,
  runtime: RuntimeState | null,
): AppSnapshot {
  const current = reconcileRuntimeSession(snapshot, runtime);
  if (
    runtime &&
    event.type !== "settings" &&
    event.data.sessionId !== runtime.sessionId &&
    !(event.type === "error" && !event.data.sessionId && event.data.payload.service === "configuration")
  ) {
    return current;
  }
  return reconcileRuntimeSession(applyTranslatorEvent(current, event), runtime);
}

/** Captions belonging to the currently attached session only. */
export function sessionCaptions(snapshot: AppSnapshot): CaptionSegment[] {
  const sessionId = snapshot.session.sessionId;
  if (!sessionId) return [];
  return snapshot.captions.filter((caption) => caption.sessionId === sessionId);
}

export function latestSessionCaption(
  snapshot: AppSnapshot,
): CaptionSegment | null {
  return sessionCaptions(snapshot).reduce<CaptionSegment | null>(
    (latest, caption) =>
      !latest || compareCaptions(caption, latest) > 0 ? caption : latest,
    null,
  );
}

function compareCaptions(left: CaptionSegment, right: CaptionSegment): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

export interface SubtitleLine {
  id: string;
  sourceText: string;
  translationText: string;
  status: CaptionSegment["status"];
  statusLabel: string;
  channel: ChannelId | null;
  createdAt: string;
  /** Still translating, timed out, failed or dropped. */
  pending: boolean;
}

export interface SubtitleView {
  sessionId: string | null;
  active: boolean;
  /** Live (partial) source line. */
  source: string;
  /** Live (partial) translation line. */
  translation: string;
  /** The newest completed or in-flight caption in the active session. */
  current: SubtitleLine | null;
}

export function toSubtitleLine(caption: CaptionSegment): SubtitleLine {
  return {
    id: caption.id,
    sourceText: caption.sourceText,
    translationText: caption.translationText ?? "",
    status: caption.status,
    statusLabel: captionStatusLabel(caption),
    channel: caption.channel ?? null,
    createdAt: caption.createdAt,
    pending: caption.status !== "translated",
  };
}

/**
 * Single selector for the subtitle overlay. The overlay is intentionally
 * single-sentence: it exposes the live line and the newest caption only, so
 * persisted captions or earlier turns cannot become visible subtitle rows.
 */
export function selectSubtitleView(snapshot: AppSnapshot): SubtitleView {
  const session = snapshot.session;
  const active = isSessionActive(session.phase);
  const current = active ? latestSessionCaption(snapshot) : null;
  return {
    sessionId: session.sessionId,
    active,
    source: session.partialTranscript,
    translation: session.partialTranslation,
    current: current ? toSubtitleLine(current) : null,
  };
}
