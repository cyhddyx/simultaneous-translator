import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  DEFAULT_SETTINGS,
  IDLE_HEALTH,
  createEmptyQueue,
  createInitialSnapshot,
  type AppSnapshot,
  type CaptionSegment,
  type EngineError,
  type EventEnvelope,
  type PublicSettings,
  type SettingsDraft,
  type SettingsValidation,
  type TranslationProviderDraft,
  type TranslatorEvent,
  type TranslationQueue,
} from "./types";

type EventListener = (event: TranslatorEvent) => void;

const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const deepCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const now = () => new Date().toISOString();

const mockSentences = [
  {
    source: "Welcome, everyone. We will begin with the product roadmap for the next quarter.",
    translation: "各位好。我们将先介绍下个季度的产品路线图。",
  },
  {
    source: "The team has finished the reliability work and is preparing the staged rollout.",
    translation: "团队已经完成可靠性工作，正在准备分阶段发布。",
  },
  {
    source: "Please hold questions until the end so we can keep the discussion moving.",
    translation: "请把问题留到最后，这样我们可以保持讨论进度。",
  },
  {
    source: "The first build is expected on Friday, subject to the final verification results.",
    translation: "首个构建版本预计将在周五推出，具体取决于最终验证结果。",
  },
  {
    source: "We will share the rollback plan with the support team before the release window.",
    translation: "我们会在发布窗口之前与支持团队共享回滚计划。",
  },
];

class MockTranslator {
  private snapshot = createInitialSnapshot();
  private listeners = new Set<EventListener>();
  private timers = new Set<number>();
  private sentenceIndex = 0;
  private sequence = 0;

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

  async start(): Promise<{ sessionId: string }> {
    this.clearTimers();
    const sessionId = `mock-${Date.now()}`;
    this.snapshot.session = {
      ...this.snapshot.session,
      phase: "starting",
      sessionId,
      startedAt: now(),
      partialTranscript: "",
      health: { audio: "connecting", recognition: "connecting", translation: "connecting" },
      queue: createEmptyQueue(),
      lastError: null,
    };
    this.bump();
    this.emit("session", this.snapshot.session, sessionId);

    this.schedule(() => {
      if (this.snapshot.session.sessionId !== sessionId) return;
      this.snapshot.session = {
        ...this.snapshot.session,
        phase: "listening",
        deviceName: "默认扬声器 (Mock Audio)",
        health: { audio: "ready", recognition: "ready", translation: "ready" },
      };
      this.bump();
      this.emit("session", this.snapshot.session, sessionId);
      this.runSentence(sessionId);
    }, 700);

    return { sessionId };
  }

  async stop(sessionId: string | null): Promise<void> {
    if (!sessionId || this.snapshot.session.sessionId !== sessionId) return;
    this.snapshot.session = { ...this.snapshot.session, phase: "stopping", partialTranscript: "" };
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
    this.emit("session", { partialTranscript: this.snapshot.session.partialTranscript }, this.snapshot.session.sessionId);
  }

