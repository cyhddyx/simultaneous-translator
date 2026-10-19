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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

export function normalizeAudioTestResult(
  value: unknown,
  fallbackKind: AudioTestKind,
): AudioTestResult {
  const raw = record(value);
  const kind = raw.kind === "playback" || raw.kind === "microphone" || raw.kind === "loopback"
    ? raw.kind
    : fallbackKind;
  return {
    ok: raw.ok === true,
    kind,
    deviceId: text(raw.deviceId ?? raw.device_id),
    deviceName: text(raw.deviceName ?? raw.device_name),
    durationMs: number(raw.durationMs ?? raw.duration_ms),
    peak: number(raw.peak),
    rms: number(raw.rms),
    detected: raw.detected === true,
    detail: text(raw.detail),
  };
}

export function mockAudioTestResult(request: AudioTestRequest): AudioTestResult {
  const isMicrophone = request.kind === "microphone";
  return {
    ok: true,
    kind: request.kind,
    deviceId: request.deviceId,
    deviceName: isMicrophone ? "演示麦克风" : "演示播放设备",
    durationMs: isMicrophone ? 3000 : 1000,
    peak: isMicrophone ? 0.21 : 0,
    rms: isMicrophone ? 0.08 : 0,
    detected: true,
    detail: `${request.kind === "playback" ? "播放测试音" : request.kind === "loopback" ? "回环" : "麦克风"}测试成功（浏览器演示）`,
  };
}

export function createAudioTestRequestGate() {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (request: number) => request === current,
    invalidate: () => ++current,
  };
}

