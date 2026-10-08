import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { audioLanguageErrors } from "./translationLanguages";

import {
  MockOpenSettingsChannel,
  MockRuntimeController,
  normalizeRuntimeState,
  type MockRuntimeOptions,
} from "./runtime";
import { engineErrorTitle, errorServiceFromEvent } from "./snapshot";
import {
  mockAudioTestResult,
  normalizeAudioTestResult,
  type AudioTestRequest,
  type AudioTestResult,
} from "./audioDeviceTest";

import {
  DEFAULT_SETTINGS,
  IDLE_HEALTH,
  createEmptyQueue,
  createInitialSnapshot,
  type AppSnapshot,
  type AudioChannelSettings,
  type AudioDevice,
  type AudioDeviceList,
  type CaptionSegment,
  type ChannelId,
  type EngineError,
  type EventEnvelope,
  type PublicSettings,
  type RealtimeServiceSettings,
  type RuntimeAction,
  type RuntimeState,
  type ShortcutSettings,
  type SettingsDraft,
  type SettingsValidation,
  type TranslationProviderDraft,
  type TranslatorEvent,
  type TranslationQueue,
} from "./types";

type EventListener = (event: TranslatorEvent) => void;
type RuntimeStateListener = (state: RuntimeState) => void;

/**
 * Legacy per-session commands. Kept only for compatibility with callers outside
 * this module; every UI action goes through `dispatch_native_action` so the
 * tray menu, the global shortcuts and the main window share one dispatcher
 * (docs/tray-shortcuts-contract.md §1 and §12).
 */
const LEGACY_START_TRANSLATION = "start_translation";
const LEGACY_STOP_TRANSLATION = "stop_translation";

const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const now = () => new Date().toISOString();
const CAPTION_HISTORY_STORAGE_KEY = "simultaneous-translator.caption-history";

function readCaptionHistory(): CaptionSegment[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CAPTION_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CaptionSegment =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as CaptionSegment).id === "string" &&
        typeof (item as CaptionSegment).sessionId === "string" &&
        typeof (item as CaptionSegment).sequence === "number" &&
        typeof (item as CaptionSegment).sourceText === "string" &&
        typeof (item as CaptionSegment).status === "string" &&
        typeof (item as CaptionSegment).createdAt === "string",
    );
  } catch {
    return [];
  }
}

function writeCaptionHistory(captions: CaptionSegment[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CAPTION_HISTORY_STORAGE_KEY,
      JSON.stringify(captions),
    );
  } catch {
    // Storage can be unavailable in private or restricted WebView contexts.
  }
}

const mockSentences = [
  {
    source:
      "Welcome, everyone. We will begin with the product roadmap for the next quarter.",
    translation: "各位好。我们将先介绍下个季度的产品路线图。",
  },
  {
    source:
      "The team has finished the reliability work and is preparing the staged rollout.",
    translation: "团队已经完成可靠性工作，正在准备分阶段发布。",
  },
  {
    source:
      "Please hold questions until the end so we can keep the discussion moving.",
    translation: "请把问题留到最后，这样我们可以保持讨论进度。",
  },
  {
    source:
      "The first build is expected on Friday, subject to the final verification results.",
    translation: "首个构建版本预计将在周五推出，具体取决于最终验证结果。",
  },
  {
    source:
      "We will share the rollback plan with the support team before the release window.",
    translation: "我们会在发布窗口之前与支持团队共享回滚计划。",
  },
];

class MockTranslator {
  private snapshot = createInitialSnapshot();
  private listeners = new Set<EventListener>();
  private timers = new Set<number>();
  private sentenceIndex = 0;
  private sequence = 0;
  /**
   * Browser-only runtime state machine. It exposes the same three entry points
   * as the native layer so the UI has exactly one code path; it is never used
   * when `isTauriRuntime()` is true.
   */
  private runtime: MockRuntimeController;

  constructor() {
    const options: MockRuntimeOptions = {
      channelEnabled: () => ({
        listen: this.snapshot.settings.audio.listen.enabled,
        speak: this.snapshot.settings.audio.speak.enabled,
      }),
      guardStart: () => {
        const errors = audioLanguageErrors(this.snapshot.settings.audio);
        const keys = Object.keys(errors);
        return keys.length ? Object.values(errors).join("\n") : null;
      },
      onSessionStarted: (sessionId) => {
        void this.start(sessionId);
      },
      onSessionStopped: (sessionId) => {
        void this.stop(sessionId ?? this.snapshot.session.sessionId);
      },
    };
    this.runtime = new MockRuntimeController(options);
  }

  getRuntimeState(): RuntimeState {
    return this.runtime.getRuntimeState();
  }

  dispatchNativeAction(action: RuntimeAction): RuntimeState {
    return this.runtime.dispatchNativeAction(action);
  }

  subscribeRuntimeState(listener: RuntimeStateListener): UnlistenFn {
    return this.runtime.subscribeRuntimeState(listener);
  }

  getSnapshot(): AppSnapshot {
    return deepCopy(this.snapshot);
  }

