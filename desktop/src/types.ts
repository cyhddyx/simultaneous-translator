export type SessionPhase =
  | "needs_configuration"
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "error";

export type HealthStatus = "unknown" | "connecting" | "ready" | "degraded" | "failed";

export type CaptionStatus =
  | "queued"
  | "translating"
  | "translated"
  | "timed_out"
  | "failed"
  | "dropped";

export type SecretStatus = "missing" | "environment" | "secure_store" | "unavailable";

export type TranslationProtocol = "gemini" | "openai";

/** `realtime` runs one speech-to-speech model; `pipeline` chains ASR + text model. */
export type EngineMode = "pipeline" | "realtime";

export type AudioInputKind = "loopback" | "microphone";

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

export type ErrorService = "audio" | "recognition" | "translation" | "configuration" | "system";

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

export interface RecognitionServiceDraft extends Omit<RecognitionServiceSettings, "apiKeyStatus"> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface TranslationProviderDraft extends Omit<TranslationProviderSettings, "apiKeyStatus"> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface RealtimeServiceDraft extends Omit<RealtimeServiceSettings, "apiKeyStatus"> {
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface SettingsDraft
  extends Omit<
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
  engine: "pipeline",
  recognition: {
    protocol: "dashscope",
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    model: "qwen-audio-3.0-asr-flash-streaming",
    apiKeyStatus: "missing",
  },
  realtime: {
    protocol: "livetranslate",
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: "qwen3.5-livetranslate-flash-realtime",
    voice: "",
    enableVoiceClone: false,
    voiceCloneFrequency: "once",
    apiKeyStatus: "missing",
  },
  audio: {
    listen: {
      enabled: true,
      input: "loopback",
      inputDevice: "",
      targetLanguage: "简体中文",
      outputDevice: "",
      playAudio: true,
    },
    speak: {
      enabled: true,
      input: "microphone",
      inputDevice: "",
      targetLanguage: "English",
      outputDevice: "",
      playAudio: true,
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

export function cloneAudioChannel(channel: AudioChannelSettings): AudioChannelSettings {
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
