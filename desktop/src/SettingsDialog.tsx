import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MonitorUp,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Star,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Volume2,
  X,
} from "lucide-react";

import { translatorApi } from "./tauri";
import type {
  PublicSettings,
  SecretStatus,
  SettingsDraft,
  SettingsValidation,
  TranslationProtocol,
  TranslationProviderDraft,
} from "./types";

type SettingsSection = "general" | "audio" | "services" | "privacy";
type ServiceView = "recognition" | "translation";
type ProviderAction = "models" | "connection";

interface ProviderNotice {
  providerId: string;
  tone: "success" | "error" | "neutral";
  message: string;
}

interface SettingsDialogProps {
  settings: PublicSettings;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => Promise<void>;
  onValidate: (draft: SettingsDraft) => Promise<SettingsValidation>;
}

const sectionLabels: Array<{ id: SettingsSection; label: string; icon: typeof SlidersHorizontal }> = [
  { id: "general", label: "常规", icon: SlidersHorizontal },
  { id: "audio", label: "音频", icon: Volume2 },
  { id: "services", label: "服务", icon: Radio },
  { id: "privacy", label: "隐私与安全", icon: ShieldCheck },
];

const defaultProviderEndpoint: Record<TranslationProtocol, string> = {
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com",
};
const MAX_MODELS_PER_PROVIDER = 100;

function endpointForComparison(value: string, versionSuffix?: string): string {
  try {
    const url = new URL(value.trim());
    let path = url.pathname.replace(/\/+$/, "");
    if (versionSuffix && path.toLowerCase().endsWith(versionSuffix)) {
      path = path.slice(0, -versionSuffix.length);
    }
    url.pathname = path || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function sameProviderTarget(
  persisted: Pick<TranslationProviderDraft, "protocol" | "baseUrl">,
  draft: Pick<TranslationProviderDraft, "protocol" | "baseUrl">,
): boolean {
  if (persisted.protocol !== draft.protocol) return false;
  const suffix = draft.protocol === "gemini" ? "/v1beta" : "/v1";
  return endpointForComparison(persisted.baseUrl, suffix) === endpointForComparison(draft.baseUrl, suffix);
}

const toDraft = (settings: PublicSettings): SettingsDraft => ({
  sourceLanguage: settings.sourceLanguage,
  targetLanguage: settings.targetLanguage,
  recognition: {
    protocol: "dashscope",
    baseUrl: settings.recognition.baseUrl,
    model: settings.recognition.model,
    clearApiKey: false,
  },
  translationProviders: settings.translationProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    selectedModel: provider.selectedModel,
    clearApiKey: false,
  })),
  activeTranslationProviderId: settings.activeTranslationProviderId,
  alwaysOnTop: settings.alwaysOnTop,
  subtitleSize: settings.subtitleSize,
});

/**
 * An emptied API Key field leaves `apiKey: ""` behind, which a plain stringify
 * would report as a change against a freshly derived draft. Drop the fields that
 * carry no request so "有未保存的更改" only appears for real edits.
 */