  subscribe(listener: EventListener): UnlistenFn {
    // React Strict Mode may briefly subscribe twice with the same callback
    // reference while it verifies effect cleanup. Keep each registration
    // distinct so the first cleanup cannot remove the live subscription.
    const registration: EventListener = (event) => listener(event);
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  /** `sessionId` is supplied by the mock runtime controller so both mock
   * state machines agree on the same identifier. */
  async start(sessionId?: string): Promise<{ sessionId: string }> {
    const languageErrors = audioLanguageErrors(this.snapshot.settings.audio);
    if (Object.keys(languageErrors).length) throw new Error(Object.values(languageErrors).join("\n"));
    this.clearTimers();
    const activeSessionId = sessionId ?? `mock-${Date.now()}`;
    this.snapshot.session = {
      ...this.snapshot.session,
      phase: "starting",
      sessionId: activeSessionId,
      startedAt: now(),
      partialTranscript: "",
      health: {
        audio: "connecting",
        recognition: "connecting",
        translation: "connecting",
      },
      queue: createEmptyQueue(),
      lastError: null,
    };
    this.bump();
    this.emit("session", this.snapshot.session, activeSessionId);

    this.schedule(() => {
      if (this.snapshot.session.sessionId !== activeSessionId) return;
      this.snapshot.session = {
        ...this.snapshot.session,
        phase: "listening",
        deviceName: "默认扬声器 (Mock Audio)",
        health: { audio: "ready", recognition: "ready", translation: "ready" },
        channels: {
          listen: this.snapshot.settings.audio.listen.enabled
            ? "ready"
            : "unknown",
          speak: this.snapshot.settings.audio.speak.enabled
            ? "ready"
            : "unknown",
        },
      };
      this.bump();
      this.emit("session", this.snapshot.session, activeSessionId);
      this.runSentence(activeSessionId);
    }, 700);

    return { sessionId: activeSessionId };
  }

  async stop(sessionId: string | null): Promise<void> {
    if (!sessionId || this.snapshot.session.sessionId !== sessionId) return;
    this.snapshot.session = {
      ...this.snapshot.session,
      phase: "stopping",
      partialTranscript: "",
    };
    this.bump();
    this.emit("session", this.snapshot.session, sessionId);
    this.clearTimers();

    this.schedule(() => {
      if (this.snapshot.session.sessionId !== sessionId) return;
      this.snapshot.session = {
        ...this.snapshot.session,
        phase: "idle",
        sessionId: null,
        startedAt: null,
        partialTranscript: "",
        health: { ...IDLE_HEALTH },
        queue: createEmptyQueue(),
      };
      this.bump();
      // Keep the old id on the terminal event so a newer session can reject it.
      this.emit("session", this.snapshot.session, sessionId);
    }, 450);
  }

  async clearHistory(): Promise<void> {
    this.snapshot.captions = [];
    this.bump();
    this.emit(
      "session",
      { partialTranscript: this.snapshot.session.partialTranscript },
      this.snapshot.session.sessionId,
    );
  }

  async saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
    const recognitionStatus = draft.recognition.clearApiKey
      ? "missing"
      : draft.recognition.apiKey?.trim()
        ? "secure_store"
        : draft.recognition.protocol ===
              this.snapshot.settings.recognition.protocol &&
            draft.recognition.baseUrl.trim() ===
              this.snapshot.settings.recognition.baseUrl
          ? this.snapshot.settings.recognition.apiKeyStatus
          : "missing";
    const realtimeStatus = draft.realtime.clearApiKey
      ? "missing"
      : draft.realtime.apiKey?.trim()
        ? "secure_store"
        : draft.realtime.protocol ===
              this.snapshot.settings.realtime.protocol &&
            draft.realtime.baseUrl.trim() ===
              this.snapshot.settings.realtime.baseUrl
          ? this.snapshot.settings.realtime.apiKeyStatus
          : "missing";
    const translationProviders = draft.translationProviders.map((provider) => {
      const current = this.snapshot.settings.translationProviders.find(
        (item) => item.id === provider.id,
      );
      const apiKeyStatus = provider.clearApiKey
        ? "missing"
        : provider.apiKey?.trim()
          ? "secure_store"
          : current?.protocol === provider.protocol &&
              current.baseUrl === provider.baseUrl.trim()
            ? current.apiKeyStatus
            : "missing";
      const {
        apiKey: _apiKey,
        clearApiKey: _clearApiKey,
        ...publicProvider
      } = provider;
      return { ...publicProvider, apiKeyStatus };
    });
    this.snapshot.settings = {
      sourceLanguage: draft.sourceLanguage,
      targetLanguage: draft.targetLanguage,
      engine: draft.engine,
      recognition: {
        protocol: draft.recognition.protocol,
        baseUrl: draft.recognition.baseUrl,
        model: draft.recognition.model,
        apiKeyStatus: recognitionStatus,
      },
      realtime: {
        protocol: draft.realtime.protocol,
        baseUrl: draft.realtime.baseUrl,
        model: draft.realtime.model,
        voice: draft.realtime.voice,
        enableVoiceClone: draft.realtime.enableVoiceClone,
        voiceCloneFrequency: draft.realtime.voiceCloneFrequency,
        apiKeyStatus: realtimeStatus,
      },
      audio: {
        listen: { ...draft.audio.listen },
        speak: { ...draft.audio.speak },
      },
      translationProviders,
      activeTranslationProviderId: draft.activeTranslationProviderId,
      alwaysOnTop: draft.alwaysOnTop,
      subtitleSize: draft.subtitleSize,
      shortcuts: { ...draft.shortcuts },
    };
    this.bump();
    this.emit(
      "settings",
      this.snapshot.settings,
      this.snapshot.session.sessionId,
    );
    return deepCopy(this.snapshot.settings);
  }

