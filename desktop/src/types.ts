export type SessionPhase =
  | "needs_configuration"
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "error";

export type HealthStatus =
  "unknown" | "connecting" | "ready" | "degraded" | "failed";

export type CaptionStatus =
  "queued" | "translating" | "translated" | "timed_out" | "failed" | "dropped";

export type SecretStatus =
  "missing" | "environment" | "secure_store" | "unavailable";

export type TranslationProtocol = "gemini" | "openai";

/** Legacy model fields remain only for settings migration. */
export type EngineMode = "realtime";

export type AudioInputKind = "system" | "loopback" | "microphone";

/** `listen` is other people heard by me; `speak` is me heard by other people. */
export type ChannelId = "listen" | "speak";

export const CHANNEL_IDS: ChannelId[] = ["listen", "speak"];

export interface ChannelHealth {
  listen: HealthStatus;
  speak: HealthStatus;
}

export interface AudioDevice {
  id: string;
  name: string;
  channels: number;
  isDefault: boolean;
  loopback: boolean;
}

export interface AudioDeviceList {
  speakers: AudioDevice[];
  microphones: AudioDevice[];
}

export interface RealtimeServiceSettings {
  protocol: "livetranslate";
  baseUrl: string;
  model: string;
  voice: string;
  enableVoiceClone: boolean;
  voiceCloneFrequency: "never" | "once" | "always";
  apiKeyStatus: SecretStatus;
}

export interface AudioChannelSettings {
  voiceMode: "system" | "clone";
  enabled: boolean;
  input: AudioInputKind;
  inputDevice: string;
  targetLanguage: string;
  outputDevice: string;
  playAudio: boolean;
}

export interface AudioSettings {
  listen: AudioChannelSettings;
  speak: AudioChannelSettings;
}

export interface RecognitionServiceSettings {
  protocol: "dashscope";
  baseUrl: string;
  model: string;
  apiKeyStatus: SecretStatus;
}

export interface TranslationProviderSettings {
  id: string;
  name: string;
  protocol: TranslationProtocol;
  baseUrl: string;
  models: string[];
  selectedModel: string;
  apiKeyStatus: SecretStatus;
}

/**
 * `network` was added for the runtime-channel contract
 * (docs/runtime-channel-control.md §4.4). It is a superset of the previous
 * values, so every existing consumer keeps working.
 */
export type ErrorService =
  | "audio"
  | "network"
  | "recognition"
  | "translation"
  | "configuration"
  | "system";

export interface EngineError {
  id: string;
  service: ErrorService;
  title: string;
  message: string;
  recoverable: boolean;
  details?: string;
  sessionId?: string | null;
}

export interface ServiceHealth {
  audio: HealthStatus;
  recognition: HealthStatus;
  translation: HealthStatus;
}

export interface TranslationQueue {
  pending: number;
  limit: number;
  skipped: number;
  lagMs: number;
}

/** Mirrors MAX_TRANSLATION_QUEUE in scripts/tauri_bridge.py. */
export const TRANSLATION_QUEUE_LIMIT = 8;

export function createEmptyQueue(): TranslationQueue {
  return { pending: 0, limit: TRANSLATION_QUEUE_LIMIT, skipped: 0, lagMs: 0 };
}

export const IDLE_HEALTH: ServiceHealth = {
  audio: "unknown",
  recognition: "unknown",
  translation: "unknown",
};

export interface CaptionSegment {
  id: string;
  sessionId: string;
  sequence: number;
  sourceText: string;
  translationText?: string;
  status: CaptionStatus;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
  /** Which realtime direction produced this caption; absent in pipeline mode. */
  channel?: ChannelId;
}

export interface PublicSettings {
  sourceLanguage: string;
  targetLanguage: string;
  engine: EngineMode;
  recognition: RecognitionServiceSettings;
  realtime: RealtimeServiceSettings;
  audio: AudioSettings;
  translationProviders: TranslationProviderSettings[];
  activeTranslationProviderId: string;
  alwaysOnTop: boolean;
  subtitleSize: "small" | "medium" | "large";
}

export interface RecognitionServiceDraft extends Omit<
  RecognitionServiceSettings,
  "apiKeyStatus"
> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface TranslationProviderDraft extends Omit<
  TranslationProviderSettings,
  "apiKeyStatus"
> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface RealtimeServiceDraft extends Omit<
  RealtimeServiceSettings,
  "apiKeyStatus"
> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface SettingsDraft extends Omit<
  PublicSettings,
  "recognition" | "translationProviders" | "realtime"
> {
  recognition: RecognitionServiceDraft;
  realtime: RealtimeServiceDraft;
  translationProviders: TranslationProviderDraft[];
}

export interface SettingsValidation {
  valid: boolean;
  fieldErrors: Record<string, string>;
}

export interface SessionState {
  phase: SessionPhase;
  sessionId: string | null;
  startedAt: string | null;
  deviceName: string | null;
  partialTranscript: string;
  /** Which channel owns `partialTranscript`, so two live channels cannot flicker. */
  partialChannel: ChannelId | null;
  /** Streaming translation for the current turn; realtime engine only. */
  partialTranslation: string;
  health: ServiceHealth;
  channels: ChannelHealth;
  deviceNames: Partial<Record<ChannelId, string>>;
  queue: TranslationQueue;
  lastError: EngineError | null;
}

export interface AppSnapshot {
  revision: number;
  session: SessionState;
  captions: CaptionSegment[];
  settings: PublicSettings;
}

