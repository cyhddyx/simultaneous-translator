/**
 * Runtime state helpers — tray status, runtime channel control, shortcut
 * failures and the browser mock controller.
 *
 * Contract: docs/tray-shortcuts-contract.md (§2 state, §3 trayStatus, §4 actions,
 * §5 commands, §6 events) and docs/runtime-channel-control.md (§4.2-§4.4).
 *
 * This module is deliberately dependency free (type-only import from
 * `./types`), so `node --experimental-strip-types --test` can load it directly.
 *
 * Hard rule: `trayStatus` is derived by Rust only. Nothing in the main window
 * may recompute it — `deriveMockTrayStatus` below exists solely so the browser
 * mock mirrors the native behaviour and is never used to render native state.
 */

import type {
  PublicSettings,
  RuntimeAction,
  RuntimeError,
  RuntimeHealth,
  RuntimeService,
  RuntimeState,
  SessionPhase,
  ShortcutFailure,
  TrayStatus,
} from "./types";

export const TRAY_STATUSES: TrayStatus[] = [
  "not_started",
  "connecting",
  "translating",
  "audio_error",
  "network_error",
];

export const RUNTIME_HEALTH_VALUES: RuntimeHealth[] = [
  "unknown",
  "connecting",
  "ready",
  "degraded",
  "failed",
];

export const SESSION_PHASE_VALUES: SessionPhase[] = [
  "needs_configuration",
  "idle",
  "starting",
  "listening",
  "stopping",
  "error",
];

/** Contract §3 — shared by the tray tooltip, the tray menu and the main window. */
export const TRAY_STATUS_LABELS: Record<TrayStatus, string> = {
  not_started: "未启动",
  connecting: "正在连接",
  translating: "正常翻译",
  audio_error: "音频异常",
  network_error: "网络异常",
};

export function trayStatusLabel(status: TrayStatus): string {
  return TRAY_STATUS_LABELS[status] ?? TRAY_STATUS_LABELS.not_started;
}

const RUNTIME_HEALTH_LABELS: Record<RuntimeHealth, string> = {
  unknown: "未连接",
  connecting: "连接中",
  ready: "已连接",
  degraded: "不稳定",
  failed: "不可用",
};

export function runtimeHealthLabel(health: RuntimeHealth): string {
  return RUNTIME_HEALTH_LABELS[health] ?? RUNTIME_HEALTH_LABELS.unknown;
}

export const RUNTIME_UPDATED_AT_EPOCH = "1970-01-01T00:00:00Z";

/** Contract §2 initial value: revision 0, everything idle. */
export function createInitialRuntimeState(): RuntimeState {
  return {
    revision: 0,
    trayStatus: "not_started",
    sessionPhase: "idle",
    sessionId: null,
    audioHealth: "unknown",
    networkHealth: "unknown",
    listenEnabled: false,
    speakEnabled: false,
    speakMuted: false,
    subtitleVisible: false,
    shortcutFailures: [],
    lastError: null,
    updatedAt: RUNTIME_UPDATED_AT_EPOCH,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asRevision(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function normalizeShortcutFailure(value: unknown): ShortcutFailure | null {
  const record = asRecord(value);
  const accelerator =
    typeof record.accelerator === "string" ? record.accelerator.trim() : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  if (!accelerator) return null;
  return {
    accelerator,
    action: oneOf(
      record.action,
      [
        "start_or_stop_session",
        "toggle_speak_mute",
        "toggle_listen_channel",
        "toggle_speak_channel",
        "toggle_subtitle_window",
        "show_main_window",
        "quit_application",
      ] as const,
      "show_main_window",
    ),
    reason,
  };
}

function normalizeRuntimeError(value: unknown): RuntimeError | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "string" ? record.code : "";
  if (!message && !code) return null;
  return {
    id: typeof record.id === "string" && record.id ? record.id : `runtime-error-${code || "unknown"}`,
    service: oneOf(
      record.service,
      ["audio", "network", "configuration", "system"] as const,
      "system",
    ),
    code,
    message,
    recoverable: record.recoverable !== false,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
  };
}

/**
 * Coerces an untrusted payload (native command result or `runtime-state`
 * event) into a RuntimeState. Missing fields fall back to the contract's
 * initial values instead of leaking `undefined` into the UI.
 */
export function normalizeRuntimeState(raw: unknown): RuntimeState {
  const record = asRecord(raw);
  return {
    revision: asRevision(record.revision),
    trayStatus: oneOf(record.trayStatus, TRAY_STATUSES, "not_started"),
    sessionPhase: oneOf(record.sessionPhase, SESSION_PHASE_VALUES, "idle"),
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    audioHealth: oneOf(record.audioHealth, RUNTIME_HEALTH_VALUES, "unknown"),
    networkHealth: oneOf(record.networkHealth, RUNTIME_HEALTH_VALUES, "unknown"),
    listenEnabled: asBoolean(record.listenEnabled),
    speakEnabled: asBoolean(record.speakEnabled),
    speakMuted: asBoolean(record.speakMuted),
    subtitleVisible: asBoolean(record.subtitleVisible),
    shortcutFailures: Array.isArray(record.shortcutFailures)
      ? record.shortcutFailures
          .map(normalizeShortcutFailure)
          .filter((item): item is ShortcutFailure => item !== null)
      : [],
    lastError: normalizeRuntimeError(record.lastError),
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt
        ? record.updatedAt
        : RUNTIME_UPDATED_AT_EPOCH,
  };
}

export function cloneRuntimeState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    shortcutFailures: state.shortcutFailures.map((failure) => ({ ...failure })),
    lastError: state.lastError ? { ...state.lastError } : null,
  };
}