  private runSentence(sessionId: string): void {
    if (
      this.snapshot.session.sessionId !== sessionId ||
      this.snapshot.session.phase !== "listening"
    )
      return;
    const sentence = mockSentences[this.sentenceIndex % mockSentences.length];
    this.sentenceIndex += 1;
    const words = sentence.source.split(" ");
    let wordIndex = 0;

    const partialTimer = window.setInterval(() => {
      if (
        this.snapshot.session.sessionId !== sessionId ||
        this.snapshot.session.phase !== "listening"
      ) {
        window.clearInterval(partialTimer);
        return;
      }
      wordIndex += 2;
      this.snapshot.session.partialTranscript = words
        .slice(0, wordIndex)
        .join(" ");
      this.bump();
      this.emit(
        "session",
        { partialTranscript: this.snapshot.session.partialTranscript },
        sessionId,
      );
      if (wordIndex >= words.length) {
        window.clearInterval(partialTimer);
        this.finishSentence(sessionId, sentence.source, sentence.translation);
      }
    }, 125);
    this.timers.add(partialTimer);
  }

  private finishSentence(
    sessionId: string,
    sourceText: string,
    translationText: string,
  ): void {
    if (this.snapshot.session.sessionId !== sessionId) return;
    const segment: CaptionSegment = {
      id: `mock-caption-${++this.sequence}`,
      sessionId,
      sequence: this.sequence,
      sourceText,
      status: "translating",
      createdAt: now(),
    };
    this.snapshot.session.partialTranscript = "";
    this.snapshot.captions.push(segment);
    this.snapshot.session.queue = {
      ...this.snapshot.session.queue,
      pending: 1,
      lagMs: 620,
    };
    this.bump();
    this.emit("caption", segment, sessionId);
    this.emit("queue", this.snapshot.session.queue, sessionId);

    this.schedule(() => {
      if (this.snapshot.session.sessionId !== sessionId) return;
      const item = this.snapshot.captions.find(
        (caption) => caption.id === segment.id,
      );
      if (!item) return;
      item.translationText = translationText;
      item.status = "translated";
      item.completedAt = now();
      this.snapshot.session.queue = {
        ...this.snapshot.session.queue,
        pending: 0,
        lagMs: 0,
      };
      this.bump();
      this.emit("caption", item, sessionId);
      this.emit("queue", this.snapshot.session.queue, sessionId);
      this.schedule(() => this.runSentence(sessionId), 1150);
    }, 700);
  }

  private schedule(callback: () => void, delay: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    });
    this.timers.clear();
  }

  private bump(): void {
    this.snapshot.revision += 1;
  }

  private emit(
    type: TranslatorEvent["type"],
    payload: unknown,
    sessionId: string | null,
  ): void {
    const data: EventEnvelope<unknown> = {
      revision: this.snapshot.revision,
      sessionId,
      emittedAt: now(),
      payload,
    };
    const event = { type, data } as TranslatorEvent;
    this.listeners.forEach((listener) => listener(event));
  }
}

const mockTranslator = new MockTranslator();

/** Browser stand-in for the native tray `open-settings` broadcast. */
const mockOpenSettings = new MockOpenSettingsChannel();

function validateDraft(draft: SettingsDraft): SettingsValidation {
  const fieldErrors: SettingsValidation["fieldErrors"] = audioLanguageErrors(draft.audio);
  const validateUrl = (
    value: string,
    protocol: "wss:" | "https:",
    field: string,
  ) => {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== protocol) {
        fieldErrors[field] = `地址必须使用 ${protocol}// 加密连接。`;
      } else if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        fieldErrors[field] = "地址不能包含凭据、查询参数或片段。";
      }
    } catch {
      fieldErrors[field] = "请输入有效的服务地址。";
    }
  };

  validateUrl(draft.realtime.baseUrl, "wss:", "realtime.baseUrl");
  if (draft.realtime.model !== DEFAULT_SETTINGS.realtime.model)
    fieldErrors["realtime.model"] = "当前仅支持 Qwen3.8 实时同传模型。";
  if (!draft.audio.listen.enabled && !draft.audio.speak.enabled)
    fieldErrors.audio = "请至少启用一个音频通道。";
  if (!draft.targetLanguage.trim())
    fieldErrors.targetLanguage = "请选择目标语言。";

  const shortcutGroups = new Map<string, string[]>();
  const shortcutFields: Array<[keyof ShortcutSettings, string]> = [
    ["startOrStopSession", "shortcuts.startOrStopSession"],
    ["toggleSpeakMute", "shortcuts.toggleSpeakMute"],
    ["toggleSubtitleWindow", "shortcuts.toggleSubtitleWindow"],
    ["toggleListenChannel", "shortcuts.toggleListenChannel"],
    ["toggleSpeakChannel", "shortcuts.toggleSpeakChannel"],
  ];
  for (const [id, field] of shortcutFields) {
    const identity = shortcutIdentity(draft.shortcuts[id]);
    if (!identity) {
      fieldErrors[field] = "请使用 Ctrl、Alt 或 Win 与一个按键组成快捷键。";
      continue;
    }
    const fields = shortcutGroups.get(identity) ?? [];
    fields.push(field);
    shortcutGroups.set(identity, fields);
  }
  for (const fields of shortcutGroups.values()) {
    if (fields.length > 1) {
      fields.forEach((field) => {
        fieldErrors[field] = "此快捷键已分配给其他操作。";
      });
    }
  }

  return { valid: Object.keys(fieldErrors).length === 0, fieldErrors };
}

