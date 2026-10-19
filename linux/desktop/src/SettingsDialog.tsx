import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Download,
  Eye,
  EyeOff,
  Headphones,
  Keyboard,
  KeyRound,
  Mic,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Volume2,
  X,
} from "./PixelIcons";
import { translatorApi } from "./tauri";
import { ApiKeyHelpLink } from "./ApiKeyHelpLink";
import { AudioDeviceTestWizard } from "./AudioDeviceTestWizard";
import { AppUpdateSection } from "./AppUpdate";
import type { AppUpdateController } from "./useAppUpdate";
import { VirtualMicrophoneSection } from "./VirtualMicrophoneSection";
import { findTranslationLanguage, outputLanguageError, outputLanguages } from "./translationLanguages";
import {
  DEFAULT_SETTINGS,
  type AudioChannelSettings,
  type AudioDevice,
  type AudioDeviceList,
  type ChannelId,
  type PublicSettings,
  type SecretStatus,
  type ShortcutSettings,
  type SettingsDraft,
  type SettingsValidation,
} from "./types";

type SettingsSection = "general" | "audio" | "shortcuts" | "services" | "privacy" | "updates";
interface SettingsDialogProps {
  update: AppUpdateController;
  initialSection?: SettingsSection;
  initialSetup?: boolean;
  settings: PublicSettings;
  sessionActive: boolean;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => Promise<void>;
  onValidate: (draft: SettingsDraft) => Promise<SettingsValidation>;
}
const CHANNEL_META: Array<{
  id: ChannelId;
  title: string;
  description: string;
}> = [
  { id: "listen", title: "收听通道（对方 → 我）", description: "系统声音" },
  { id: "speak", title: "发言通道（我 → 对方）", description: "麦克风" },
];
const sectionLabels: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof SlidersHorizontal;
}> = [
  { id: "general", label: "常规", icon: SlidersHorizontal },
  { id: "audio", label: "音频", icon: Volume2 },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
  { id: "services", label: "同传模型", icon: Radio },
  { id: "privacy", label: "隐私与安全", icon: ShieldCheck },
  { id: "updates", label: "软件更新", icon: Download },
];
const SHORTCUT_ACTIONS: Array<{
  id: keyof ShortcutSettings;
  label: string;
}> = [
  { id: "startOrStopSession", label: "开始 / 停止同传" },
  { id: "toggleSpeakMute", label: "静音 / 取消静音发言" },
  { id: "toggleSubtitleWindow", label: "显示 / 隐藏字幕悬浮窗" },
  { id: "toggleListenChannel", label: "开启 / 关闭收听通道" },
  { id: "toggleSpeakChannel", label: "开启 / 关闭发言通道" },
];

function shortcutKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad(?:[0-9]|Add|Decimal|Divide|Enter|Equal|Multiply|Subtract)$/.test(code))
    return code;
  const punctuation = new Set([
    "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal",
    "Minus", "Period", "Quote", "Semicolon", "Slash",
  ]);
  if (punctuation.has(code)) return code;
  const supported = new Set([
    "Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "End", "Home",
    "Insert", "PageDown", "PageUp", "PrintScreen", "ScrollLock", "ArrowDown",
    "ArrowLeft", "ArrowRight", "ArrowUp",
  ]);
  return supported.has(code) ? code : null;
}

function displayShortcut(value: string): string {
  // Linux calls the Meta key "Super"; settings files copied from the previous
  // desktop release may still spell it "Win".
  return value.replace(/\b(?:win|windows)\b/gi, "Super");
}