  async saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
    const recognitionStatus = draft.recognition.clearApiKey
      ? "missing"
      : draft.recognition.apiKey?.trim()
        ? "secure_store"
        : draft.recognition.protocol === this.snapshot.settings.recognition.protocol
            && draft.recognition.baseUrl.trim() === this.snapshot.settings.recognition.baseUrl
          ? this.snapshot.settings.recognition.apiKeyStatus
          : "missing";
    const translationProviders = draft.translationProviders.map((provider) => {
      const current = this.snapshot.settings.translationProviders.find((item) => item.id === provider.id);
      const apiKeyStatus = provider.clearApiKey
        ? "missing"
        : provider.apiKey?.trim()
          ? "secure_store"
          : current?.protocol === provider.protocol && current.baseUrl === provider.baseUrl.trim()
            ? current.apiKeyStatus
            : "missing";
      const { apiKey: _apiKey, clearApiKey: _clearApiKey, ...publicProvider } = provider;
      return { ...publicProvider, apiKeyStatus };
    });
    this.snapshot.settings = {
      sourceLanguage: draft.sourceLanguage,
      targetLanguage: draft.targetLanguage,
      recognition: {
        protocol: draft.recognition.protocol,
        baseUrl: draft.recognition.baseUrl,
        model: draft.recognition.model,
        apiKeyStatus: recognitionStatus,
      },
      translationProviders,
      activeTranslationProviderId: draft.activeTranslationProviderId,
      alwaysOnTop: draft.alwaysOnTop,
      subtitleSize: draft.subtitleSize,
    };
    this.bump();
    this.emit("settings", this.snapshot.settings, this.snapshot.session.sessionId);
    return deepCopy(this.snapshot.settings);
  }

  private runSentence(sessionId: string): void {
    if (this.snapshot.session.sessionId !== sessionId || this.snapshot.session.phase !== "listening") return;
    const sentence = mockSentences[this.sentenceIndex % mockSentences.length];
    this.sentenceIndex += 1;
    const words = sentence.source.split(" ");
    let wordIndex = 0;

    const partialTimer = window.setInterval(() => {
      if (this.snapshot.session.sessionId !== sessionId || this.snapshot.session.phase !== "listening") {
        window.clearInterval(partialTimer);
        return;
      }
      wordIndex += 2;
      this.snapshot.session.partialTranscript = words.slice(0, wordIndex).join(" ");
      this.bump();
      this.emit("session", { partialTranscript: this.snapshot.session.partialTranscript }, sessionId);
      if (wordIndex >= words.length) {
        window.clearInterval(partialTimer);
        this.finishSentence(sessionId, sentence.source, sentence.translation);
      }
    }, 125);
    this.timers.add(partialTimer);
  }

  private finishSentence(sessionId: string, sourceText: string, translationText: string): void {
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
    this.snapshot.session.queue = { ...this.snapshot.session.queue, pending: 1, lagMs: 620 };
    this.bump();
    this.emit("caption", segment, sessionId);
    this.emit("queue", this.snapshot.session.queue, sessionId);

    this.schedule(() => {
      if (this.snapshot.session.sessionId !== sessionId) return;
      const item = this.snapshot.captions.find((caption) => caption.id === segment.id);
      if (!item) return;
      item.translationText = translationText;
      item.status = "translated";
      item.completedAt = now();
      this.snapshot.session.queue = { ...this.snapshot.session.queue, pending: 0, lagMs: 0 };
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

function validateDraft(draft: SettingsDraft): SettingsValidation {
  const fieldErrors: SettingsValidation["fieldErrors"] = {};
  const validateUrl = (value: string, protocol: "wss:" | "https:", field: string) => {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== protocol) {
        fieldErrors[field] = `地址必须使用 ${protocol}// 加密连接。`;
      } else if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        fieldErrors[field] = "地址不能包含凭据、查询参数或片段。";
      }
    } catch {
      fieldErrors[field] = "请输入有效的服务地址。";
    }
  };

  validateUrl(draft.recognition.baseUrl, "wss:", "recognition.baseUrl");
  if (!draft.recognition.model.trim()) fieldErrors["recognition.model"] = "请输入语音识别模型名称。";
  if (!draft.translationProviders.length) fieldErrors.translationProviders = "请至少添加一个翻译服务商。";
  const ids = new Set<string>();
  draft.translationProviders.forEach((provider) => {
    const prefix = `provider.${provider.id}`;
    if (!provider.name.trim()) fieldErrors[`${prefix}.name`] = "请输入服务商名称。";
    validateUrl(provider.baseUrl, "https:", `${prefix}.baseUrl`);
    if (!provider.selectedModel.trim()) fieldErrors[`${prefix}.selectedModel`] = "请添加并选择一个模型。";
    if (provider.models.length > 100) fieldErrors[`${prefix}.selectedModel`] = "每个服务商最多保留 100 个模型。";
    if (ids.has(provider.id)) fieldErrors.translationProviders = "服务商标识重复，请删除后重新添加。";
    ids.add(provider.id);
  });
  if (!ids.has(draft.activeTranslationProviderId)) {
    fieldErrors.activeTranslationProviderId = "请选择当前使用的翻译服务商。";
  }
  if (!draft.targetLanguage.trim()) fieldErrors.targetLanguage = "请选择目标语言。";

  return { valid: Object.keys(fieldErrors).length === 0, fieldErrors };
}