function shortcutIdentity(value: string): string | null {
  const tokens = value.split("+").map((token) => token.trim());
  if (tokens.length < 2 || tokens.some((token) => !token)) return null;

  const modifierAliases: Record<string, string> = {
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    super: "Super",
    win: "Super",
    windows: "Super",
    meta: "Super",
    command: "Super",
    cmd: "Super",
  };
  const modifiers = tokens.slice(0, -1).map((token) =>
    modifierAliases[token.toLowerCase()],
  );
  if (
    modifiers.some((modifier) => !modifier) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((modifier) => modifier === "Ctrl" || modifier === "Alt" || modifier === "Super")
  ) {
    return null;
  }

  let key = tokens.at(-1)!.toUpperCase();
  if (/^KEY[A-Z]$/.test(key)) key = key.slice(3);
  if (/^DIGIT[0-9]$/.test(key)) key = key.slice(5);
  const supportedKey =
    /^[A-Z0-9]$/.test(key) ||
    /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) ||
    /^(BACKQUOTE|BACKSLASH|BRACKETLEFT|BRACKETRIGHT|COMMA|EQUAL|MINUS|PERIOD|QUOTE|SEMICOLON|SLASH)$/.test(key) ||
    /^(SPACE|ENTER|TAB|ESCAPE|BACKSPACE|DELETE|END|HOME|INSERT|PAGEDOWN|PAGEUP|PRINTSCREEN|SCROLLLOCK|ARROWDOWN|ARROWLEFT|ARROWRIGHT|ARROWUP|NUMPAD(?:[0-9]|ADD|DECIMAL|DIVIDE|ENTER|EQUAL|MULTIPLY|SUBTRACT))$/.test(key);
  if (!supportedKey) return null;

  return `${[...modifiers].sort().join("+")}|${key}`;
}

function emitTauri<T>(
  type: TranslatorEvent["type"],
  data: EventEnvelope<T>,
  listener: EventListener,
): void {
  listener({ type, data } as TranslatorEvent);
}

interface BackendSettingsSnapshot {
  sourceLanguage: string;
  targetLanguage: string;
  engine: string;
  recognition: {
    protocol: "dashscope";
    baseUrl: string;
    model: string;
    apiKeyStatus: string;
  };
  realtime: {
    protocol: "livetranslate";
    baseUrl: string;
    model: string;
    voice: string;
    enableVoiceClone: boolean;
    voiceCloneFrequency: string;
    apiKeyStatus: string;
  };
  audio: {
    listen: unknown;
    speak: unknown;
  };
  translationProviders: Array<{
    id: string;
    name: string;
    protocol: "gemini" | "openai";
    baseUrl: string;
    models: string[];
    selectedModel: string;
    apiKeyStatus: string;
  }>;
  activeTranslationProviderId: string;
  keepOnTop: boolean;
  captionScale: "small" | "medium" | "large";
  shortcuts: ShortcutSettings;
}

export interface ProviderModelsResult {
  models: string[];
  supported: boolean;
}

export interface ProviderConnectionResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

interface StartTranslationResult {
  sessionId: string;
}

interface ActiveSessionSnapshot {
  sessionId: string | null;
}

interface BridgeEvent {
  type?: unknown;
  event?: unknown;
  sequence?: unknown;
  session_id?: unknown;
  data?: unknown;
}

let bridgeRevision = 0;
const bridgeQueues = new Map<string, TranslationQueue>();

/**
 * Highest runtime revision already applied. Native commands return the
 * authoritative snapshot, so a `runtime-state` broadcast that arrives late is
 * dropped instead of rolling the UI back (contract §5 and §6).
 */
let runtimeRevision = -1;

function rememberRuntimeState(state: RuntimeState): RuntimeState {
  runtimeRevision = Math.max(runtimeRevision, state.revision);
  return state;
}