// Preserve legacy fields only for settings-file compatibility; no legacy model is used.
const toDraft = (settings: PublicSettings): SettingsDraft => ({
  ...settings,
  sourceLanguage: "自动检测",
  engine: "realtime",
  recognition: {
    protocol: settings.recognition.protocol,
    baseUrl: settings.recognition.baseUrl,
    model: settings.recognition.model,
  },
  translationProviders: settings.translationProviders.map(
    ({ apiKeyStatus: _status, ...provider }) => ({
      ...provider,
      models: [...provider.models],
    }),
  ),
  realtime: {
    protocol: "livetranslate",
    baseUrl: settings.realtime.baseUrl,
    model: DEFAULT_SETTINGS.realtime.model,
    voice: settings.realtime.enableVoiceClone ? "default" : "",
    enableVoiceClone: settings.realtime.enableVoiceClone,
    voiceCloneFrequency: "once",
  },
  audio: {
    listen: { ...settings.audio.listen },
    speak: { ...settings.audio.speak },
  },
  shortcuts: { ...settings.shortcuts },
});
function fingerprint(draft: SettingsDraft) {
  return JSON.stringify({
    ...draft,
    realtime: {
      ...draft.realtime,
      apiKey: draft.realtime.apiKey?.trim() || undefined,
      clearApiKey: draft.realtime.clearApiKey || undefined,
    },
  });
}
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error
    ? error.message
    : typeof error === "string" && error.trim()
      ? error
      : fallback;
}
function endpointForComparison(value: string) {
  try {
    return new URL(value.trim()).toString().replace(/\/+$/, "");
  } catch {
    return value.trim();
  }
}

function SecretField({
  label,
  status,
  value,
  onChange,
  clearRequested,
  onClearChange,
  canClearStored = false,
  help,
}: {
  label: string;
  status: SecretStatus;
  value: string | undefined;
  onChange: (value: string) => void;
  clearRequested: boolean;
  onClearChange: (clear: boolean) => void;
  canClearStored?: boolean;
  help?: ReactNode;
}) {
  const inputId = useId();
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
            ? "密钥环暂不可用"
            : "尚未配置";
  const statusTone = clearRequested || replacementPending ? "pending" : status;

  return (
    <div className="field-group">
      <span className="field-label">
        <label htmlFor={inputId}>{label}</label>
        {help}
        <span className={`secret-source secret-source--${statusTone}`}>
          <KeyRound size={12} aria-hidden="true" />
          {statusLabel}
        </span>
      </span>
      <span className="secret-input-wrap">
        <input
          id={inputId}
          value={environmentOwned ? "" : (value ?? "")}
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
                ? "保存时将从系统密钥环删除"
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
                aria-label={
                  clearRequested ? "保留已保存密钥" : "保存时清除密钥"
                }
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
              title={
                value
                  ? visible
                    ? "隐藏新密钥"
                    : "显示新密钥"
                  : "已保存的密钥不会回显"
              }
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </>
        )}
      </span>
    </div>
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

function VoiceModeControl({ id, value, onChange }: {
  id: ChannelId;
  value: AudioChannelSettings["voiceMode"];
  onChange: (value: AudioChannelSettings["voiceMode"]) => void;
}) {
  const label = id === "speak" ? "发言音色" : "收听音色";
  return (
    <fieldset className="segmented-field">
      <legend>{label}</legend>
      <div className="segmented-control" role="group" aria-label={label}>
        {(["clone", "system"] as const).map((mode) => (
          <button key={mode} type="button" className={value === mode ? "is-active" : ""}
            aria-pressed={value === mode} onClick={() => onChange(mode)}>
            {mode === "system" ? "系统音色" : id === "speak" ? "本人音色" : "对方音色"}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function OutputLanguageField({ id, channel, onChange }: {
  id: ChannelId;
  channel: AudioChannelSettings;
  onChange: (patch: Partial<AudioChannelSettings>) => void;
}) {
  const fieldId = useId();
  const language = findTranslationLanguage(channel.targetLanguage);
  const error = outputLanguageError(channel);
  const value = language?.code ?? channel.targetLanguage;
  const options = outputLanguages(channel.playAudio);

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={fieldId}>
        {id === "listen" ? "我收到的译文语言" : "对方收到的译文语言"}
      </label>
      <select id={fieldId} value={value} aria-invalid={Boolean(error)}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        onChange={(event) => {
          const selected = findTranslationLanguage(event.target.value);
          if (selected) onChange({ targetLanguage: selected.label });
        }}>
        {error && <option value={value} disabled>
          {language ? `${language.label}（仅文字，不能播报）` : `${value || "未选择"}（请选择有效语言）`}
        </option>}
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}{!option.audio ? "（仅文字）" : ""}
          </option>
        ))}
      </select>
      {error && <>
        <span id={`${fieldId}-error`} className="field-error" role="alert">{error}</span>
        {language && !language.audio && channel.playAudio && (
          <button type="button" className="button button--secondary"
            onClick={() => onChange({ playAudio: false })}>改为文字输出</button>
        )}
      </>}
    </div>
  );
}