function emitTauri<T>(type: TranslatorEvent["type"], data: EventEnvelope<T>, listener: EventListener): void {
  listener({ type, data } as TranslatorEvent);
}

interface BackendSettingsSnapshot {
  sourceLanguage: string;
  targetLanguage: string;
  recognition: {
    protocol: "dashscope";
    baseUrl: string;
    model: string;
    apiKeyStatus: string;
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

function toSecretStatus(value: string): PublicSettings["recognition"]["apiKeyStatus"] {
  if (value === "environment" || value === "secure_store" || value === "unavailable") return value;
  return "missing";
}

function toPublicSettings(raw: BackendSettingsSnapshot): PublicSettings {
  const subtitleSize = raw.captionScale === "small" || raw.captionScale === "large" ? raw.captionScale : "medium";
  return {
    sourceLanguage: raw.sourceLanguage,
    targetLanguage: raw.targetLanguage,
    recognition: {
      protocol: "dashscope",
      baseUrl: raw.recognition.baseUrl,
      model: raw.recognition.model,
      apiKeyStatus: toSecretStatus(raw.recognition.apiKeyStatus),
    },
    translationProviders: raw.translationProviders.map((provider) => ({
      ...provider,
      models: [...provider.models],
      apiKeyStatus: toSecretStatus(provider.apiKeyStatus),
    })),
    activeTranslationProviderId: raw.activeTranslationProviderId,
    alwaysOnTop: raw.keepOnTop,
    subtitleSize,
  };
}

function toBackendSettings(draft: SettingsDraft) {
  const recognitionApiKey = draft.recognition.apiKey?.trim();
  return {
    sourceLanguage: draft.sourceLanguage.trim(),
    targetLanguage: draft.targetLanguage.trim(),
    recognition: {
      protocol: draft.recognition.protocol,
      baseUrl: draft.recognition.baseUrl.trim(),
      model: draft.recognition.model.trim(),
      ...(recognitionApiKey ? { apiKey: recognitionApiKey } : {}),
      ...(draft.recognition.clearApiKey ? { clearApiKey: true } : {}),
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

function eventEnvelope<T>(revision: number, sessionId: string | null, payload: T): EventEnvelope<T> {
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

function configured(settings: PublicSettings): boolean {
  const activeProvider = settings.translationProviders.find(
    (provider) => provider.id === settings.activeTranslationProviderId,
  );
  const usable = (status: PublicSettings["recognition"]["apiKeyStatus"]) =>
    status === "environment" || status === "secure_store";
  return usable(settings.recognition.apiKeyStatus) && Boolean(activeProvider && usable(activeProvider.apiKeyStatus));
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
    snapshot.session.phase = configured(settings) ? "idle" : "needs_configuration";
    if (activeSession.sessionId) {
      // The sidecar continues independently of a WebView reload. Reattach to
      // its known session ID so subsequent events are not discarded as stale.
      snapshot.session = {
        ...snapshot.session,
        phase: "listening",
        sessionId: activeSession.sessionId,
        startedAt: now(),
        health: { audio: "connecting", recognition: "connecting", translation: "connecting" },
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
    return invoke<StartTranslationResult>("start_translation");
  },

  async stopSession(sessionId: string | null): Promise<void> {
    if (!isTauriRuntime()) return mockTranslator.stop(sessionId);
    if (!sessionId) return;
    try {
      await invoke("stop_translation", { sessionId });
    } finally {
      // Stopping kills the sidecar, so no terminal "stopped" event arrives to
      // release this entry.
      bridgeQueues.delete(sessionId);
    }
  },

  async clearHistory(): Promise<void> {
    if (!isTauriRuntime()) return mockTranslator.clearHistory();
    // The current bridge deliberately keeps no caption persistence; the UI owns
    // its bounded in-memory history and clears it immediately.
  },

  async validateSettings(draft: SettingsDraft): Promise<SettingsValidation> {
    const localValidation = validateDraft(draft);
    return localValidation;
  },

  async saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
    if (!isTauriRuntime()) return mockTranslator.saveSettings(draft);
    const raw = await invoke<BackendSettingsSnapshot>("save_settings", { input: toBackendSettings(draft) });
    return toPublicSettings(raw);
  },

  async fetchProviderModels(provider: TranslationProviderDraft): Promise<ProviderModelsResult> {
    if (!isTauriRuntime()) {
      return {
        models: provider.models.length ? [...provider.models] : [provider.selectedModel].filter(Boolean),
        supported: true,
      };
    }
    return invoke<ProviderModelsResult>("fetch_provider_models", {
      input: toProviderProbeInput(provider),
    });
  },

  async testProviderConnection(provider: TranslationProviderDraft): Promise<ProviderConnectionResult> {
    if (!isTauriRuntime()) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return { ok: true, latencyMs: 350, detail: "浏览器演示连接正常" };
    }
    return invoke<ProviderConnectionResult>("test_provider_connection", {
      input: toProviderProbeInput(provider),
    });
  },

  async copyText(text: string): Promise<void> {
    await copyInBrowser(text);
  },

  async subscribe(listener: EventListener): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return mockTranslator.subscribe(listener);

    return listen<BridgeEvent>("translator-event", (event) => {
      const bridge = event.payload;
      if (bridge.type !== "event" || typeof bridge.event !== "string") return;
      const sessionId = typeof bridge.session_id === "string" ? bridge.session_id : null;
      const revision = nextBridgeRevision(bridge.sequence);
      const data = asRecord(bridge.data);
      const emit = <T,>(type: TranslatorEvent["type"], payload: T) =>
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
            health: { audio: "connecting", recognition: "connecting", translation: "connecting" },
            queue: queueFor(sessionId),
            lastError: null,
          });
        }
        // "listening" only means the sidecar opened its local ASR task. The
        // DashScope SDK reports that before the WebSocket handshake completes,
        // and nothing has reached the translation service yet, so both stay
        // "connecting" until real traffic proves otherwise.
        if (state === "listening") emit("session", { phase: "listening" });
        if (state === "stopping") emit("session", { phase: "stopping", partialTranscript: "" });
        if (state === "stopped") {
          emit("session", {
            phase: "idle",
            sessionId: null,
            startedAt: null,
            partialTranscript: "",
            health: { ...IDLE_HEALTH },
            queue: createEmptyQueue(),
          });
          if (sessionId) bridgeQueues.delete(sessionId);
        }
        return;
      }

      if (!sessionId) return;

      if (bridge.event === "audio.device") {
        emit("session", {
          deviceName: asString(data.name, "默认播放设备"),
        });
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
        emit("session", {
          partialTranscript: asString(data.text),
          health: { recognition: "ready" },
        });
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
        emit("session", { health: { recognition: "ready" } });
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.text),
          status: "translating",
          createdAt: now(),
        });
        emit("queue", nextQueue);
        return;
      }

      if (bridge.event === "translation") {
        const sourceSequence = asNumber(data.source_seq);
        const queue = queueFor(sessionId);
        const nextQueue = { ...queue, pending: Math.max(0, queue.pending - 1), lagMs: 0 };
        bridgeQueues.set(sessionId, nextQueue);
        emit("session", { health: { translation: "ready" } });
        emit("caption", {
          id: `${sessionId}:${sourceSequence}`,
          sessionId,
          sequence: sourceSequence,
          sourceText: asString(data.source_text),
          translationText: asString(data.text, "（无翻译结果）"),
          status: "translated",
          createdAt: now(),
          completedAt: now(),
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
        const nextQueue = { ...queue, pending: Math.max(0, queue.pending - 1), lagMs: 0 };
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
        const service: EngineError["service"] =
          scope === "audio" ? "audio" : scope === "asr" ? "recognition" : scope === "translation" ? "translation" : "system";
        const title =
          service === "audio"
            ? "音频采集失败"
            : service === "recognition"
              ? "语音识别失败"
              : service === "translation"
                ? "翻译服务失败"
                : "翻译引擎错误";
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
