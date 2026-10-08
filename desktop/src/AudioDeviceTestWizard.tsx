import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  LoaderCircle,
  Mic,
  Radio,
  RefreshCw,
  RotateCcw,
  Volume2,
  X,
} from "lucide-react";
import { translatorApi } from "./tauri";
import {
  audioTestDeviceKind,
  audioTestLabel,
  classifyAudioTestResult,
  createAudioTestRequestGate,
  devicesForAudioTest,
  type AudioTestKind,
  type AudioTestResult,
} from "./audioDeviceTest";
import type { AudioDeviceList } from "./types";

interface AudioDeviceTestWizardProps {
  devices: AudioDeviceList | null;
  busy: boolean;
  error: string | null;
  sessionActive: boolean;
  onReload: () => void;
  onClose: () => void;
}

const TESTS: Array<{
  kind: AudioTestKind;
  description: string;
  icon: typeof Volume2;
}> = [
  {
    kind: "playback",
    description: "播放一段短测试音，确认扬声器或耳机可以正常出声。",
    icon: Volume2,
  },
  {
    kind: "microphone",
    description: "录制几秒钟的本地音量数据，不保存录音，只检测是否有声音。",
    icon: Mic,
  },
  {
    kind: "loopback",
    description: "播放测试音并读取对应播放设备的回环信号，确认回环采集链路。",
    icon: Radio,
  },
];

function defaultDeviceId(devices: AudioDeviceList | null, kind: AudioTestKind): string {
  const options = devicesForAudioTest(devices, kind);
  return options.find((device) => device.isDefault)?.id ?? options[0]?.id ?? "";
}

function deviceMissingText(kind: AudioTestKind): string {
  return audioTestDeviceKind(kind) === "microphone"
    ? "未找到可用的麦克风"
    : "未找到可用的播放设备";
}

function resultTitle(result: AudioTestResult): string {
  const outcome = classifyAudioTestResult(result);
  if (outcome === "success") return "测试通过";
  if (outcome === "undetected") return "没有检测到明显声音";
  return "测试失败";
}