/** True when the incoming revision is not newer than the applied one. */
export function isStaleRuntimeState(
  incoming: RuntimeState,
  current: RuntimeState | null,
): boolean {
  return current !== null && incoming.revision <= current.revision;
}

/**
 * Applies a runtime update, discarding stale revisions. Returns the previous
 * object unchanged when the update is stale, so React can skip the render.
 */
export function applyRuntimeState(
  current: RuntimeState | null,
  incoming: RuntimeState,
): RuntimeState {
  if (isStaleRuntimeState(incoming, current)) return current as RuntimeState;
  return incoming;
}

function isActivePhase(phase: SessionPhase): boolean {
  return phase === "starting" || phase === "listening" || phase === "stopping";
}

/**
 * Mock-only mirror of the Rust rule in the contract §3.
 * Never call this to render native state — read `runtime.trayStatus` instead.
 */
export function deriveMockTrayStatus(state: RuntimeState): TrayStatus {
  if (state.networkHealth === "failed") return "network_error";
  if (state.audioHealth === "failed") return "audio_error";
  if (state.sessionPhase === "starting" || state.sessionPhase === "stopping") {
    return "connecting";
  }
  if (state.sessionPhase === "listening" && state.sessionId) return "translating";
  return "not_started";
}

export type RuntimeChangeKind =
  | "session_started"
  | "session_stopped"
  | "speak_muted"
  | "speak_unmuted"
  | "listen_on"
  | "listen_off"
  | "speak_on"
  | "speak_off"
  | "subtitle_shown"
  | "subtitle_hidden"
  | "audio_error"
  | "audio_recovered"
  | "network_error"
  | "network_recovered"
  | "tray_status";

/**
 * Classifies what changed between two applied runtime states. Used to tell a
 * tray/shortcut driven change (show a toast) apart from a local button press
 * (the button already reports its own result).
 */
