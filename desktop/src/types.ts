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
}

export interface PublicSettings {
  sourceLanguage: string;
  targetLanguage: string;
  recognition: RecognitionServiceSettings;
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

export interface SettingsDraft extends Omit<PublicSettings, "recognition" | "translationProviders"> {
  recognition: RecognitionServiceDraft;
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
  health: ServiceHealth;
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
 * A session update. `health` is merged field by field, because most events only
 * learn something about one service and must not silently claim the other two
 * are healthy.
 */
export type SessionPatch = Omit<Partial<SessionState>, "health"> & {
  health?: Partial<ServiceHealth>;
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
  recognition: {
    protocol: "dashscope",
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    model: "qwen-audio-3.0-asr-flash-streaming",
    apiKeyStatus: "missing",
  },
  translationProviders: [
    {
      id: "gemini-default",
      name: "Gemini",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: ["gemini-2.5-flash"],
      selectedModel: "gemini-2.5-flash",
      apiKeyStatus: "missing",
    },
  ],
  activeTranslationProviderId: "gemini-default",
  alwaysOnTop: false,
  subtitleSize: "medium",
};

export function cloneSettings(settings: PublicSettings): PublicSettings {
  return {
    ...settings,
    recognition: { ...settings.recognition },
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
      health: { ...IDLE_HEALTH },
      queue: createEmptyQueue(),
      lastError: null,
    },
    captions: [],
    settings: cloneSettings(DEFAULT_SETTINGS),
  };
}