function acceptRuntimeRevision(revision: number): boolean {
  if (revision <= runtimeRevision) return false;
  runtimeRevision = revision;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toSecretStatus(
  value: string,
): PublicSettings["recognition"]["apiKeyStatus"] {
  if (
    value === "environment" ||
    value === "secure_store" ||
    value === "unavailable"
  )
    return value;
  return "missing";
}

function toEngineMode(_value: unknown): PublicSettings["engine"] {
  return "realtime";
}

function toChannelId(value: unknown): ChannelId {
  return value === "speak" ? "speak" : "listen";
}

function toAudioChannel(
  raw: unknown,
  fallback: AudioChannelSettings,
): AudioChannelSettings {
  const channel = asRecord(raw);
  const input = channel.input === "microphone" || channel.input === "loopback" || channel.input === "system" ? channel.input : fallback.input;
  return {
    voiceMode: channel.voiceMode === "system" || channel.voiceMode === "clone" ? channel.voiceMode : fallback.voiceMode,
    enabled:
      typeof channel.enabled === "boolean" ? channel.enabled : fallback.enabled,
    input,
    inputDevice: asString(channel.inputDevice, ""),
    targetLanguage: asString(channel.targetLanguage, "").trim() || fallback.targetLanguage,
    outputDevice: asString(channel.outputDevice, ""),
    playAudio:
      typeof channel.playAudio === "boolean" ? channel.playAudio : true,
  };
}

function toPublicSettings(raw: BackendSettingsSnapshot): PublicSettings {
  const subtitleSize =
    raw.captionScale === "small" || raw.captionScale === "large"
      ? raw.captionScale
      : "medium";
  const realtime = asRecord(raw.realtime);
  const audio = asRecord(raw.audio);
  return {
    sourceLanguage: raw.sourceLanguage,
    targetLanguage: raw.targetLanguage,
    engine: toEngineMode(raw.engine),
    recognition: {
      protocol: "dashscope",
      baseUrl: raw.recognition.baseUrl,
      model: raw.recognition.model,
      apiKeyStatus: toSecretStatus(raw.recognition.apiKeyStatus),
    },
    realtime: {
      protocol: "livetranslate",
      baseUrl: asString(realtime.baseUrl, DEFAULT_SETTINGS.realtime.baseUrl),
      model: asString(realtime.model, DEFAULT_SETTINGS.realtime.model),
      voice: asString(realtime.voice, DEFAULT_SETTINGS.realtime.voice),
      enableVoiceClone: realtime.enableVoiceClone !== false,
      voiceCloneFrequency: toVoiceCloneFrequency(realtime.voiceCloneFrequency),
      apiKeyStatus: toSecretStatus(asString(realtime.apiKeyStatus)),
    },
    audio: {
      listen: toAudioChannel(audio.listen, DEFAULT_SETTINGS.audio.listen),
      speak: toAudioChannel(audio.speak, DEFAULT_SETTINGS.audio.speak),
    },
    translationProviders: raw.translationProviders.map((provider) => ({
      ...provider,
      models: [...provider.models],
      apiKeyStatus: toSecretStatus(provider.apiKeyStatus),
    })),
    activeTranslationProviderId: raw.activeTranslationProviderId,
    alwaysOnTop: raw.keepOnTop,
    subtitleSize,
    shortcuts: { ...raw.shortcuts },
  };
}

function toVoiceCloneFrequency(
  value: unknown,
): RealtimeServiceSettings["voiceCloneFrequency"] {
  return value === "never" || value === "always" ? value : "once";
}

function toBackendAudioChannel(channel: AudioChannelSettings) {
  return {
    voiceMode: channel.voiceMode,
    enabled: channel.enabled,
    input: channel.input,
    inputDevice: channel.inputDevice.trim(),
    targetLanguage: channel.targetLanguage.trim(),
    outputDevice: channel.outputDevice.trim(),
    playAudio: channel.playAudio,
  };
}

function toBackendSettings(draft: SettingsDraft) {
  const recognitionApiKey = draft.recognition.apiKey?.trim();
  const realtimeApiKey = draft.realtime.apiKey?.trim();
  return {
    sourceLanguage: draft.sourceLanguage.trim(),
    targetLanguage: draft.targetLanguage.trim(),
    engine: draft.engine,
    recognition: {
      protocol: draft.recognition.protocol,
      baseUrl: draft.recognition.baseUrl.trim(),
      model: draft.recognition.model.trim(),
      ...(recognitionApiKey ? { apiKey: recognitionApiKey } : {}),
      ...(draft.recognition.clearApiKey ? { clearApiKey: true } : {}),
    },
    realtime: {
      protocol: draft.realtime.protocol,
      baseUrl: draft.realtime.baseUrl.trim(),
      model: draft.realtime.model.trim(),
      voice: draft.realtime.voice.trim(),
      enableVoiceClone: draft.realtime.enableVoiceClone,
      voiceCloneFrequency: draft.realtime.voiceCloneFrequency,
      ...(realtimeApiKey ? { apiKey: realtimeApiKey } : {}),
      ...(draft.realtime.clearApiKey ? { clearApiKey: true } : {}),
    },
    audio: {
      listen: toBackendAudioChannel(draft.audio.listen),
      speak: toBackendAudioChannel(draft.audio.speak),
    },
    translationProviders: draft.translationProviders.map((provider) => {
      const apiKey = provider.apiKey?.trim();
      return {
        id: provider.id,
        name: provider.name.trim(),
        protocol: provider.protocol,
        baseUrl: provider.baseUrl.trim(),
        models: provider.models.map((model) => model.trim()).filter(Boolean),
        selectedModel: provider.selectedModel.trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(provider.clearApiKey ? { clearApiKey: true } : {}),
      };
    }),
    activeTranslationProviderId: draft.activeTranslationProviderId,
    keepOnTop: draft.alwaysOnTop,
    captionScale: draft.subtitleSize,
    shortcuts: { ...draft.shortcuts },
  };
}

function toProviderProbeInput(provider: TranslationProviderDraft) {
  const apiKey = provider.apiKey?.trim();
  return {
    providerId: provider.id,
    provider: {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl.trim(),
      model: provider.selectedModel.trim(),
    },
    ...(apiKey ? { apiKey } : {}),
  };
}

function nextBridgeRevision(sequence: unknown): number {
  const parsed = asNumber(sequence, 0);
  // A new Python sidecar is launched for every desktop session, so its JSONL
  // sequence starts at 1 again. The React snapshot needs one process-wide
  // monotonic revision to avoid treating a valid new-session event as stale.
  bridgeRevision = Math.max(bridgeRevision + 1, parsed);
  return bridgeRevision;
}

function eventEnvelope<T>(
  revision: number,
  sessionId: string | null,
  payload: T,
): EventEnvelope<T> {
  return {
    revision,
    sessionId,
    emittedAt: now(),
    payload,
  };
}

function queueFor(sessionId: string): TranslationQueue {
  return bridgeQueues.get(sessionId) ?? createEmptyQueue();
}

/**
 * Whether the current engine has everything it needs to start.
 *
 * The realtime engine recognises and translates with one DashScope key, so the
 * text provider is never consulted there.
 */
export function isConfigurationComplete(settings: PublicSettings): boolean {
  const usable = (status: PublicSettings["recognition"]["apiKeyStatus"]) =>
    status === "environment" || status === "secure_store";
  const channels =
    Number(settings.audio.listen.enabled) +
    Number(settings.audio.speak.enabled);
  return usable(settings.realtime.apiKeyStatus) && channels > 0;
}

async function copyInBrowser(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("浏览器不允许访问剪贴板。");
}

// Settings can mount twice in StrictMode or reopen while enumeration is pending.
let audioDevicesRequest: Promise<unknown> | null = null;

export const translatorApi = {
  isTauri: isTauriRuntime(),

  async getSnapshot(): Promise<AppSnapshot> {
    if (!isTauriRuntime()) return mockTranslator.getSnapshot();
    const [raw, activeSession] = await Promise.all([
      invoke<BackendSettingsSnapshot>("get_settings"),
      invoke<ActiveSessionSnapshot>("get_active_session"),
    ]);
    const settings = toPublicSettings(raw);
    bridgeRevision += 1;
    const snapshot = createInitialSnapshot();
    snapshot.revision = bridgeRevision;
    snapshot.settings = settings;
    snapshot.captions = readCaptionHistory();
    snapshot.session.phase = isConfigurationComplete(settings)
      ? "idle"
      : "needs_configuration";
    if (activeSession.sessionId) {
      // The sidecar continues independently of a WebView reload. Reattach to
      // its known session ID so subsequent events are not discarded as stale.
      snapshot.session = {
        ...snapshot.session,
        phase: "listening",
        sessionId: activeSession.sessionId,
        startedAt: now(),
        health: {
          audio: "connecting",
          recognition: "connecting",
          translation: "connecting",
        },
        queue: createEmptyQueue(),
        lastError: null,
      };
    }
    return snapshot;
  },

  async startSession(): Promise<{ sessionId: string }> {
    if (!isTauriRuntime()) return mockTranslator.start();
    // Only one session can be live at a time, so any queue state still tracked
    // here belongs to a sidecar that has already been replaced.
    bridgeQueues.clear();
    return invoke<StartTranslationResult>(LEGACY_START_TRANSLATION);
  },

  async stopSession(sessionId: string | null): Promise<void> {
    if (!isTauriRuntime()) return mockTranslator.stop(sessionId);
    if (!sessionId) return;
    try {
      await invoke(LEGACY_STOP_TRANSLATION, { sessionId });
    } finally {
      // Stopping kills the sidecar, so no terminal "stopped" event arrives to
      // release this entry.
      bridgeQueues.delete(sessionId);
    }
  },

  async clearHistory(): Promise<void> {
    if (!isTauriRuntime()) return mockTranslator.clearHistory();
    try {
      window.localStorage.removeItem(CAPTION_HISTORY_STORAGE_KEY);
    } catch {
      // The UI still clears its in-memory copy when storage is unavailable.
    }
  },

  persistCaptionHistory(captions: CaptionSegment[]): void {
    writeCaptionHistory(captions);
  },

  async validateSettings(draft: SettingsDraft): Promise<SettingsValidation> {
    const localValidation = validateDraft(draft);
    return localValidation;
  },

  async saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
    const validation = validateDraft(draft);
    if (!validation.valid) throw new Error(Object.values(validation.fieldErrors).join("\n"));
    if (!isTauriRuntime()) return mockTranslator.saveSettings(draft);
    const raw = await invoke<BackendSettingsSnapshot>("save_settings", {
      input: toBackendSettings(draft),
    });
    return toPublicSettings(raw);
  },

  async fetchProviderModels(
    provider: TranslationProviderDraft,
  ): Promise<ProviderModelsResult> {
    if (!isTauriRuntime()) {
      return {
        models: provider.models.length
          ? [...provider.models]
          : [provider.selectedModel].filter(Boolean),
        supported: true,
      };
    }
    return invoke<ProviderModelsResult>("fetch_provider_models", {
      input: toProviderProbeInput(provider),
    });
  },

  async testProviderConnection(
    provider: TranslationProviderDraft,
  ): Promise<ProviderConnectionResult> {
    if (!isTauriRuntime()) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return { ok: true, latencyMs: 350, detail: "浏览器演示连接正常" };
    }
    return invoke<ProviderConnectionResult>("test_provider_connection", {
      input: toProviderProbeInput(provider),
    });
  },

  async installVirtualMicrophone(): Promise<void> {
    if (!isTauriRuntime()) throw new Error("请在 Windows 桌面版中安装虚拟麦克风。");
    await invoke("install_virtual_microphone");
  },

  async openVirtualMicrophoneLink(kind: "product" | "license" | "donate"): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_virtual_microphone_link", { kind });
    } else {
      const urls = { product: "https://vb-audio.com/Cable/", license: "https://vb-audio.com/Services/licensing.htm", donate: "https://shop.vb-audio.com/en/" };
      window.open(urls[kind], "_blank", "noopener,noreferrer");
    }
  },

  async listAudioDevices(): Promise<AudioDeviceList> {
    if (!isTauriRuntime()) {
      return {
        speakers: [
          {
            id: "demo-speaker",
            name: "演示播放设备",
            channels: 2,
            isDefault: true,
            loopback: true,
          },
        ],
        microphones: [
          {
            id: "demo-microphone",
            name: "演示麦克风",
            channels: 1,
            isDefault: true,
            loopback: false,
          },
        ],
      };
    }
    if (!audioDevicesRequest) {
      audioDevicesRequest = invoke<unknown>("list_audio_devices").finally(
        () => {
          audioDevicesRequest = null;
        },
      );
    }
    const raw = asRecord(await audioDevicesRequest);
    const toDevices = (value: unknown): AudioDevice[] =>
      Array.isArray(value)
        ? value.map((item) => {
            const device = asRecord(item);
            return {
              id: asString(device.id),
              name: asString(device.name, asString(device.id)),
              channels: asNumber(device.channels, 1),
              isDefault: device.isDefault === true,
              loopback: device.loopback === true,
            };
          })
        : [];
    return {
      speakers: toDevices(raw.speakers),
      microphones: toDevices(raw.microphones),
    };
  },

  async runAudioTest(request: AudioTestRequest): Promise<AudioTestResult> {
    if (!isTauriRuntime()) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return mockAudioTestResult(request);
    }
    const raw = await invoke<unknown>("run_audio_test", {
      input: {
        kind: request.kind,
        deviceId: request.deviceId,
      },
    });
    return normalizeAudioTestResult(raw, request.kind);
  },

  async copyText(text: string): Promise<void> {
    await copyInBrowser(text);
  },

  /**
   * Current runtime state (tray status, runtime channels, mute, shortcut
   * failures). Frozen contract: docs/tray-shortcuts-contract.md §5.
   */
  async getRuntimeState(): Promise<RuntimeState> {
    if (!isTauriRuntime()) return mockTranslator.getRuntimeState();
    const raw = await invoke<unknown>("get_runtime_state");
    return rememberRuntimeState(normalizeRuntimeState(raw));
  },

  /**
   * The single action entry point, shared with the tray menu and the global
   * shortcuts. The returned state is the authoritative snapshot after the
   * action; the caller does not need to wait for a `runtime-state` event.
   */
  async dispatchNativeAction(action: RuntimeAction): Promise<RuntimeState> {
    if (!isTauriRuntime()) return mockTranslator.dispatchNativeAction(action);
    const raw = await invoke<unknown>("dispatch_native_action", { action });
    return rememberRuntimeState(normalizeRuntimeState(raw));
  },

  /** Broadcast to every window, including the subtitle overlay (contract §6). */
  async subscribeRuntimeState(
    listener: RuntimeStateListener,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return mockTranslator.subscribeRuntimeState(listener);
    return listen<unknown>("runtime-state", (event) => {
      const state = normalizeRuntimeState(event.payload);
      if (!acceptRuntimeRevision(state.revision)) return;
      listener(state);
    });
  },

  /**
   * Tray menu item `设置` (tray-shortcuts-contract §9): the native layer shows
   * the main window and then emits `open-settings`, which must open the
   * settings dialog. The event name is the frozen literal.
   */
  async subscribeOpenSettings(handler: () => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return mockOpenSettings.subscribe(handler);
    return listen("open-settings", () => handler());
  },

  async subscribe(listener: EventListener): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return mockTranslator.subscribe(listener);

    return listen<BridgeEvent>("translator-event", (event) => {
      const bridge = event.payload;
      if (bridge.type !== "event" || typeof bridge.event !== "string") return;
      const sessionId =
        typeof bridge.session_id === "string" ? bridge.session_id : null;
      const revision = nextBridgeRevision(bridge.sequence);
      const data = asRecord(bridge.data);
      const emit = <T>(type: TranslatorEvent["type"], payload: T) =>
        emitTauri(type, eventEnvelope(revision, sessionId, payload), listener);

      if (bridge.event === "state") {
        const state = asString(data.state);
        if (state === "starting" && sessionId) {
          bridgeQueues.set(sessionId, createEmptyQueue());
          emit("session", {
            phase: "starting",
            sessionId,
            startedAt: now(),
            partialTranscript: "",
            partialChannel: null,
            partialTranslation: "",
            deviceNames: {},
            channels: { listen: "connecting", speak: "connecting" },
            health: {
              audio: "connecting",
              recognition: "connecting",
              translation: "connecting",
            },
            queue: queueFor(sessionId),
            lastError: null,
          });
        }
        // "listening" only means the sidecar opened its local ASR task. The
        // DashScope SDK reports that before the WebSocket handshake completes,
        // and nothing has reached the translation service yet, so both stay
        // "connecting" until real traffic proves otherwise.
        if (state === "listening") emit("session", { phase: "listening" });
        if (state === "stopping") {
          emit("session", {
            phase: "stopping",
            partialTranscript: "",
            partialTranslation: "",
          });
        }
        if (state === "stopped") {
          emit("session", {
            phase: "idle",
            sessionId: null,
            startedAt: null,
            partialTranscript: "",
            partialChannel: null,
            partialTranslation: "",
            deviceNames: {},
            channels: { listen: "unknown", speak: "unknown" },
            health: { ...IDLE_HEALTH },
            queue: createEmptyQueue(),
          });
          if (sessionId) bridgeQueues.delete(sessionId);
        }
        return;
      }

      if (!sessionId) return;

      if (bridge.event === "audio.device") {
        const channel = toChannelId(data.channel);
        const name = asString(data.name, "默认播放设备");
        emit("session", {
          deviceNames: { [channel]: name },
          // The tile shows the incoming direction when it is live, because that
          // is the audio the operator is actually listening to.
          ...(channel === "listen" ? { deviceName: name } : {}),
        });
        return;
      }

      if (bridge.event === "channel.status") {
        const channel = toChannelId(data.channel);
        const status = asString(data.status);
        if (status === "failed") {
          emit("session", {
            channels: { [channel]: "failed" },
            health: { audio: "failed" },
          });
        } else if (status === "ready" || status === "streaming") {
          emit("session", {
            channels: { [channel]: "ready" },
            health: { audio: "ready", translation: "ready" },
          });
        } else {
          emit("session", { channels: { [channel]: "connecting" } });
        }
        return;
      }

      if (bridge.event === "audio.ready") {
        emit("session", { health: { audio: "ready" } });
        return;
      }

      if (bridge.event === "asr.status") {
        const status = asString(data.status);
        if (status === "closed" || status === "complete") {
          emit("session", { health: { recognition: "degraded" } });
        }
        return;
      }

      if (bridge.event === "source.partial") {
        // A live line owned by whichever direction spoke last; the caption chip
        // tells the operator which channel it belongs to.
        emit("session", {
          partialTranscript: asString(data.text),
          partialChannel: toChannelId(data.channel),
          health: { recognition: "ready" },
        });
        return;
      }

      if (bridge.event === "translation.partial") {
        emit("session", { partialTranslation: asString(data.text) });
        return;
      }

      if (bridge.event === "source.final") {
        const sourceSequence = asNumber(data.source_seq);
        const queue = queueFor(sessionId);
        const nextQueue = {
          ...queue,
          pending: Math.min(queue.limit, queue.pending + 1),
          lagMs: Math.max(queue.lagMs, 400),
        };
        bridgeQueues.set(sessionId, nextQueue);
        // The final transcript now lives in its own caption, so the live line is
        // released for the next turn.
        emit("session", {
          health: { recognition: "ready" },
          partialTranscript: "",
          partialChannel: null,
          partialTranslation: "",
        });
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.text),
          status: "translating",
          createdAt: now(),
          channel: toChannelId(data.channel),
        });
        emit("queue", nextQueue);
        return;
      }

      if (bridge.event === "translation") {
        const sourceSequence = asNumber(data.source_seq);
        const queue = queueFor(sessionId);
        const nextQueue = {
          ...queue,
          pending: Math.max(0, queue.pending - 1),
          lagMs: 0,
        };
        bridgeQueues.set(sessionId, nextQueue);
        emit("session", {
          health: { translation: "ready" },
          partialTranslation: "",
        });
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.source_text),
          translationText: asString(data.text, "（无翻译结果）"),
          status: "translated",
          createdAt: now(),
          completedAt: now(),
          channel: toChannelId(data.channel),
        });
        emit("queue", nextQueue);
        return;
      }

      if (bridge.event === "translation.dropped") {
        const sourceSequence = asNumber(data.source_seq);
        const queue = queueFor(sessionId);
        const nextQueue = {
          ...queue,
          pending: Math.max(0, queue.pending - 1),
          skipped: queue.skipped + 1,
        };
        bridgeQueues.set(sessionId, nextQueue);
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.source_text),
          status: "dropped",
          createdAt: now(),
          errorMessage: "翻译队列已满",
        });
        emit("queue", nextQueue);
        return;
      }

      if (bridge.event === "translation.failed") {
        const sourceSequence = asNumber(data.source_seq);
        const queue = queueFor(sessionId);
        const nextQueue = {
          ...queue,
          pending: Math.max(0, queue.pending - 1),
          lagMs: 0,
        };
        bridgeQueues.set(sessionId, nextQueue);
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.source_text),
          status: "failed",
          createdAt: now(),
          errorMessage: asString(data.message, "翻译服务未返回结果。"),
        });
        emit("queue", nextQueue);
        return;
      }

      if (bridge.event === "error") {
        const scope = asString(data.scope);
        const code = asString(data.code);
        // `service` wins; `scope` is the legacy fallback.
        const service = errorServiceFromEvent(data.service, scope);
        const title = engineErrorTitle(service, code);
        emit("error", {
          id: `${sessionId}:${revision}:${asString(data.code, "error")}`,
          sessionId,
          service,
          title,
          message: asString(data.message, "翻译引擎返回了未知错误。"),
          recoverable: data.recoverable !== false,
        });
      }
    });
  },
};

export { DEFAULT_SETTINGS };