function draftFingerprint(draft: SettingsDraft): string {
  const secretFields = <T extends { apiKey?: string; clearApiKey?: boolean }>(value: T) => ({
    ...value,
    apiKey: value.apiKey?.trim() || undefined,
    clearApiKey: value.clearApiKey || undefined,
  });
  return JSON.stringify({
    ...draft,
    recognition: secretFields(draft.recognition),
    translationProviders: draft.translationProviders.map(secretFields),
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  return error instanceof Error && error.message ? error.message : fallback;
}

function createProvider(): TranslationProviderDraft {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `custom-${suffix}`,
    name: "新服务商",
    protocol: "openai",
    baseUrl: defaultProviderEndpoint.openai,
    models: [],
    selectedModel: "",
    clearApiKey: false,
  };
}

function SecretField({
  label,
  status,
  value,
  onChange,
  clearRequested,
  onClearChange,
  canClearStored = false,
}: {
  label: string;
  status: SecretStatus;
  value: string | undefined;
  onChange: (value: string) => void;
  clearRequested: boolean;
  onClearChange: (clear: boolean) => void;
  canClearStored?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const environmentOwned = status === "environment";
  const replacementPending = Boolean(value?.trim());
  const statusLabel = clearRequested
    ? "保存后删除"
    : replacementPending
      ? "等待保存"
      : status === "environment"
        ? "由环境变量提供"
        : status === "secure_store"
          ? "已安全保存"
          : status === "unavailable"
            ? "凭据暂不可用"
            : "尚未配置";
  const statusTone = clearRequested || replacementPending ? "pending" : status;

  return (
    <label className="field-group">
      <span className="field-label">
        {label}
        <span className={`secret-source secret-source--${statusTone}`}>
          <KeyRound size={12} aria-hidden="true" />
          {statusLabel}
        </span>
      </span>
      <span className="secret-input-wrap">
        <input
          value={environmentOwned ? "" : value ?? ""}
          onChange={(event) => {
            onClearChange(false);
            onChange(event.target.value);
          }}
          type={visible ? "text" : "password"}
          disabled={environmentOwned || clearRequested}
          placeholder={
            environmentOwned
              ? "应用启动时读取，保存设置不会写入本地"
              : clearRequested
                ? "保存时将从凭据管理器删除"
                : status === "secure_store"
                  ? "••••••••••••  已保存，输入可替换"
                  : "请输入 API Key"
          }
          autoComplete="off"
          spellCheck={false}
        />
        {!environmentOwned && (
          <>
            {(status === "secure_store" || canClearStored) && (
              <button
                className={`icon-button icon-button--input icon-button--input-clear ${clearRequested ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  onChange("");
                  onClearChange(!clearRequested);
                }}
                aria-label={clearRequested ? "保留已保存密钥" : "保存时清除密钥"}
                title={clearRequested ? "保留已保存密钥" : "保存时清除密钥"}
              >
                <Trash2 size={15} />
              </button>
            )}
            <button
              className="icon-button icon-button--input"
              type="button"
              onClick={() => setVisible((current) => !current)}
              disabled={!value}
              aria-label={visible ? "隐藏新密钥" : "显示新密钥"}
              title={value ? (visible ? "隐藏新密钥" : "显示新密钥") : "已保存的密钥不会回显"}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </>
        )}
      </span>
    </label>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        className="switch-input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

export function SettingsDialog({ settings, onClose, onSave, onValidate }: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [serviceView, setServiceView] = useState<ServiceView>("translation");
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(settings));
  const [selectedProviderId, setSelectedProviderId] = useState(settings.activeTranslationProviderId);
  const [newModel, setNewModel] = useState("");
  const [providerBusy, setProviderBusy] = useState<{ providerId: string; action: ProviderAction } | null>(null);
  const [providerNotice, setProviderNotice] = useState<ProviderNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SettingsValidation["fieldErrors"]>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setDraft(toDraft(settings));
    setSelectedProviderId(settings.activeTranslationProviderId);
    setProviderNotice(null);
    setFieldErrors({});
    setSaveError(null);
  }, [settings]);

  useEffect(() => {
    setNewModel("");
  }, [selectedProviderId]);

  const dirty = useMemo(
    () => draftFingerprint(draft) !== draftFingerprint(toDraft(settings)),
    [draft, settings],
  );
  const selectedProvider = useMemo(
    () => draft.translationProviders.find((provider) => provider.id === selectedProviderId) ?? null,
    [draft.translationProviders, selectedProviderId],
  );
  const selectedPersistedProvider = useMemo(
    () => settings.translationProviders.find((provider) => provider.id === selectedProviderId) ?? null,
    [selectedProviderId, settings.translationProviders],
  );
  const selectedProviderTargetChanged = Boolean(
    selectedPersistedProvider
      && selectedProvider
      && !sameProviderTarget(selectedPersistedProvider, selectedProvider),
  );
  const selectedProviderStatus = useMemo<SecretStatus>(
    () => {
      if (selectedProviderTargetChanged) {
        return "missing";
      }
      return selectedPersistedProvider?.apiKeyStatus ?? "missing";
    },
    [selectedPersistedProvider?.apiKeyStatus, selectedProviderTargetChanged],
  );
  const recognitionTargetChanged = settings.recognition.protocol !== draft.recognition.protocol
    || endpointForComparison(settings.recognition.baseUrl) !== endpointForComparison(draft.recognition.baseUrl);
  const recognitionStatus: SecretStatus = recognitionTargetChanged
    ? "missing"
    : settings.recognition.apiKeyStatus;

  const clearFieldErrors = (...fields: string[]) => {
    setFieldErrors((current) => {
      const next = { ...current };
      fields.forEach((field) => delete next[field]);
      return next;
    });
  };

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearFieldErrors(String(key));
  };

  const updateRecognition = <K extends keyof SettingsDraft["recognition"]>(
    key: K,
    value: SettingsDraft["recognition"][K],
  ) => {
    setDraft((current) => ({
      ...current,
      recognition: { ...current.recognition, [key]: value },
    }));
    clearFieldErrors(`recognition.${String(key)}`);
  };

  const updateProvider = (providerId: string, patch: Partial<TranslationProviderDraft>) => {
    setDraft((current) => ({
      ...current,
      translationProviders: current.translationProviders.map((provider) =>
        provider.id === providerId ? { ...provider, ...patch } : provider,
      ),
    }));
    setProviderNotice(null);
    Object.keys(patch).forEach((field) => clearFieldErrors(`provider.${providerId}.${field}`));
  };

  const addProvider = () => {
    const provider = createProvider();
    setDraft((current) => ({
      ...current,
      translationProviders: [...current.translationProviders, provider],
    }));
    setSelectedProviderId(provider.id);
    setServiceView("translation");
    setProviderNotice(null);
    clearFieldErrors("translationProviders");
  };

  const deleteProvider = (provider: TranslationProviderDraft) => {
    if (draft.translationProviders.length <= 1) return;
    if (!window.confirm(`删除服务商“${provider.name || "未命名服务商"}”？`)) return;
    const remaining = draft.translationProviders.filter((item) => item.id !== provider.id);
    const nextSelected = remaining[0];
    setDraft((current) => ({
      ...current,
      translationProviders: current.translationProviders.filter((item) => item.id !== provider.id),
      activeTranslationProviderId:
        current.activeTranslationProviderId === provider.id ? nextSelected.id : current.activeTranslationProviderId,
    }));
    setSelectedProviderId(nextSelected.id);
    setProviderNotice(null);
    clearFieldErrors("translationProviders", "activeTranslationProviderId");
  };

  const changeProviderProtocol = (provider: TranslationProviderDraft, protocol: TranslationProtocol) => {
    const isPresetEndpoint = Object.values(defaultProviderEndpoint).includes(provider.baseUrl);
    updateProvider(provider.id, {
      protocol,
      ...(isPresetEndpoint ? { baseUrl: defaultProviderEndpoint[protocol] } : {}),
    });
  };

  const addModel = () => {
    if (!selectedProvider) return;
    const model = newModel.trim();
    if (!model) return;
    if (!selectedProvider.models.includes(model) && selectedProvider.models.length >= MAX_MODELS_PER_PROVIDER) {
      setProviderNotice({
        providerId: selectedProvider.id,
        tone: "error",
        message: `每个服务商最多保留 ${MAX_MODELS_PER_PROVIDER} 个模型。`,
      });
      return;
    }
    const models = selectedProvider.models.includes(model)
      ? selectedProvider.models
      : [...selectedProvider.models, model];
    updateProvider(selectedProvider.id, {
      models,
      selectedModel: selectedProvider.selectedModel || model,
    });
    setNewModel("");
  };

  const deleteModel = (model: string) => {
    if (!selectedProvider) return;
    const models = selectedProvider.models.filter((item) => item !== model);
    updateProvider(selectedProvider.id, {
      models,
      selectedModel: selectedProvider.selectedModel === model ? models[0] ?? "" : selectedProvider.selectedModel,
    });
  };

  const providerCanUseKey = (provider: TranslationProviderDraft) => {
    const persisted = settings.translationProviders.find((item) => item.id === provider.id);
    const status = persisted && sameProviderTarget(persisted, provider)
      ? persisted.apiKeyStatus
      : "missing";
    if (provider.clearApiKey && !provider.apiKey?.trim()) {
      setProviderNotice({ providerId: provider.id, tone: "error", message: "此密钥已标记为删除，请先撤销删除或输入新密钥。" });
      return false;
    }
    if ((status === "missing" || status === "unavailable") && !provider.apiKey?.trim()) {
      setProviderNotice({ providerId: provider.id, tone: "error", message: "请先输入 API Key。" });
      return false;
    }
    return true;
  };

  const fetchModels = async (provider: TranslationProviderDraft) => {
    if (!providerCanUseKey(provider)) return;
    setProviderBusy({ providerId: provider.id, action: "models" });
    setProviderNotice(null);
    try {
      const result = await translatorApi.fetchProviderModels(provider);
      if (!result.supported) {
        setProviderNotice({ providerId: provider.id, tone: "neutral", message: "该服务不提供模型列表，请手动添加模型。" });
        return;
      }
      const selectedModel = provider.selectedModel.trim();
      const models = [...new Set([
        ...(selectedModel ? [selectedModel] : []),
        ...provider.models,
        ...result.models.map((model) => model.trim()).filter(Boolean),
      ])].slice(0, MAX_MODELS_PER_PROVIDER);
      updateProvider(provider.id, {
        models,
        selectedModel: provider.selectedModel || models[0] || "",
      });
      setProviderNotice({
        providerId: provider.id,
        tone: "success",
        message: result.models.length
          ? `已获取 ${result.models.length} 个模型，当前保留 ${models.length} 个。`
          : "服务已连接，但没有返回可用模型。",
      });
    } catch (error) {
      setProviderNotice({ providerId: provider.id, tone: "error", message: errorMessage(error, "获取模型列表失败。") });
    } finally {
      setProviderBusy(null);
    }
  };

  const testConnection = async (provider: TranslationProviderDraft) => {
    if (!providerCanUseKey(provider)) return;
    if (!provider.selectedModel.trim()) {
      setProviderNotice({ providerId: provider.id, tone: "error", message: "请先添加并选择一个模型。" });
      return;
    }
    setProviderBusy({ providerId: provider.id, action: "connection" });
    setProviderNotice(null);
    try {
      const result = await translatorApi.testProviderConnection(provider);
      setProviderNotice({
        providerId: provider.id,
        tone: result.ok ? "success" : "error",
        message: result.ok ? `${result.detail} · ${result.latencyMs} ms` : result.detail,
      });
    } catch (error) {
      setProviderNotice({ providerId: provider.id, tone: "error", message: errorMessage(error, "连接测试失败。") });
    } finally {
      setProviderBusy(null);
    }
  };

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("放弃未保存的设置更改？")) return;
    onClose();
  }, [dirty, onClose]);

  const requestCloseRef = useRef(requestClose);

  useEffect(() => {
    requestCloseRef.current = requestClose;
  }, [requestClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus());
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const save = async () => {
    setSaveError(null);
    let validation: SettingsValidation;
    try {
      validation = await onValidate(draft);
    } catch (error) {
      setSaveError(errorMessage(error, "无法验证设置，请稍后重试。"));
      return;
    }
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      const firstInvalid = Object.keys(validation.fieldErrors)[0] ?? "";
      if (firstInvalid.startsWith("recognition.")) {
        setSection("services");
        setServiceView("recognition");
      } else if (
        firstInvalid.startsWith("provider.") ||
        firstInvalid === "translationProviders" ||
        firstInvalid === "activeTranslationProviderId"
      ) {
        const providerId = firstInvalid.startsWith("provider.") ? firstInvalid.split(".")[1] : null;
        if (providerId) setSelectedProviderId(providerId);
        setSection("services");
        setServiceView("translation");
      } else {
        setSection("general");
      }
      return;
    }

    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error, "设置保存失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <div>
            <p className="eyebrow">同传翻译</p>
            <h2 id="settings-title">设置</h2>
          </div>
          <button className="icon-button" type="button" onClick={requestClose} aria-label="关闭设置" title="关闭设置">
            <X size={19} />
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-nav" aria-label="设置分区">
            {sectionLabels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`settings-nav__item ${section === id ? "is-active" : ""}`}
                type="button"
                onClick={() => setSection(id)}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {section === "general" && (
              <>
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <SlidersHorizontal size={18} aria-hidden="true" />
                    <div>
                      <h3>翻译显示</h3>
                      <p>控制识别语言、译文语言与阅读尺寸。</p>
                    </div>
                  </div>
                  <div className="field-grid">
                    <label className="field-group">
                      <span className="field-label">源语言</span>
                      <select value={draft.sourceLanguage} onChange={(event) => update("sourceLanguage", event.target.value)}>
                        <option>自动检测</option>
                        <option>英语</option>
                        <option>中文</option>
                        <option>日语</option>
                        <option>韩语</option>
                      </select>
                    </label>
                    <label className="field-group">
                      <span className="field-label">目标语言</span>
                      <select value={draft.targetLanguage} onChange={(event) => update("targetLanguage", event.target.value)}>
                        <option>简体中文</option>
                        <option>English</option>
                        <option>日本語</option>
                        <option>한국어</option>
                      </select>
                      {fieldErrors.targetLanguage && <span className="field-error">{fieldErrors.targetLanguage}</span>}
                    </label>
                  </div>
                  <fieldset className="segmented-field">
                    <legend>字幕尺寸</legend>
                    <div className="segmented-control">
                      <button
                        type="button"
                        className={draft.subtitleSize === "small" ? "is-active" : ""}
                        onClick={() => update("subtitleSize", "small")}
                      >
                        紧凑
                      </button>
                      <button
                        type="button"
                        className={draft.subtitleSize === "medium" ? "is-active" : ""}
                        onClick={() => update("subtitleSize", "medium")}
                      >
                        标准
                      </button>
                      <button
                        type="button"
                        className={draft.subtitleSize === "large" ? "is-active" : ""}
                        onClick={() => update("subtitleSize", "large")}
                      >
                        大字幕
                      </button>
                    </div>
                  </fieldset>
                  <ToggleRow
                    label="窗口始终置顶"
                    description="保持同传控制台在其他窗口上方。"
                    checked={draft.alwaysOnTop}
                    onChange={(value) => update("alwaysOnTop", value)}
                  />
                </section>
              </>
            )}

            {section === "audio" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <Volume2 size={18} aria-hidden="true" />
                  <div>
                    <h3>系统回环音频</h3>
                    <p>只采集 Windows 默认播放设备，不使用麦克风。</p>
                  </div>
                </div>
                <div className="device-preview">
                  <MonitorUp size={20} aria-hidden="true" />
                  <div>
                    <strong>默认播放设备</strong>
                    <span>开始同传时由应用重新检测</span>
                  </div>
                  <span className="device-preview__state">系统控制</span>
                </div>
                <p className="settings-inline-note">更改 Windows 输出设备后，请停止并重新开始同传。</p>
              </section>
            )}

            {section === "services" && (
              <section className="settings-section settings-section--services">
                <div className="settings-section__heading">
                  <Settings2 size={18} aria-hidden="true" />
                  <div>
                    <h3>模型服务</h3>
                    <p>分别配置语音识别与译文生成服务。</p>
                  </div>
                </div>

                <div className="service-tabs" role="tablist" aria-label="模型服务类型">
                  <button
                    id="translation-service-tab"
                    type="button"
                    role="tab"
                    aria-selected={serviceView === "translation"}
                    aria-controls="translation-service-panel"
                    className={serviceView === "translation" ? "is-active" : ""}
                    onClick={() => setServiceView("translation")}
                  >
                    <Server size={15} aria-hidden="true" />
                    翻译模型
                  </button>
                  <button
                    id="recognition-service-tab"
                    type="button"
                    role="tab"
                    aria-selected={serviceView === "recognition"}
                    aria-controls="recognition-service-panel"
                    className={serviceView === "recognition" ? "is-active" : ""}
                    onClick={() => setServiceView("recognition")}
                  >
                    <Radio size={15} aria-hidden="true" />
                    语音识别
                  </button>
                </div>

                {serviceView === "recognition" && (
                  <div
                    id="recognition-service-panel"
                    className="recognition-editor"
                    role="tabpanel"
                    aria-labelledby="recognition-service-tab"
                  >
                    <div className="service-panel-heading">
                      <div className="service-mark" aria-hidden="true">D</div>
                      <div>
                        <strong>DashScope 实时语音识别</strong>
                        <span>支持自定义兼容端点与 Qwen ASR 模型名称</span>
                      </div>
                    </div>
                    <label className="field-group">
                      <span className="field-label">WebSocket 地址</span>
                      <input
                        value={draft.recognition.baseUrl}
                        onChange={(event) => updateRecognition("baseUrl", event.target.value)}
                        inputMode="url"
                        spellCheck={false}
                      />
                      {fieldErrors["recognition.baseUrl"] && (
                        <span className="field-error">{fieldErrors["recognition.baseUrl"]}</span>
                      )}
                    </label>
                    <label className="field-group">
                      <span className="field-label">识别模型</span>
                      <input
                        value={draft.recognition.model}
                        onChange={(event) => updateRecognition("model", event.target.value)}
                        placeholder="例如 qwen-audio-3.0-asr-flash-streaming"
                        spellCheck={false}
                      />
                      {fieldErrors["recognition.model"] && (
                        <span className="field-error">{fieldErrors["recognition.model"]}</span>
                      )}
                    </label>
                    <SecretField
                      label="DashScope API Key"
                      status={recognitionStatus}
                      value={draft.recognition.apiKey}
                      onChange={(value) => updateRecognition("apiKey", value)}
                      clearRequested={Boolean(draft.recognition.clearApiKey)}
                      onClearChange={(clear) => updateRecognition("clearApiKey", clear)}
                      canClearStored={recognitionTargetChanged && settings.recognition.apiKeyStatus !== "missing"}
                    />
                  </div>
                )}

                {serviceView === "translation" && (
                  <div
                    id="translation-service-panel"
                    className="provider-workspace"
                    role="tabpanel"
                    aria-labelledby="translation-service-tab"
                  >
                    <aside className="provider-list" aria-label="翻译服务商">
                      <div className="provider-list__header">
                        <div>
                          <strong>服务商</strong>
                          <span>{draft.translationProviders.length} 个配置</span>
                        </div>
                        <button
                          className="icon-button icon-button--compact"
                          type="button"
                          onClick={addProvider}
                          aria-label="添加翻译服务商"
                          title="添加服务商"
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                      <div className="provider-list__items" role="listbox" aria-label="选择服务商">
                        {draft.translationProviders.map((provider) => {
                          const active = provider.id === draft.activeTranslationProviderId;
                          return (
                            <button
                              key={provider.id}
                              className={`provider-list__item ${provider.id === selectedProviderId ? "is-selected" : ""}`}
                              type="button"
                              role="option"
                              aria-selected={provider.id === selectedProviderId}
                              aria-current={active ? "true" : undefined}
                              onClick={() => setSelectedProviderId(provider.id)}
                            >
                              <span className={`provider-logo provider-logo--${provider.protocol}`} aria-hidden="true">
                                {provider.protocol === "gemini" ? "G" : "AI"}
                              </span>
                              <span className="provider-list__copy">
                                <strong title={provider.name}>{provider.name || "未命名服务商"}</strong>
                                <small>{provider.protocol === "gemini" ? "Gemini API" : "OpenAI 兼容"}</small>
                              </span>
                              {active && (
                                <span className="provider-active-mark" title="当前使用">
                                  <Star size={13} fill="currentColor" aria-hidden="true" />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {fieldErrors.translationProviders && (
                        <span className="field-error provider-list__error">{fieldErrors.translationProviders}</span>
                      )}
                    </aside>

                    <div className="provider-detail">
                      {selectedProvider ? (
                        <>
                          <header className="provider-detail__header">
                            <div>
                              <strong>{selectedProvider.name || "未命名服务商"}</strong>
                              <span>{selectedProvider.models.length} 个模型</span>
                            </div>
                            <div className="provider-detail__actions">
                              <button
                                className={`button button--secondary button--compact ${
                                  selectedProvider.id === draft.activeTranslationProviderId ? "is-active" : ""
                                }`}
                                type="button"
                                disabled={selectedProvider.id === draft.activeTranslationProviderId}
                                onClick={() => update("activeTranslationProviderId", selectedProvider.id)}
                              >
                                <Star size={14} aria-hidden="true" />
                                {selectedProvider.id === draft.activeTranslationProviderId ? "当前使用" : "设为当前"}
                              </button>
                              <button
                                className="icon-button icon-button--compact icon-button--danger"
                                type="button"
                                disabled={draft.translationProviders.length <= 1 || providerBusy !== null}
                                onClick={() => deleteProvider(selectedProvider)}
                                aria-label={`删除服务商 ${selectedProvider.name}`}
                                title={draft.translationProviders.length <= 1 ? "至少保留一个服务商" : "删除服务商"}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </header>

                          <div className="provider-fields">
                            <div className="field-grid">
                              <label className="field-group">
                                <span className="field-label">显示名称</span>
                                <input
                                  value={selectedProvider.name}
                                  onChange={(event) => updateProvider(selectedProvider.id, { name: event.target.value })}
                                  placeholder="例如 OpenAI、DeepSeek 中转"
                                />
                                {fieldErrors[`provider.${selectedProvider.id}.name`] && (
                                  <span className="field-error">{fieldErrors[`provider.${selectedProvider.id}.name`]}</span>
                                )}
                              </label>
                              <label className="field-group">
                                <span className="field-label">接口协议</span>
                                <select
                                  value={selectedProvider.protocol}
                                  onChange={(event) =>
                                    changeProviderProtocol(selectedProvider, event.target.value as TranslationProtocol)
                                  }
                                >
                                  <option value="gemini">Gemini Developer API</option>
                                  <option value="openai">OpenAI 兼容</option>
                                </select>
                              </label>
                            </div>
                            <label className="field-group">
                              <span className="field-label">API 地址</span>
                              <input
                                value={selectedProvider.baseUrl}
                                onChange={(event) => updateProvider(selectedProvider.id, { baseUrl: event.target.value })}
                                inputMode="url"
                                placeholder={defaultProviderEndpoint[selectedProvider.protocol]}
                                spellCheck={false}
                              />
                              {fieldErrors[`provider.${selectedProvider.id}.baseUrl`] && (
                                <span className="field-error">{fieldErrors[`provider.${selectedProvider.id}.baseUrl`]}</span>
                              )}
                            </label>
                            <SecretField
                              label="API Key"
                              status={selectedProviderStatus}
                              value={selectedProvider.apiKey}
                              onChange={(value) => updateProvider(selectedProvider.id, { apiKey: value })}
                              clearRequested={Boolean(selectedProvider.clearApiKey)}
                              onClearChange={(clear) => updateProvider(selectedProvider.id, { clearApiKey: clear })}
                              canClearStored={selectedProviderTargetChanged && selectedPersistedProvider?.apiKeyStatus !== "missing"}
                            />
                          </div>

                          <section className="model-editor" aria-labelledby="provider-models-title">
                            <header className="model-editor__header">
                              <div>
                                <strong id="provider-models-title">模型</strong>
                                <span>选择同传使用的模型，或手动添加模型 ID</span>
                              </div>
                              <button
                                className="button button--secondary button--compact"
                                type="button"
                                disabled={providerBusy !== null}
                                onClick={() => void fetchModels(selectedProvider)}
                              >
                                {providerBusy?.providerId === selectedProvider.id && providerBusy.action === "models" ? (
                                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                                ) : (
                                  <RefreshCw size={14} aria-hidden="true" />
                                )}
                                获取列表
                              </button>
                            </header>
                            <div className="model-add-row">
                              <input
                                value={newModel}
                                onChange={(event) => setNewModel(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  addModel();
                                }}
                                aria-label="新模型 ID"
                                placeholder="输入模型 ID"
                                spellCheck={false}
                              />
                              <button
                                className="icon-button"
                                type="button"
                                disabled={!newModel.trim()}
                                onClick={addModel}
                                aria-label="添加模型"
                                title="添加模型"
                              >
                                <Plus size={16} />
                              </button>
                            </div>
                            {fieldErrors[`provider.${selectedProvider.id}.selectedModel`] && (
                              <span className="field-error">{fieldErrors[`provider.${selectedProvider.id}.selectedModel`]}</span>
                            )}
                            {selectedProvider.models.length ? (
                              <div className="model-list" role="radiogroup" aria-label="翻译模型">
                                {selectedProvider.models.map((model) => (
                                  <div className="model-list__item" key={model}>
                                    <label>
                                      <input
                                        type="radio"
                                        name={`model-${selectedProvider.id}`}
                                        checked={selectedProvider.selectedModel === model}
                                        onChange={() => updateProvider(selectedProvider.id, { selectedModel: model })}
                                      />
                                      <span title={model}>{model}</span>
                                    </label>
                                    <button
                                      className="icon-button icon-button--quiet icon-button--mini"
                                      type="button"
                                      onClick={() => deleteModel(model)}
                                      aria-label={`删除模型 ${model}`}
                                      title="删除模型"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="model-list-empty">尚未添加模型</div>
                            )}
                          </section>

                          <div className="provider-test-row">
                            <button
                              className="button button--secondary button--compact"
                              type="button"
                              disabled={providerBusy !== null}
                              onClick={() => void testConnection(selectedProvider)}
                            >
                              {providerBusy?.providerId === selectedProvider.id && providerBusy.action === "connection" ? (
                                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                              ) : (
                                <CheckCircle2 size={14} aria-hidden="true" />
                              )}
                              测试连接
                            </button>
                            {providerNotice?.providerId === selectedProvider.id && (
                              <span
                                className={`provider-notice provider-notice--${providerNotice.tone}`}
                                role={providerNotice.tone === "error" ? "alert" : "status"}
                              >
                                {providerNotice.tone === "error" ? (
                                  <CircleAlert size={14} aria-hidden="true" />
                                ) : (
                                  <CheckCircle2 size={14} aria-hidden="true" />
                                )}
                                {providerNotice.message}
                              </span>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="provider-detail-empty">
                          <Server size={20} aria-hidden="true" />
                          <span>选择或添加一个翻译服务商</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {section === "privacy" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <div>
                    <h3>隐私与安全</h3>
                    <p>音频不会保存在本地；默认仅在内存中保留最近字幕。</p>
                  </div>
                </div>
                <div className="security-note">
                  <Check size={16} aria-hidden="true" />
                  <span>字幕仅保留在当前会话内存中；密钥由应用后端管理，界面不会回显。</span>
                </div>
              </section>
            )}
          </div>
        </div>

        <footer className="settings-dialog__footer">
          <span className="settings-save-state" aria-live="polite">
            {saveError ?? (dirty ? "有未保存的更改" : "设置已保存")}
          </span>
          <div className="settings-actions">
            <button className="button button--secondary" type="button" onClick={requestClose}>
              取消
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={save}
              disabled={saving || providerBusy !== null}
            >
              {saving ? "正在保存" : providerBusy ? "正在检测" : "保存设置"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