export function runtimeChangeSignature(
  before: RuntimeState | null,
  after: RuntimeState | null,
): RuntimeChangeKind | null {
  if (!before || !after || after.revision <= before.revision) return null;
  if (after.networkHealth === "failed" && before.networkHealth !== "failed") {
    return "network_error";
  }
  if (after.audioHealth === "failed" && before.audioHealth !== "failed") {
    return "audio_error";
  }
  if (before.networkHealth === "failed" && after.networkHealth !== "failed") {
    return "network_recovered";
  }
  if (before.audioHealth === "failed" && after.audioHealth !== "failed") {
    return "audio_recovered";
  }
  if (before.subtitleVisible !== after.subtitleVisible) {
    return after.subtitleVisible ? "subtitle_shown" : "subtitle_hidden";
  }
  if (before.speakMuted !== after.speakMuted) {
    return after.speakMuted ? "speak_muted" : "speak_unmuted";
  }
  if (before.listenEnabled !== after.listenEnabled) {
    return after.listenEnabled ? "listen_on" : "listen_off";
  }
  if (before.speakEnabled !== after.speakEnabled) {
    return after.speakEnabled ? "speak_on" : "speak_off";
  }
  if (!isActivePhase(before.sessionPhase) && isActivePhase(after.sessionPhase)) {
    return "session_started";
  }
  if (isActivePhase(before.sessionPhase) && !isActivePhase(after.sessionPhase)) {
    return "session_stopped";
  }
  if (before.trayStatus !== after.trayStatus) return "tray_status";
  return null;
}

const RUNTIME_CHANGE_TEXT: Record<RuntimeChangeKind, string> = {
  session_started: "同传已开始",
  session_stopped: "同传已停止",
  speak_muted: "发言通道已静音",
  speak_unmuted: "已取消静音",
  listen_on: "收听通道已开启",
  listen_off: "收听通道已关闭",
  speak_on: "发言通道已开启",
  speak_off: "发言通道已关闭",
  subtitle_shown: "字幕悬浮窗已显示",
  subtitle_hidden: "字幕悬浮窗已隐藏",
  audio_error: "检测到音频异常",
  audio_recovered: "音频已恢复",
  network_error: "网络连接异常",
  network_recovered: "网络已恢复",
  tray_status: "状态已更新",
};

/** Short toast text for an externally triggered change; null = stay silent. */
export function describeRuntimeChange(
  before: RuntimeState | null,
  after: RuntimeState | null,
): string | null {
  const kind = runtimeChangeSignature(before, after);
  if (!kind) return null;
  if (kind === "tray_status") {
    return `状态：${trayStatusLabel(after!.trayStatus)}`;
  }
  return RUNTIME_CHANGE_TEXT[kind];
}

/** Toast text after a local action; null when the action changed nothing. */
export function describeRuntimeActionResult(
  action: RuntimeAction,
  before: RuntimeState | null,
  after: RuntimeState,
): string | null {
  const kind = runtimeChangeSignature(before, after);
  if (!kind) return null;
  if (kind === "tray_status" || kind.endsWith("_error") || kind.endsWith("_recovered")) {
    // Failures and bare tray transitions are reported in the status / error
    // area, not as a success toast.
    return null;
  }
  const matchesAction =
    (action === "start_or_stop_session" &&
      (kind === "session_started" || kind === "session_stopped")) ||
    (action === "toggle_speak_mute" &&
      (kind === "speak_muted" || kind === "speak_unmuted")) ||
    (action === "toggle_listen_channel" &&
      (kind === "listen_on" || kind === "listen_off")) ||
    (action === "toggle_speak_channel" &&
      (kind === "speak_on" || kind === "speak_off")) ||
    (action === "toggle_subtitle_window" &&
      (kind === "subtitle_shown" || kind === "subtitle_hidden"));
  return matchesAction ? RUNTIME_CHANGE_TEXT[kind] : null;
}

export interface RuntimeErrorRow {
  /** Stable key so a dismissal survives unrelated re-renders. */
  key: string;
  service: RuntimeService;
  /** `warning` is the degraded middle state ("不稳定"), not a failure. */
  severity: "error" | "warning";
  title: string;
  message: string;
  recoverable: boolean;
}

/**
 * Rows for the main window status / error area. Audio and network problems are
 * reported separately so one never hides the other (contract §3), and a
 * degraded network keeps an intermediate wording that is distinct from a
 * failed one. Classification is by `service`, never by `code`.
 */
