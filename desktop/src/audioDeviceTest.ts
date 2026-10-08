import type { AudioDevice, AudioDeviceList } from "./types";

export type AudioTestKind = "playback" | "microphone" | "loopback";
export type AudioTestDeviceKind = "speaker" | "microphone";
export type AudioTestOutcome = "success" | "undetected" | "error";

export interface AudioTestRequest {
  kind: AudioTestKind;
  deviceId: string;
}

export interface AudioTestResult {
  ok: boolean;
  kind: AudioTestKind;
  deviceId?: string;
  deviceName?: string;
  durationMs?: number;
  peak?: number;
  rms?: number;
  detected?: boolean;
  detail?: string;
}

export function audioTestLabel(kind: AudioTestKind): string {
  return {
    playback: "播放测试音",
    microphone: "麦克风测试",
    loopback: "回环测试",
  }[kind];
}

export function audioTestDeviceKind(kind: AudioTestKind): AudioTestDeviceKind {
  return kind === "microphone" ? "microphone" : "speaker";
}

export function devicesForAudioTest(
  devices: AudioDeviceList | null,
  kind: AudioTestKind,
): AudioDevice[] {
  if (!devices) return [];
  return audioTestDeviceKind(kind) === "microphone"
    ? devices.microphones
    : devices.speakers;
}

export function classifyAudioTestResult(
  result: Partial<AudioTestResult> | null | undefined,
): AudioTestOutcome {
  if (!result || result.ok !== true) return "error";
  return result.detected === false ? "undetected" : "success";
}