function AudioChannelCard({
  meta,
  channel,
  devices,
  busy,
  error,
  onReload,
  onChange,
}: {
  meta: { id: ChannelId; title: string; description: string };
  channel: AudioChannelSettings;
  devices: AudioDeviceList | null;
  busy: boolean;
  error: string | null;
  onReload: () => void;
  onChange: (patch: Partial<AudioChannelSettings>) => void;
}) {
  const Icon = meta.id === "listen" ? Headphones : Mic;
  const isLoopback = channel.input === "loopback";
  const options: AudioDevice[] = isLoopback
    ? (devices?.speakers ?? [])
    : (devices?.microphones ?? []);
  const defaultLabel = isLoopback
    ? "默认播放设备（跟随系统）"
    : "默认麦克风（跟随系统）";

  return (
    <article className="audio-channel">
      <header className="audio-channel__heading">
        <Icon size={20} aria-hidden="true" />
        <div>
          <strong>{meta.title}</strong>
          <span>{meta.description}</span>
        </div>
        <span className="audio-channel__state">
          {channel.enabled ? "已启用" : "已停用"}
        </span>
      </header>

      <ToggleRow
        label="启用该通道"
        description="关闭后不会采集音频，也不会调用模型。"
        checked={channel.enabled}
        onChange={(value) => onChange({ enabled: value })}
      />

      <div className="field-grid field-grid--output-languages">
        <label className="field-group">
          <span className="field-label">音频来源</span>
          <select
            value={channel.input}
            onChange={(event) => {
              const next = event.target.value as AudioChannelSettings["input"];
              // A speaker id is not a valid microphone id (and vice versa), so a
              // stale selection would silently fail to open at session start.
              onChange(
                next === channel.input
                  ? { input: next }
                  : { input: next, inputDevice: "" },
              );
            }}
          >
            <option value="system">系统声音（排除本软件）</option>
            <option value="loopback">指定播放设备（monitor 回环采集）</option>
            <option value="microphone">麦克风</option>
          </select>
        </label>
        {channel.input !== "system" && <label className="field-group">
          <span className="field-label">
            输入设备
            <button
              className="icon-button icon-button--compact"
              type="button"
              onClick={onReload}
              disabled={busy}
              aria-label="重新检测音频设备"
              title="重新检测音频设备"
            >
              <RefreshCw size={14} className={busy ? "spin" : undefined} />
            </button>
          </span>
          <select
            value={channel.inputDevice}
            onChange={(event) => onChange({ inputDevice: event.target.value })}
          >
            <option value="">{defaultLabel}</option>
            {options.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.isDefault ? "（系统默认）" : ""}
              </option>
            ))}
          </select>
        </label>}
        <OutputLanguageField id={meta.id} channel={channel} onChange={onChange} />
        {channel.playAudio && (
          <label className="field-group">
            <span className="field-label">译文播放设备</span>
            <select
              value={channel.outputDevice}
              onChange={(event) =>
                onChange({ outputDevice: event.target.value })
              }
            >
              <option value="">
                {devices?.speakers.find((device) => device.isDefault)?.name
                  ? `跟随系统：${devices.speakers.find((device) => device.isDefault)!.name}`
                  : "默认播放设备（跟随系统）"}
              </option>
              {(devices?.speakers ?? []).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <span className="field-error">{error}</span>}

      <fieldset className="segmented-field">
        <legend>输出模式</legend>
        <div
          className="segmented-control"
          role="group"
          aria-label={meta.title + "输出模式"}
        >
          <button
            type="button"
            aria-pressed={!channel.playAudio}
            className={!channel.playAudio ? "is-active" : ""}
            onClick={() => onChange({ playAudio: false })}
          >
            语音转文字
          </button>
          <button
            type="button"
            aria-pressed={channel.playAudio}
            className={channel.playAudio ? "is-active" : ""}
            onClick={() => onChange({ playAudio: true })}
          >
            语音转语音
          </button>
        </div>
      </fieldset>
      {channel.playAudio && <VoiceModeControl id={meta.id} value={channel.voiceMode}
        onChange={(voiceMode) => onChange({ voiceMode })} />}
    </article>
  );
}

