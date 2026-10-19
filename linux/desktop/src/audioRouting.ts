import type { AudioDevice, AudioDeviceList, AudioSettings } from "./types";

/**
 * Linux virtual microphone.
 *
 * `install_virtual_microphone` creates two PulseAudio modules idempotently
 * (docs/linux-audio-routing.md §4):
 *
 * - `translator_mic` null sink: the speech channel plays the translated voice
 *   here, and the meeting software captures it through the remap source;
 * - `translator_mic_source` remap source: published as "Translator Virtual
 *   Microphone", the microphone entry the meeting software selects.
 *
 * The engine reports the PulseAudio object name as `id` and the
 * `device.description` property as `name` (docs/linux-audio-routing.md §5), so
 * accept either form and tolerate a renamed description.
 */
export const VIRTUAL_MICROPHONE_SINK_ID = "translator_mic";
export const VIRTUAL_MICROPHONE_SOURCE_ID = "translator_mic_source";
export const VIRTUAL_MICROPHONE_NAME = "Translator Virtual Microphone";

const SINK_NAME_PATTERN = /translator\s*virtual\s*microphone\s*sink/i;
const SOURCE_NAME_PATTERN = /^translator\s*virtual\s*microphone$/i;

function isVirtualMicrophoneSink(device: AudioDevice): boolean {
  return (
    device.id === VIRTUAL_MICROPHONE_SINK_ID ||
    SINK_NAME_PATTERN.test(device.name.trim())
  );
}

function isVirtualMicrophoneSource(device: AudioDevice): boolean {
  return (
    device.id === VIRTUAL_MICROPHONE_SOURCE_ID ||
    SOURCE_NAME_PATTERN.test(device.name.trim())
  );
}

export function findVirtualMicrophone(devices: AudioDeviceList | null) {
  const playback = devices?.speakers.find(isVirtualMicrophoneSink);
  const recording = devices?.microphones.find(isVirtualMicrophoneSource);
  return playback && recording ? { playback, recording } : null;
}

export function connectVirtualMicrophone(
  audio: AudioSettings,
  devices: AudioDeviceList,
): AudioSettings {
  const virtualMicrophone = findVirtualMicrophone(devices);
  if (!virtualMicrophone) {
    throw new Error(
      "未检测到 PulseAudio 虚拟麦克风，请先点击“创建虚拟麦克风”后重试。",
    );
  }
  const microphones = devices.microphones.filter(
    (device) =>
      device.id !== virtualMicrophone.recording.id && !device.loopback,
  );
  const preferred = (items: AudioDevice[]) =>
    items.find((device) => device.isDefault) ?? items[0];
  const microphone = (audio.speak.input === "microphone"
    ? microphones.find((device) => device.id === audio.speak.inputDevice)
    : undefined) ?? preferred(microphones);
  if (!microphone) throw new Error("请先连接用于说话的麦克风，再连接译文输出。");
  const speakers = devices.speakers.filter(
    (device) => device.id !== virtualMicrophone.playback.id,
  );
  const listen = { ...audio.listen };
  const defaultIsVirtualMicrophone = virtualMicrophone.playback.isDefault;
  if (
    listen.enabled && listen.input === "loopback" &&
    (listen.inputDevice === virtualMicrophone.playback.id ||
      (!listen.inputDevice && defaultIsVirtualMicrophone))
  ) {
    listen.input = "system";
    listen.inputDevice = "";
  }
  if (
    listen.enabled && listen.input === "microphone" &&
    (listen.inputDevice === virtualMicrophone.recording.id ||
      (!listen.inputDevice && virtualMicrophone.recording.isDefault))
  ) {
    throw new Error(
      "收听通道正在采集虚拟麦克风，请先将它改为系统声音或关闭该通道。",
    );
  }
  if (
    listen.enabled && listen.playAudio &&
    (listen.outputDevice === virtualMicrophone.playback.id ||
      (!listen.outputDevice && defaultIsVirtualMicrophone))
  ) {
    const speaker = preferred(speakers);
    if (!speaker) throw new Error("请先连接用于收听译文的耳机或扬声器。");
    listen.outputDevice = speaker.id;
  }
  if (listen.enabled && listen.input === "loopback" && listen.playAudio) {
    const defaultSpeaker = devices.speakers.find((device) => device.isDefault)?.id;
    if (
      (listen.inputDevice || defaultSpeaker) ===
      (listen.outputDevice || defaultSpeaker)
    ) {
      listen.input = "system";
      listen.inputDevice = "";
    }
  }
  return {
    listen,
    speak: {
      ...audio.speak,
      enabled: true,
      input: "microphone",
      inputDevice: microphone.id,
      playAudio: true,
      outputDevice: virtualMicrophone.playback.id,
    },
  };
}
