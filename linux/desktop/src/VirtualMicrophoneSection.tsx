import { useState } from "react";
import { Cable, Check, ExternalLink, RefreshCw } from "./PixelIcons";
import type { AudioDeviceList, AudioSettings } from "./types";
import { translatorApi } from "./tauri";
import {
  connectVirtualMicrophone,
  findVirtualMicrophone,
  VIRTUAL_MICROPHONE_NAME,
} from "./audioRouting";

interface Props {
  audio: AudioSettings;
  devices: AudioDeviceList | null;
  devicesBusy: boolean;
  devicesError: string | null;
  onReload: () => Promise<AudioDeviceList | undefined>;
  onChange: (audio: AudioSettings) => void;
}

export function VirtualMicrophoneSection({ audio, devices, devicesBusy, devicesError, onReload, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const virtualMicrophone = findVirtualMicrophone(devices);
  const configured = Boolean(virtualMicrophone && audio.speak.enabled && audio.speak.playAudio &&
    audio.speak.input === "microphone" && audio.speak.outputDevice === virtualMicrophone.playback.id);
  const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const create = async () => {
    setBusy(true);
    setError("");
    setMessage("正在创建 PulseAudio 虚拟麦克风…");
    try {
      await translatorApi.installVirtualMicrophone();
      await onReload();
      setMessage(`虚拟麦克风已创建。请点击“连接译文输出”，然后在会议软件的麦克风列表中选择 “${VIRTUAL_MICROPHONE_NAME}”。`);
    } catch (reason) {
      setMessage("");
      reportError(reason);
    } finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const refreshed = await onReload();
      if (!refreshed) return;
      onChange(connectVirtualMicrophone(audio, refreshed));
      setMessage(`译文输出已配置，保存后在下一次同传生效。通话软件的麦克风请选择 “${VIRTUAL_MICROPHONE_NAME}”。`);
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };
  const openHelp = () => {
    void translatorApi.openVirtualMicrophoneLink("help").catch(reportError);
  };
  return (
    <div className="virtual-microphone" aria-label="虚拟麦克风">
      <div className="audio-channel__heading">
        <Cable size={18} aria-hidden="true" />
        <div><strong>发送译文到其他应用</strong><span>PulseAudio 内置虚拟麦克风</span></div>
        <span className="audio-channel__state">{devicesBusy ? "检测中" : devicesError ? "检测失败" : configured ? "已配置" : virtualMicrophone ? "可连接" : "未创建"}</span>
      </div>
      <div className="virtual-microphone__route">
        <span>通话软件麦克风</span>
        <strong>{virtualMicrophone?.recording.name ?? VIRTUAL_MICROPHONE_NAME}</strong>
      </div>
      <div className="virtual-microphone__actions">
        {!virtualMicrophone && (
          <button type="button" className="button button--primary" disabled={busy || devicesBusy} onClick={() => void create()}>
            <Cable size={15} />{busy ? "正在创建…" : "创建虚拟麦克风"}
          </button>
        )}
        <button type="button" className={`button button--${virtualMicrophone ? "primary" : "secondary"}`} disabled={busy || devicesBusy} onClick={() => void connect()}>
          {configured ? <Check size={15} /> : <RefreshCw size={15} />}
          {virtualMicrophone ? "连接译文输出" : "检测并连接"}
        </button>
      </div>
      <p className="virtual-microphone__notice">虚拟麦克风由 PulseAudio 内置模块实现，一键创建，无需下载驱动或管理员权限，也无需重启应用。译文发送到通话软件后，本机不同时播放发言译文。</p>
      {message && <p className="virtual-microphone__message" role="status">{message}</p>}
      {(error || devicesError) && <p className="field-error" role="alert">{error || devicesError}</p>}
      <p className="virtual-microphone__notice">创建后模块会保持加载，停止同传不会卸载；若会议软件未列出该设备，请确认它使用 PulseAudio 或 PipeWire（pipewire-pulse）音频。</p>
      <div className="virtual-microphone__links">
        <button type="button" onClick={openHelp}><ExternalLink size={12} />Linux 音频路由说明</button>
      </div>
    </div>
  );
}