export function SettingsDialog({
  update,
  initialSection = "general",
  initialSetup = false,
  settings,
  sessionActive,
  onClose,
  onSave,
  onValidate,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [setupStep, setSetupStep] = useState<0 | 1 | null>(initialSetup ? 0 : null);
  const inSetup = setupStep !== null;
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [recordingShortcut, setRecordingShortcut] = useState<keyof ShortcutSettings | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [audioTestOpen, setAudioTestOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const savingRef = useRef(false);
  const deviceRequestRef = useRef(0);
  const dirty = useMemo(
    () => fingerprint(draft) !== fingerprint(toDraft(settings)),
    [draft, settings],
  );
  const loadDevices = useCallback(async () => {
    const request = ++deviceRequestRef.current;
    setDevicesBusy(true);
    setDevicesError(null);
    try {
      const result = await translatorApi.listAudioDevices();
      if (request === deviceRequestRef.current) setDevices(result);
      return result;
    } catch (error) {
      if (request === deviceRequestRef.current)
        setDevicesError(errorMessage(error, "无法读取音频设备"));
    } finally {
      if (request === deviceRequestRef.current) setDevicesBusy(false);
    }
  }, []);
  useEffect(() => {
    void loadDevices();
    return () => {
      deviceRequestRef.current++;
    };
  }, [loadDevices]);
  const updateAudioChannel = (
    id: ChannelId,
    patch: Partial<AudioChannelSettings>,
  ) => {
    setDraft((current) => ({
      ...current,
      ...(id === "listen" && patch.targetLanguage
        ? { targetLanguage: patch.targetLanguage }
        : {}),
      audio: { ...current.audio, [id]: { ...current.audio[id], ...patch } },
    }));
    setFieldErrors({});
  };
  const updateRealtime = (patch: Partial<SettingsDraft["realtime"]>) => {
    setDraft((current) => ({
      ...current,
      realtime: { ...current.realtime, ...patch },
    }));
    setFieldErrors({});
  };
  const realtimeTargetChanged =
    endpointForComparison(draft.realtime.baseUrl) !==
    endpointForComparison(settings.realtime.baseUrl);
  const realtimeStatus: SecretStatus = realtimeTargetChanged
    ? "missing"
    : settings.realtime.apiKeyStatus;
  useEffect(() => {
    if (setupStep !== 1) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>(".secret-input-wrap input")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [setupStep]);
  const requestClose = useCallback(() => {
    if (savingRef.current) return;
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
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      if (inSetup && (draft.realtime.clearApiKey ||
        (!draft.realtime.apiKey?.trim() && realtimeStatus !== "secure_store" && realtimeStatus !== "environment"))) {
        setFieldErrors({ "realtime.apiKey": "请先粘贴从控制台复制的 API Key。" });
        setSetupStep(1);
        return;
      }
      const validation = await onValidate(draft);
      if (!validation.valid) {
        setSetupStep(null);
        setFieldErrors(validation.fieldErrors);
        const first = Object.keys(validation.fieldErrors)[0] ?? "";
        setSection(
          first.startsWith("shortcuts.")
            ? "shortcuts"
            : first.startsWith("realtime")
              ? "services"
              : first.startsWith("audio")
                ? "audio"
                : "general",
        );
        return;
      }
      await onSave(draft);
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error, "设置保存失败"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const enabledChannels = [draft.audio.listen, draft.audio.speak].filter(
    (channel) => channel.enabled,
  );
  const allText =
    enabledChannels.length > 0 &&
    enabledChannels.every((channel) => !channel.playAudio);
  const allAudio =
    enabledChannels.length > 0 &&
    enabledChannels.every((channel) => channel.playAudio);
  const setMode = (playAudio: boolean) => {
    setDraft((current) => ({
      ...current,
      audio: {
        listen: { ...current.audio.listen, playAudio },
        speak: { ...current.audio.speak, playAudio },
      },
    }));
    setFieldErrors({});
  };
  const conversationMode = draft.audio.listen.enabled && draft.audio.speak.enabled
    ? "both" : draft.audio.speak.enabled ? "speak" : "listen";

  const realtimeKeyField = (
    <>
      <SecretField
        label="API 密钥（API Key）"
        help={<ApiKeyHelpLink />}
        status={realtimeStatus}
        value={draft.realtime.apiKey}
        onChange={(apiKey) => updateRealtime({ apiKey })}
        clearRequested={Boolean(draft.realtime.clearApiKey)}
        onClearChange={(clearApiKey) => updateRealtime({ clearApiKey })}
        canClearStored={realtimeTargetChanged && settings.realtime.apiKeyStatus === "secure_store"}
      />
      {fieldErrors["realtime.apiKey"] && <p className="field-error" role="alert">{fieldErrors["realtime.apiKey"]}</p>}
    </>
  );

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className={`settings-dialog${inSetup ? " settings-dialog--setup" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2 id="settings-title">{inSetup ? "首次配置向导" : "设置"}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label={inSetup ? "关闭首次配置向导" : "关闭设置"}
            title={inSetup ? "关闭首次配置向导" : "关闭设置"}
          >
            <X size={19} />
          </button>
        </header>
        <div className="settings-dialog__body">
          {inSetup ? (
            <ol className="setup-steps" aria-label="配置步骤">
              {["获取密钥", "填写并保存"].map((label, index) => (
                <li key={label} aria-current={setupStep === index ? "step" : undefined}>
                  <span>{setupStep > index ? <Check size={14} /> : index + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          ) : <nav className="settings-nav" aria-label="设置分区">
            {sectionLabels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav__item ${section === id ? "is-active" : ""}`}
                data-section={id}
                aria-label={label}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(id);
                  setRecordingShortcut(null);
                }}
              >
                <Icon size={16} />
                <span className="settings-nav__label">{label}</span>
                {(id === "privacy" || id === "services" || id === "updates") && (
                  <span className="settings-nav__compact-label" aria-hidden="true">{id === "privacy" ? "隐私" : id === "services" ? "模型" : "更新"}</span>
                )}
              </button>
            ))}
          </nav>}
          <div className="settings-scroll-frame">
            <div
              key={inSetup ? `setup-${setupStep}` : section}
              className="settings-panel"
              data-section={section}
              tabIndex={0}
              aria-label={inSetup ? "首次配置内容" : `${sectionLabels.find((item) => item.id === section)?.label}设置内容`}
            >
              {inSetup && (
                <section className="settings-section setup-content">
                  <div className="settings-section__heading">
                    <KeyRound size={20} />
                    <div>
                      <h3>{setupStep === 0 ? "先获取你的 API Key" : "粘贴密钥，完成配置"}</h3>
                      <p>{setupStep === 0 ? "API Key 是使用翻译服务的凭证，只需配置一次。" : "将刚刚复制的完整密钥粘贴到下方，点击保存即可。"}</p>
                    </div>
                  </div>
                  {setupStep === 0 ? (
                    <>
                      <ol className="api-key-instructions">
                        <li><strong>打开密钥控制台</strong><p>点击下方“获取密钥”，注册或登录阿里云账号，按平台提示开通百炼服务。</p></li>
                        <li><strong>创建 API Key</strong><p>选择与翻译接口一致的地域和业务空间，在“API Key”页面点击“创建 API Key”。默认入口为华北 2（北京）。</p></li>
                        <li><strong>复制完整密钥</strong><p>点击密钥旁的复制按钮，然后回到本软件，进入下一步粘贴。</p></li>
                      </ol>
                      <div className="api-key-guide-links"><ApiKeyHelpLink /><ApiKeyHelpLink kind="guide" /></div>
                      <p className="api-key-note">翻译服务的用量与费用以平台说明为准。使用自定义接口时，请向对应服务商获取密钥。</p>
                    </>
                  ) : (
                    <>
                      {realtimeKeyField}
                      <p className="api-key-note">密钥会安全保存在系统密钥环（Secret Service，如 GNOME Keyring 或 KWallet）中。保存后，点击主界面的“开始同传”即可使用。</p>
                      <details className="setup-endpoint">
                        <summary>查看翻译接口地址</summary>
                        <p>{draft.realtime.baseUrl}</p>
                        <p>密钥需与此接口匹配。如需修改地址，可稍后前往“设置 → 同传模型”。</p>
                      </details>
                    </>
                  )}
                </section>
              )}
              {!inSetup && section === "general" && (
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <SlidersHorizontal size={18} />
                    <h3>实时同传</h3>
                  </div>
                  <p className="audio-routing-note">
                    Linux 提示：关闭主窗口会收起到系统托盘并继续同传；托盘依赖桌面提供 AppIndicator / StatusNotifier 支持，无托盘环境时关闭窗口即退出应用。
                  </p>
                  <fieldset className="segmented-field">
                    <legend>对话方向</legend>
                    <div className="segmented-control" role="group" aria-label="对话方向">
                      {(["both", "listen", "speak"] as const).map((mode) => (
                        <button key={mode} type="button" aria-pressed={conversationMode === mode}
                          className={conversationMode === mode ? "is-active" : ""}
                          onClick={() => setDraft((current) => ({ ...current, audio: {
                            listen: { ...current.audio.listen, enabled: mode !== "speak" },
                            speak: { ...current.audio.speak, enabled: mode !== "listen" },
                          } }))}>
                          {mode === "both" ? "双向对话" : mode === "listen" ? "只收听" : "只发言"}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="segmented-field">
                    <legend>输出模式</legend>
                    <div
                      className="segmented-control"
                      role="group"
                      aria-label="输出模式"
                    >
                      <button
                        type="button"
                        className={allText ? "is-active" : ""}
                        aria-pressed={allText}
                        onClick={() => setMode(false)}
                      >
                        语音转文字
                      </button>
                      <button
                        type="button"
                        className={allAudio ? "is-active" : ""}
                        aria-pressed={allAudio}
                        onClick={() => setMode(true)}
                      >
                        语音转语音
                      </button>
                    </div>
                  </fieldset>
                  <div className="field-grid voice-settings-grid">
                    {(["speak", "listen"] as const).map((id) => (
                      <VoiceModeControl key={id} id={id} value={draft.audio[id].voiceMode}
                        onChange={(voiceMode) => updateAudioChannel(id, { voiceMode })} />
                    ))}
                  </div>
                  <div className="field-grid field-grid--output-languages">
                    {(["listen", "speak"] as const).map((id) => (
                      <OutputLanguageField key={id} id={id} channel={draft.audio[id]}
                        onChange={(patch) => updateAudioChannel(id, patch)} />
                    ))}
                  </div>
                  <fieldset className="segmented-field">
                    <legend>字幕尺寸</legend>
                    <div
                      className="segmented-control"
                      role="group"
                      aria-label="字幕尺寸"
                    >
                      {(["small", "medium", "large"] as const).map(
                        (size, index) => (
                          <button
                            key={size}
                            type="button"
                            className={
                              draft.subtitleSize === size ? "is-active" : ""
                            }
                            aria-pressed={draft.subtitleSize === size}
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                subtitleSize: size,
                              }))
                            }
                          >
                            {["紧凑", "标准", "大字幕"][index]}
                          </button>
                        ),
                      )}
                    </div>
                  </fieldset>
                  <ToggleRow
                    label="窗口始终置顶"
                    description=""
                    checked={draft.alwaysOnTop}
                    onChange={(alwaysOnTop) =>
                      setDraft((current) => ({ ...current, alwaysOnTop }))
                    }
                  />
                </section>
              )}
              {!inSetup && section === "shortcuts" && (
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <Keyboard size={18} />
                    <div>
                      <h3>全局快捷键</h3>
                      <p>点击按键框后录制组合键；组合键需要包含 Ctrl、Alt 或 Super。</p>
                    </div>
                  </div>
                  <p className="audio-routing-note">
                    Linux 提示：X11 会话下全局快捷键可完整使用；Wayland 会话由合成器决定，通常无法注册全局快捷键。注册失败的组合键会在主界面提示，可改用托盘菜单执行同样的操作。
                  </p>
                  <div className="shortcut-list">
                    {SHORTCUT_ACTIONS.map(({ id, label }) => {
                      const field = `shortcuts.${id}`;
                      const recording = recordingShortcut === id;
                      return (
                        <div className="shortcut-row" key={id}>
                          <span className="shortcut-row__label">{label}</span>
                          <button
                            className={`shortcut-recorder${recording ? " is-recording" : ""}`}
                            type="button"
                            aria-label={`${label}快捷键`}
                            aria-pressed={recording}
                            title={recording ? "按 Esc 取消录制" : "点击录制快捷键"}
                            onClick={() => {
                              setRecordingShortcut(id);
                              setFieldErrors({});
                            }}
                            onKeyDown={(event) => {
                              if (!recording) return;
                              event.preventDefault();
                              event.stopPropagation();
                              if (event.code === "Escape") {
                                setRecordingShortcut(null);
                                return;
                              }
                              const key = shortcutKeyFromCode(event.code);
                              if (!key) return;
                              const modifiers = [
                                event.ctrlKey ? "Ctrl" : "",
                                event.altKey ? "Alt" : "",
                                event.shiftKey ? "Shift" : "",
                                event.metaKey ? "Super" : "",
                              ].filter(Boolean);
                              if (!modifiers.some((modifier) => modifier !== "Shift")) {
                                setFieldErrors({
                                  [field]: "请至少按住 Ctrl、Alt 或 Super。",
                                });
                                return;
                              }
                              setDraft((current) => ({
                                ...current,
                                shortcuts: {
                                  ...current.shortcuts,
                                  [id]: [...modifiers, key].join("+"),
                                },
                              }));
                              setFieldErrors({});
                              setRecordingShortcut(null);
                            }}
                          >
                            {recording ? "请按组合键…" : displayShortcut(draft.shortcuts[id])}
                          </button>
                          {fieldErrors[field] && (
                            <span className="field-error" role="alert">
                              {fieldErrors[field]}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button
                    className="button button--secondary shortcut-reset"
                    type="button"
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
                      }));
                      setRecordingShortcut(null);
                      setFieldErrors({});
                    }}
                  >
                    <RotateCcw size={15} />
                    恢复默认快捷键
                  </button>
                </section>
              )}
              {!inSetup && section === "audio" && (
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <Volume2 size={18} />
                    <h3>音频通道</h3>
                  </div>
                  <p className="audio-routing-note">
                    Linux 版使用 PulseAudio 虚拟混音 sink 采集“系统声音（排除本软件）”：同传期间自动把默认播放设备切到 <code>translator_mix</code> 混音池，本软件译文始终直出你选择的播放设备，不会被再次采集；停止后恢复原默认设备，异常退出留下的 <code>translator_*</code> 模块会在下次启动时自动清理。“指定播放设备（monitor 回环采集）”则直接采集该设备的监视源，不排除本软件输出，且不能与任一译文输出使用同一设备。
                  </p>
                  <VirtualMicrophoneSection
                    audio={draft.audio}
                    devices={devices}
                    devicesBusy={devicesBusy}
                    devicesError={devicesError}
                    onReload={loadDevices}
                    onChange={(audio) => {
                      setDraft((current) => ({ ...current, audio }));
                      setFieldErrors({});
                    }}
                  />
                  <div className="audio-test-launch">
                    <div>
                      <strong>设备测试向导</strong>
                      <span>依次检查播放音、麦克风输入和播放设备的 monitor 回环。</span>
                    </div>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => setAudioTestOpen(true)}
                      disabled={saving}
                    >
                      <Volume2 size={15} />
                      打开向导
                    </button>
                  </div>
                  {CHANNEL_META.map((meta) => (
                    <AudioChannelCard
                      key={meta.id}
                      meta={meta}
                      channel={draft.audio[meta.id]}
                      devices={devices}
                      busy={devicesBusy}
                      error={devicesError}
                      onReload={() => void loadDevices()}
                      onChange={(patch) => updateAudioChannel(meta.id, patch)}
                    />
                  ))}
                  {fieldErrors.audio && (
                    <p className="field-error" role="alert">
                      {fieldErrors.audio}
                    </p>
                  )}
                </section>
              )}
              {!inSetup && section === "services" && (
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <Radio size={18} />
                    <h3>实时同传模型</h3>
                  </div>
                  <label className="field-group">
                    <span className="field-label">模型</span>
                    <input
                      value={draft.realtime.model}
                      readOnly
                      spellCheck={false}
                    />
                  </label>
                  <label className="field-group">
                    <span className="field-label">WebSocket 接口地址</span>
                    <input
                      value={draft.realtime.baseUrl}
                      onChange={(event) =>
                        updateRealtime({ baseUrl: event.target.value })
                      }
                      spellCheck={false}
                    />
                    {fieldErrors["realtime.baseUrl"] && (
                      <span className="field-error">
                        {fieldErrors["realtime.baseUrl"]}
                      </span>
                    )}
                  </label>
                  {realtimeKeyField}
                  <div className="api-key-guide-links">
                    <button type="button" className="setup-guide-button" onClick={() => setSetupStep(0)}>首次配置向导</button>
                    <ApiKeyHelpLink kind="guide" />
                  </div>
                  <p className="api-key-note">注册或登录阿里云百炼，选择对应地域和业务空间，创建 API Key 并复制到上方。自定义接口请使用对应服务商的密钥。</p>
                  {fieldErrors["realtime.model"] && (
                    <p className="field-error">{fieldErrors["realtime.model"]}</p>
                  )}
                </section>
              )}
              {!inSetup && section === "privacy" && (
                <section className="settings-section">
                  <div className="settings-section__heading">
                    <ShieldCheck size={18} />
                    <h3>隐私与安全</h3>
                  </div>
                  <div className="security-note">
                    <Check size={16} />
                    <span>
                      音频发送至配置的同传接口，不保存在本地；字幕仅保留在当前会话内存中。密钥保存在
                      系统密钥环（Secret Service）中。
                    </span>
                  </div>
                </section>
              )}
              {!inSetup && section === "updates" && <AppUpdateSection update={update} sessionActive={sessionActive} onInstall={() => void update.install()} />}
            </div>
          </div>
        </div>
        {audioTestOpen && (
          <AudioDeviceTestWizard
            devices={devices}
            busy={devicesBusy}
            error={devicesError}
            sessionActive={sessionActive}
            onReload={() => void loadDevices()}
            onClose={() => setAudioTestOpen(false)}
          />
        )}
        <footer className="settings-dialog__footer">
          <span
            className="settings-save-state"
            data-state={saveError ? "error" : dirty ? "dirty" : "saved"}
            role={saveError ? "alert" : "status"}
          >
            {saveError ?? (inSetup ? `第 ${setupStep + 1} 步 / 共 2 步` : dirty ? "有未保存的更改" : "设置已保存")}
          </span>
          <div className="settings-actions">
            {setupStep === 1 && (
              <button className="button button--secondary" type="button" disabled={saving} onClick={() => setSetupStep(0)}>上一步</button>
            )}
            <button
              className="button button--secondary"
              type="button"
              disabled={saving}
              onClick={requestClose}
            >
              {inSetup ? "稍后配置" : "取消"}
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={saving}
              onClick={() => setupStep === 0 ? setSetupStep(1) : void save()}
            >
              {saving ? "正在保存" : setupStep === 0 ? "下一步：填写密钥" : setupStep === 1 ? "保存并完成" : "保存设置"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