export function AudioDeviceTestWizard({
  devices,
  busy,
  error,
  sessionActive,
  onReload,
  onClose,
}: AudioDeviceTestWizardProps) {
  const [kind, setKind] = useState<AudioTestKind>("playback");
  const [deviceId, setDeviceId] = useState(() => defaultDeviceId(devices, "playback"));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AudioTestResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const requestGate = useRef(createAudioTestRequestGate());

  const options = useMemo(() => devicesForAudioTest(devices, kind), [devices, kind]);
  const SelectedIcon = TESTS.find((item) => item.kind === kind)?.icon ?? Volume2;

  useEffect(() => {
    if (!options.some((device) => device.id === deviceId)) {
      setDeviceId(defaultDeviceId(devices, kind));
    }
  }, [deviceId, devices, kind, options]);

  const selectKind = (next: AudioTestKind) => {
    if (running) return;
    requestGate.current.invalidate();
    setKind(next);
    setDeviceId(defaultDeviceId(devices, next));
    setResult(null);
    setRunError(null);
  };

  const run = async () => {
    if (running || sessionActive || !deviceId) return;
    const request = requestGate.current.begin();
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      const next = await translatorApi.runAudioTest({ kind, deviceId });
      if (!requestGate.current.isCurrent(request)) return;
      setResult(next);
    } catch (cause) {
      if (!requestGate.current.isCurrent(request)) return;
      setRunError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestGate.current.isCurrent(request)) setRunning(false);
    }
  };

  const close = () => {
    requestGate.current.invalidate();
    onClose();
  };

  return (
    <div
      className="modal-backdrop audio-test-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <section
        className="audio-test-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-test-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="audio-test-dialog__header">
          <div>
            <span className="eyebrow">本地设备检查</span>
            <h2 id="audio-test-title">设备测试向导</h2>
            <p>测试只在本机进行，不会连接同传服务或保存录音。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={close}
            aria-label="关闭设备测试向导"
            title="关闭设备测试向导"
          >
            <X size={18} />
          </button>
        </header>

        <div className="audio-test-dialog__body">
          {sessionActive && (
            <div className="audio-test-notice audio-test-notice--warning" role="alert">
              请先停止同传，再进行设备测试。
            </div>
          )}
          {(error || busy) && (
            <div className="audio-test-device-status" role={error ? "alert" : "status"}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              <span>{busy ? "正在检测音频设备…" : error}</span>
              {error && (
                <button className="button button--secondary button--compact" type="button" onClick={onReload}>
                  重新检测
                </button>
              )}
            </div>
          )}

          <div className="audio-test-options" role="list" aria-label="设备测试类型">
            {TESTS.map(({ kind: optionKind, description, icon: Icon }) => (
              <button
                key={optionKind}
                className={`audio-test-option${kind === optionKind ? " is-selected" : ""}`}
                type="button"
                role="listitem"
                aria-pressed={kind === optionKind}
                disabled={running}
                onClick={() => selectKind(optionKind)}
              >
                <span className="audio-test-option__icon"><Icon size={19} /></span>
                <span className="audio-test-option__copy">
                  <strong>{audioTestLabel(optionKind)}</strong>
                  <span>{description}</span>
                </span>
                {kind === optionKind && <Check size={17} className="audio-test-option__check" />}
              </button>
            ))}
          </div>

          <div className="audio-test-runner">
            <label className="field-group">
              <span className="field-label">
                {audioTestDeviceKind(kind) === "microphone" ? "测试麦克风" : "测试播放设备"}
                <button
                  className="icon-button icon-button--compact"
                  type="button"
                  onClick={onReload}
                  disabled={busy || running}
                  aria-label="重新检测音频设备"
                  title="重新检测音频设备"
                >
                  <RefreshCw size={14} className={busy ? "spin" : undefined} />
                </button>
              </span>
              <select
                value={deviceId}
                disabled={running || options.length === 0}
                onChange={(event) => {
                  setDeviceId(event.target.value);
                  setResult(null);
                  setRunError(null);
                }}
              >
                {options.length === 0 ? (
                  <option value="">{deviceMissingText(kind)}</option>
                ) : (
                  options.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}{device.isDefault ? "（系统默认）" : ""}
                    </option>
                  ))
                )}
              </select>
            </label>

            <button
              className="button button--primary audio-test-runner__button"
              type="button"
              disabled={running || sessionActive || !deviceId || options.length === 0}
              onClick={() => void run()}
            >
              {running ? <LoaderCircle size={16} className="spin" /> : <SelectedIcon size={16} />}
              {running ? "测试中…" : `开始${audioTestLabel(kind)}`}
            </button>
          </div>

          {runError && (
            <div className="audio-test-result audio-test-result--error" role="alert">
              <strong>测试失败</strong>
              <span>{runError}</span>
            </div>
          )}
          {result && (
            <div
              className={`audio-test-result audio-test-result--${classifyAudioTestResult(result)}`}
              role="status"
              aria-live="polite"
            >
              <div className="audio-test-result__heading">
                <strong>{resultTitle(result)}</strong>
                <span>{result.deviceName || "所选设备"}</span>
              </div>
              <span>{result.detail || "测试已完成"}</span>
              {(kind !== "playback" || result.durationMs) && (
                <div className="audio-test-result__metrics">
                  <span>耗时 {result.durationMs ?? 0} ms</span>
                  {kind !== "playback" && <span>峰值 {((result.peak ?? 0) * 100).toFixed(1)}%</span>}
                  {kind !== "playback" && <span>RMS {((result.rms ?? 0) * 100).toFixed(1)}%</span>}
                </div>
              )}
              <button
                className="button button--secondary button--compact"
                type="button"
                onClick={() => {
                  setResult(null);
                  setRunError(null);
                }}
                disabled={running}
              >
                <RotateCcw size={14} />
                再测一次
              </button>
            </div>
          )}
        </div>

        <footer className="audio-test-dialog__footer">
          <button className="button button--secondary" type="button" onClick={close}>
            <ArrowLeft size={15} />
            返回音频设置
          </button>
          <span className="audio-test-dialog__hint">不会更改系统默认设备</span>
        </footer>
      </section>
    </div>
  );
}
