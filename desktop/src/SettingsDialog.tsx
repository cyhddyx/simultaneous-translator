import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
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
} from "lucide-react";
import { translatorApi } from "./tauri";
import { AudioDeviceTestWizard } from "./AudioDeviceTestWizard";
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

type SettingsSection = "general" | "audio" | "shortcuts" | "services" | "privacy";
interface SettingsDialogProps {
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
  return value.replace(/\bSuper\b/g, "Win");
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
            <option value="loopback">指定播放设备（回环采集）</option>
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
  settings,
  sessionActive,
  onClose,
  onSave,
  onValidate,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>("general");
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const validation = await onValidate(draft);
      if (!validation.valid) {
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

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2 id="settings-title">设置</h2>
          <button
            className="icon-button"
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label="关闭设置"
            title="关闭设置"
          >
            <X size={19} />
          </button>
        </header>
        <div className="settings-dialog__body">
          <nav className="settings-nav" aria-label="设置分区">
            {sectionLabels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav__item ${section === id ? "is-active" : ""}`}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setSection(id);
                  setRecordingShortcut(null);
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {section === "general" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <SlidersHorizontal size={18} />
                  <h3>实时同传</h3>
                </div>
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
            {section === "shortcuts" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <Keyboard size={18} />
                  <div>
                    <h3>全局快捷键</h3>
                    <p>点击按键框后录制组合键；组合键需要包含 Ctrl、Alt 或 Win。</p>
                  </div>
                </div>
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
                                [field]: "请至少按住 Ctrl、Alt 或 Win。",
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
            {section === "audio" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <Volume2 size={18} />
                  <h3>音频通道</h3>
                </div>
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
                    <span>依次检查播放音、麦克风输入和播放设备回环。</span>
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
            {section === "services" && (
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
                <SecretField
                  label="DashScope API Key"
                  status={realtimeStatus}
                  value={draft.realtime.apiKey}
                  onChange={(apiKey) => updateRealtime({ apiKey })}
                  clearRequested={Boolean(draft.realtime.clearApiKey)}
                  onClearChange={(clearApiKey) =>
                    updateRealtime({ clearApiKey })
                  }
                  canClearStored={
                    realtimeTargetChanged &&
                    settings.realtime.apiKeyStatus === "secure_store"
                  }
                />
                {fieldErrors["realtime.model"] && (
                  <p className="field-error">{fieldErrors["realtime.model"]}</p>
                )}
              </section>
            )}
            {section === "privacy" && (
              <section className="settings-section">
                <div className="settings-section__heading">
                  <ShieldCheck size={18} />
                  <h3>隐私与安全</h3>
                </div>
                <div className="security-note">
                  <Check size={16} />
                  <span>
                    音频发送至配置的同传接口，不保存在本地；字幕仅保留在当前会话内存中。密钥保存在
                    Windows 凭据管理器中。
                  </span>
                </div>
              </section>
            )}
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
            role={saveError ? "alert" : "status"}
          >
            {saveError ?? (dirty ? "有未保存的更改" : "设置已保存")}
          </span>
          <div className="settings-actions">
            <button
              className="button button--secondary"
              type="button"
              disabled={saving}
              onClick={requestClose}
            >
              取消
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "正在保存" : "保存设置"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
