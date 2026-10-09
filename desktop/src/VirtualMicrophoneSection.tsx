import { useState } from "react";
import { Cable, Check, Download, ExternalLink, RefreshCw } from "./PixelIcons";
import type { AudioDeviceList, AudioSettings } from "./types";
import { translatorApi } from "./tauri";
import { connectVirtualMicrophone, findVirtualMicrophone } from "./audioRouting";

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
  const [installerOpened, setInstallerOpened] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const cable = findVirtualMicrophone(devices);
  const configured = Boolean(cable && audio.speak.enabled && audio.speak.playAudio &&
    audio.speak.input === "microphone" && audio.speak.outputDevice === cable.playback.id);
  const reportError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const install = async () => {
    setBusy(true);
    setError("");
    setMessage("正在下载并核验官方组件，请稍候…");
    try {
      await translatorApi.installVirtualMicrophone();
      setInstallerOpened(true);
      setMessage("官方安装程序已打开。完成安装后点击检测并连接；设备未出现时，请重启电脑。");
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
      setMessage("译文输出已配置，保存后在下一次同传生效。通话软件的麦克风请选择 CABLE Output。");
    } catch (reason) { reportError(reason); }
    finally { setBusy(false); }
  };
  const openLink = (kind: "product" | "license" | "donate") => {
    void translatorApi.openVirtualMicrophoneLink(kind).catch(reportError);
  };
  return (
    <div className="virtual-microphone" aria-label="虚拟麦克风">
      <div className="audio-channel__heading">
        <Cable size={18} aria-hidden="true" />
        <div><strong>发送译文到其他应用</strong><span>VB-CABLE 虚拟麦克风</span></div>
        <span className="audio-channel__state">{devicesBusy ? "检测中" : devicesError ? "检测失败" : configured ? "已配置" : cable ? "可连接" : "未检测到"}</span>
      </div>
      <div className="virtual-microphone__route">
        <span>通话软件麦克风</span>
        <strong>{cable?.recording.name ?? "CABLE Output (VB-Audio Virtual Cable)"}</strong>
      </div>
      <div className="virtual-microphone__actions">
        {!cable && (
          <button type="button" className={`button button--${installerOpened ? "secondary" : "primary"}`} disabled={busy || devicesBusy || !devices || Boolean(devicesError)} onClick={() => void install()}>
            <Download size={15} />{busy ? "准备安装中…" : installerOpened ? "重新打开安装程序" : "安装官方组件"}
          </button>
        )}
        <button type="button" className={`button button--${cable || installerOpened ? "primary" : "secondary"}`} disabled={busy || devicesBusy} onClick={() => void connect()}>
          {configured ? <Check size={15} /> : <RefreshCw size={15} />}
          {cable ? "连接译文输出" : "检测并连接"}
        </button>
      </div>
      <p className="virtual-microphone__notice">首次安装需要管理员确认，可能需要重启。译文发送到通话软件后，本机不同时播放发言译文。</p>
      {message && <p className="virtual-microphone__message" role="status">{message}</p>}
      {(error || devicesError) && <p className="field-error" role="alert">{error || devicesError}</p>}
      <p className="virtual-microphone__notice">VB-CABLE 由 VB-Audio 提供，是 Donationware（捐赠软件），欢迎捐赠支持；专业或组织使用需遵守其付费许可要求。</p>
      <div className="virtual-microphone__links">
        <button type="button" onClick={() => openLink("product")}><ExternalLink size={12} />www.vb-cable.com</button>
        <button type="button" onClick={() => openLink("license")}><ExternalLink size={12} />授权条款</button>
        <button type="button" onClick={() => openLink("donate")}><ExternalLink size={12} />捐赠／购买许可</button>
      </div>
    </div>
  );
}
