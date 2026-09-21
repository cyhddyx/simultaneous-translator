import type { AudioDevice, AudioDeviceList, AudioSettings } from "./types";

// Only the standard VB-CABLE pair is covered by the integrated installer.
export function findVirtualMicrophone(devices: AudioDeviceList | null) {
  const playback = devices?.speakers.find((device) =>
    /^CABLE Input \(VB-Audio Virtual Cable\)$/i.test(device.name.trim()),
  );
  const recording = devices?.microphones.find((device) =>
    /^CABLE Output \(VB-Audio Virtual Cable\)$/i.test(device.name.trim()),
  );
  return playback && recording ? { playback, recording } : null;
}

export function connectVirtualMicrophone(audio: AudioSettings, devices: AudioDeviceList): AudioSettings {
  const cable = findVirtualMicrophone(devices);
  if (!cable) throw new Error("未检测到完整的 VB-CABLE 设备，请完成安装并重启电脑后重试。");
  const microphones = devices.microphones.filter((device) =>
    device.id !== cable.recording.id && !device.loopback,
  );
  const preferred = (items: AudioDevice[]) => items.find((device) => device.isDefault) ?? items[0];
  const microphone = (audio.speak.input === "microphone"
    ? microphones.find((device) => device.id === audio.speak.inputDevice)
    : undefined) ?? preferred(microphones);
  if (!microphone) throw new Error("请先连接用于说话的麦克风，再连接译文输出。");
  const speakers = devices.speakers.filter((device) => device.id !== cable.playback.id);
  const listen = { ...audio.listen };
  const defaultIsCable = cable.playback.isDefault;
  if (listen.enabled && listen.input === "loopback" &&
      (listen.inputDevice === cable.playback.id || (!listen.inputDevice && defaultIsCable))) {
    listen.input = "system";
    listen.inputDevice = "";
  }
  if (listen.enabled && listen.input === "microphone" &&
      (listen.inputDevice === cable.recording.id || (!listen.inputDevice && cable.recording.isDefault))) {
    throw new Error("收听通道正在采集 VB-CABLE，请先将它改为系统声音或关闭该通道。");
  }
  if (listen.enabled && listen.playAudio &&
      (listen.outputDevice === cable.playback.id || (!listen.outputDevice && defaultIsCable))) {
    const speaker = preferred(speakers);
    if (!speaker) throw new Error("请先连接用于收听译文的耳机或扬声器。");
    listen.outputDevice = speaker.id;
  }
  if (listen.enabled && listen.input === "loopback" && listen.playAudio) {
    const defaultSpeaker = devices.speakers.find((device) => device.isDefault)?.id;
    if ((listen.inputDevice || defaultSpeaker) === (listen.outputDevice || defaultSpeaker)) {
      listen.input = "system";
      listen.inputDevice = "";
    }
  }
  return {
    listen,
    speak: { ...audio.speak, enabled: true, input: "microphone", inputDevice: microphone.id,
      playAudio: true, outputDevice: cable.playback.id },
  };
}