export function runtimeErrorRows(state: RuntimeState | null): RuntimeErrorRow[] {
  if (!state) return [];
  const errors: RuntimeErrorRow[] = [];
  const warnings: RuntimeErrorRow[] = [];
  const lastError = state.lastError;
  const errorIdFor = (service: RuntimeService) =>
    lastError && lastError.service === service ? lastError.id : `${service}-health`;
  const detailFor = (service: RuntimeService) =>
    lastError && lastError.service === service && lastError.message
      ? lastError.message
      : "";

  if (state.audioHealth === "failed") {
    errors.push({
      key: `audio:${errorIdFor("audio")}`,
      service: "audio",
      severity: "error",
      title: "音频异常",
      message: detailFor("audio") || "音频设备或采集链路不可用，请检查设备后重试。",
      // A configuration failure that merely surfaced through the audio chain
      // keeps its own row below; it never becomes retryable here.
      recoverable: lastError?.service === "audio" ? lastError.recoverable : true,
    });
  } else if (state.audioHealth === "degraded") {
    warnings.push({
      key: `audio:degraded:${errorIdFor("audio")}`,
      service: "audio",
      severity: "warning",
      title: "音频不稳定",
      message: detailFor("audio") || "音频采集不稳定，正在自动恢复。",
      recoverable: false,
    });
  }

  if (state.networkHealth === "failed") {
    errors.push({
      key: `network:${errorIdFor("network")}`,
      service: "network",
      severity: "error",
      title: "网络异常",
      message: detailFor("network") || "翻译服务连接已中断，请检查网络后重试。",
      recoverable: lastError?.service === "network" ? lastError.recoverable : true,
    });
  } else if (state.networkHealth === "degraded") {
    warnings.push({
      key: `network:degraded:${errorIdFor("network")}`,
      service: "network",
      severity: "warning",
      title: "网络不稳定",
      message: detailFor("network") || "部分翻译通道连接不稳定，正在重连。",
      recoverable: false,
    });
  }

  if (
    lastError &&
    (lastError.service === "configuration" || lastError.service === "system")
  ) {
    errors.push({
      key: `${lastError.service}:${lastError.id}`,
      service: lastError.service,
      severity: "error",
      title: lastError.service === "configuration" ? "配置问题" : "翻译引擎错误",
      message: lastError.message || "翻译引擎返回了未知错误。",
      // Configuration errors (for example an unsupported voice clone setting)
      // are not retryable: the user has to change the setting first.
      recoverable: lastError.recoverable,
    });
  }

  return [...errors, ...warnings];
}

/**
 * True when the runtime error area already reports this service, so the
 * caption-pipeline banner does not repeat the same failure.
 */
export function runtimeCoversService(
  rows: RuntimeErrorRow[],
  service: string,
): boolean {
  return rows.some((row) => row.service === service);
}

/** Readable one-shot notice for shortcut registration failures; null = none. */
export function shortcutFailureNotice(
  failures: ShortcutFailure[] | null | undefined,
): string | null {
  if (!failures || !failures.length) return null;
  const details = failures
    .map((failure) =>
      failure.reason
        ? `${failure.accelerator}（${failure.reason}）`
        : failure.accelerator,
    )
    .join("、");
  return `以下全局快捷键注册失败：${details}。可通过托盘菜单使用同样的功能。`;
}

export const RUNTIME_ACTION_LABELS: Record<RuntimeAction, string> = {
  start_or_stop_session: "开始 / 停止同传",
  toggle_speak_mute: "静音发言",
  toggle_listen_channel: "收听通道开关",
  toggle_speak_channel: "发言通道开关",
  toggle_subtitle_window: "字幕悬浮窗开关",
  show_main_window: "显示主窗口",
  quit_application: "退出应用",
};

export function runtimeActionLabel(action: RuntimeAction): string {
  return RUNTIME_ACTION_LABELS[action] ?? action;
}

/** Contract §5: subtitle window font size. */
export const SUBTITLE_FONT_PX: Record<PublicSettings["subtitleSize"], number> = {
  small: 15,
  medium: 19,
  large: 24,
};

/* ==========================================================================
   Browser mock
   The mock exposes the exact same three entry points as the native API
   (`getRuntimeState`, `dispatchNativeAction`, `subscribeRuntimeState`) and is
   used only for browser development and unit tests. It is never the
   production path: `tauri.ts` guards every call with `isTauriRuntime()`.
   ========================================================================== */