/**
 * A session update. `health`, `channels` and `deviceNames` are merged field by
 * field, because most events only learn something about one service or one
 * channel and must not silently claim the others are healthy.
 */
export type SessionPatch = Omit<
  Partial<SessionState>,
  "health" | "channels" | "deviceNames"
> & {
  health?: Partial<ServiceHealth>;
  channels?: Partial<ChannelHealth>;
  deviceNames?: Partial<Record<ChannelId, string>>;
};

export interface EventEnvelope<T> {
  revision: number;
  sessionId: string | null;
  emittedAt: string;
  payload: T;
}

export type TranslatorEvent =
  | { type: "session"; data: EventEnvelope<SessionPatch> }
  | { type: "caption"; data: EventEnvelope<CaptionSegment> }
  | { type: "queue"; data: EventEnvelope<TranslationQueue> }
  | { type: "error"; data: EventEnvelope<EngineError> }
  | { type: "settings"; data: EventEnvelope<PublicSettings> };

export const DEFAULT_SETTINGS: PublicSettings = {
  sourceLanguage: "自动检测",
  targetLanguage: "简体中文",
  engine: "realtime",
  recognition: {
    protocol: "dashscope",
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    model: "qwen-audio-3.0-asr-flash-streaming",
    apiKeyStatus: "missing",
  },
  realtime: {
    protocol: "livetranslate",
    baseUrl: "wss://maas.qianwenaiapi.com/api-ws/v1/realtime",
    model: "qwen3.8-livetranslate-flash-realtime",
    voice: "default",
    enableVoiceClone: true,
    voiceCloneFrequency: "once",
    apiKeyStatus: "missing",
  },
  audio: {
    listen: {
      voiceMode: "system",
      enabled: true,
      input: "system",
      inputDevice: "",
      targetLanguage: "简体中文",
      outputDevice: "",
      playAudio: false,
    },
    speak: {
      voiceMode: "clone",
      enabled: false,
      input: "microphone",
      inputDevice: "",
      targetLanguage: "English",
      outputDevice: "",
      playAudio: false,
    },
  },
  translationProviders: [
    {
      id: "gemini-default",
      name: "Gemini",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-3.7-flash"],
      selectedModel: "gemini-3.7-flash",
      apiKeyStatus: "missing",
    },
  ],
  activeTranslationProviderId: "gemini-default",
  alwaysOnTop: false,
  subtitleSize: "medium",
};

export function cloneAudioChannel(
  channel: AudioChannelSettings,
): AudioChannelSettings {
  return { ...channel };
}

export function cloneSettings(settings: PublicSettings): PublicSettings {
  return {
    ...settings,
    recognition: { ...settings.recognition },
    realtime: { ...settings.realtime },
    audio: {
      listen: cloneAudioChannel(settings.audio.listen),
      speak: cloneAudioChannel(settings.audio.speak),
    },
    translationProviders: settings.translationProviders.map((provider) => ({
      ...provider,
      models: [...provider.models],
    })),
  };
}

export function createInitialSnapshot(): AppSnapshot {
  return {
    revision: 0,
    session: {
      phase: "idle",
      sessionId: null,
      startedAt: null,
      deviceName: "默认播放设备",
      partialTranscript: "",
      partialChannel: null,
      partialTranslation: "",
      health: { ...IDLE_HEALTH },
      channels: { listen: "unknown", speak: "unknown" },
      deviceNames: {},
      queue: createEmptyQueue(),
      lastError: null,
    },
    captions: [],
    settings: cloneSettings(DEFAULT_SETTINGS),
  };
}

/* ==========================================================================
   Runtime state — tray / global shortcuts / runtime channel control
   Frozen contract: docs/tray-shortcuts-contract.md §2-§5.
   Field names here are the wire format (Rust `rename_all = "camelCase"`);
   do not rename them without changing the contract first.
   ========================================================================== */

export type TrayStatus =
  | "not_started"
  | "connecting"
  | "translating"
  | "audio_error"
  | "network_error";

/** Same five values as HealthStatus; the contract refers to it by this name. */
export type RuntimeHealth = HealthStatus;

/** Health of the audio / network chain, as reported by the Python sidecar. */
export type RuntimeService = "audio" | "network" | "configuration" | "system";

export type RuntimeAction =
  | "start_or_stop_session"
  | "toggle_speak_mute"
  | "toggle_listen_channel"
  | "toggle_speak_channel"
  | "toggle_subtitle_window"
  | "show_main_window"
  | "quit_application";

export interface ShortcutFailure {
  /** Normalised accelerator text, for example "Ctrl+Shift+Space". */
  accelerator: string;
  action: RuntimeAction;
  /** Registration failure reason, shown in the main window. */
  reason: string;
}

export interface RuntimeError {
  id: string;
  service: RuntimeService;
  code: string;
  message: string;
  recoverable: boolean;
  sessionId: string | null;
}

export interface RuntimeState {
  /** Monotonic. Updates with `revision <= current` must be discarded. */
  revision: number;
  trayStatus: TrayStatus;
  sessionPhase: SessionPhase;
  sessionId: string | null;
  audioHealth: RuntimeHealth;
  networkHealth: RuntimeHealth;
  /** Runtime effective value, not the value stored in the settings file. */
  listenEnabled: boolean;
  speakEnabled: boolean;
  speakMuted: boolean;
  subtitleVisible: boolean;
  /** Accelerators that failed to register; empty when all of them succeeded. */
  shortcutFailures: ShortcutFailure[];
  lastError: RuntimeError | null;
  /** RFC3339. */
  updatedAt: string;
}