export interface MockRuntimeOptions {
  /** Simulated engine start-up latency. Tests pass 0. */
  connectDelayMs?: number;
  /** Mirrors `config.audio.<channel>.enabled` from the saved settings. */
  channelEnabled?: () => { listen: boolean; speak: boolean };
  /** Returns a readable message when a session must not start. */
  guardStart?: () => string | null;
  /** Called after the simulated session is created. */
  onSessionStarted?: (sessionId: string) => void;
  /** Called after the simulated session stops. */
  onSessionStopped?: (sessionId: string | null) => void;
}

type RuntimeStateListener = (state: RuntimeState) => void;

/**
 * Browser mock of the tray `设置` broadcast (tray-shortcuts-contract §9: the
 * tray item shows the main window and then emits `open-settings`).
 *
 * The browser demo has no tray, so nothing emits on its own — but it keeps the
 * same subscribe / unsubscribe contract as the native listener so the main
 * window has exactly one code path.
 */
export class MockOpenSettingsChannel {
  private listeners = new Set<() => void>();

  subscribe(handler: () => void): () => void {
    // Same Strict Mode guard as `subscribeRuntimeState`: two registrations of
    // the same handler reference must survive a single cleanup.
    const registration = () => handler();
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  /** Dev/test hook; mirrors the native `app.emit("open-settings", ())`. */
  emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export class MockRuntimeController {
  private state = createInitialRuntimeState();
  private listeners = new Set<RuntimeStateListener>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private sessionCounter = 0;
  private errorCounter = 0;
  private options: MockRuntimeOptions;

  constructor(options: MockRuntimeOptions = {}) {
    this.options = options;
  }

  private get delay(): number {
    return this.options.connectDelayMs ?? 700;
  }

  private get channelEnabled(): { listen: boolean; speak: boolean } {
    return this.options.channelEnabled?.() ?? { listen: true, speak: true };
  }

  getRuntimeState(): RuntimeState {
    return cloneRuntimeState(this.state);
  }

  subscribeRuntimeState(listener: RuntimeStateListener): () => void {
    // React Strict Mode subscribes twice with the same callback reference while
    // it verifies effect cleanup. Keep each registration distinct, otherwise
    // the first cleanup would remove the live subscription.
    const registration: RuntimeStateListener = (state) => listener(state);
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  dispatchNativeAction(action: RuntimeAction): RuntimeState {
    switch (action) {
      case "start_or_stop_session":
        return this.toggleSession();
      case "toggle_speak_mute":
        return this.toggleSpeakMute();
      case "toggle_listen_channel":
        return this.toggleChannel("listen");
      case "toggle_speak_channel":
        return this.toggleChannel("speak");
      case "toggle_subtitle_window":
        return this.commit({ subtitleVisible: !this.state.subtitleVisible });
      case "show_main_window":
        // Window plumbing only; it never changes RuntimeState.
        return this.getRuntimeState();
      case "quit_application":
        this.stopTimers();
        return this.getRuntimeState();
      default:
        return this.getRuntimeState();
    }
  }

  /** Test/dev helper: waits until every simulated transition has run. */
  async settle(): Promise<void> {
    let guard = 0;
    while (this.timers.size) {
      if (++guard > 500) throw new Error("mock runtime scheduler did not settle");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  private isActive(): boolean {
    return (
      this.state.sessionPhase === "starting" ||
      this.state.sessionPhase === "listening" ||
      this.state.sessionPhase === "stopping"
    );
  }

  private schedule(callback: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, this.delay);
    this.timers.add(timer);
  }

  private stopTimers(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  private broadcast(): void {
    const snapshot = this.getRuntimeState();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private commit(patch: Partial<RuntimeState>): RuntimeState {
    const next: RuntimeState = {
      ...this.state,
      ...patch,
      revision: this.state.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    next.trayStatus = deriveMockTrayStatus(next);
    this.state = next;
    this.broadcast();
    return this.getRuntimeState();
  }

  private setRuntimeError(input: {
    service: RuntimeService;
    code: string;
    message: string;
    recoverable: boolean;
  }): void {
    this.commit({
      lastError: {
        id: `mock-error-${++this.errorCounter}`,
        service: input.service,
        code: input.code,
        message: input.message,
        recoverable: input.recoverable,
        sessionId: this.state.sessionId,
      },
      ...(input.service === "audio" ? { audioHealth: "failed" as RuntimeHealth } : {}),
      ...(input.service === "network"
        ? { networkHealth: "failed" as RuntimeHealth }
        : {}),
    });
  }

  private fail(
    service: RuntimeService,
    code: string,
    message: string,
    recoverable = true,
  ): Error {
    this.setRuntimeError({ service, code, message, recoverable });
    return new Error(message);
  }

  private requireActiveSession(): void {
    if (!this.isActive()) {
      throw this.fail(
        "system",
        "no_active_session",
        "请先开始同传，再使用通道控制。",
      );
    }
  }

  private toggleSession(): RuntimeState {
    if (this.isActive()) {
      const sessionId = this.state.sessionId;
      if (this.state.sessionPhase === "stopping" || !sessionId) {
        // Idempotent: the stop is already in flight.
        return this.getRuntimeState();
      }
      const next = this.commit({ sessionPhase: "stopping" });
      this.schedule(() => {
        if (this.state.sessionId !== sessionId) return;
        this.options.onSessionStopped?.(sessionId);
        this.commit({
          sessionPhase: "idle",
          sessionId: null,
          audioHealth: "unknown",
          networkHealth: "unknown",
          listenEnabled: false,
          speakEnabled: false,
          speakMuted: false,
        });
      });
      return next;
    }

    const failure = this.options.guardStart?.() ?? null;
    if (failure) {
      throw this.fail("configuration", "invalid_configuration", failure, false);
    }

    const sessionId = `mock-session-${++this.sessionCounter}`;
    const channels = this.channelEnabled;
    const next = this.commit({
      sessionPhase: "starting",
      sessionId,
      audioHealth: "connecting",
      networkHealth: "connecting",
      listenEnabled: false,
      speakEnabled: false,
      speakMuted: false,
      lastError: null,
    });
    this.options.onSessionStarted?.(sessionId);
    this.schedule(() => {
      if (this.state.sessionId !== sessionId) return;
      this.commit({
        sessionPhase: "listening",
        audioHealth: "ready",
        networkHealth: "ready",
        listenEnabled: channels.listen,
        speakEnabled: channels.speak,
      });
    });
    return next;
  }

  private toggleSpeakMute(): RuntimeState {
    this.requireActiveSession();
    if (!this.state.speakEnabled) {
      throw this.fail(
        "system",
        "channel_not_configured",
        "发言通道未开启，无法静音。",
      );
    }
    return this.commit({ speakMuted: !this.state.speakMuted });
  }

  private toggleChannel(channel: "listen" | "speak"): RuntimeState {
    this.requireActiveSession();
    if (!this.channelEnabled[channel]) {
      throw this.fail(
        "configuration",
        "channel_not_configured",
        channel === "listen"
          ? "收听通道未在设置中启用。"
          : "发言通道未在设置中启用。",
      );
    }
    if (channel === "listen") {
      return this.commit({ listenEnabled: !this.state.listenEnabled });
    }

    // Contract docs/runtime-channel-control.md §1.5: closing the speak channel
    // must also clear a pending mute, otherwise the flag outlives its channel
    // and "Ctrl+Shift+S" re-enables a microphone that stays silent for a reason
    // the user cannot see. Two separate updates mirror the sidecar's event
    // order: `runtime.channel` first, then `runtime.mute{"muted":false}`.
    const enabled = !this.state.speakEnabled;
    const afterChannelChange = this.commit({ speakEnabled: enabled });
    if (!enabled && this.state.speakMuted) {
      return this.commit({ speakMuted: false });
    }
    // §1.5 reverse direction: re-enabling the channel never touches the mute
    // flag, so this stays a single update.
    return afterChannelChange;
  }
}

export function createMockRuntimeController(
  options: MockRuntimeOptions = {},
): MockRuntimeController {
  return new MockRuntimeController(options);
}
