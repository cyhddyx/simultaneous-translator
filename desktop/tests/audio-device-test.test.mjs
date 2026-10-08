import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioTestDeviceKind,
  audioTestLabel,
  classifyAudioTestResult,
  mockAudioTestResult,
  normalizeAudioTestResult,
} from "../src/audioDeviceTest.ts";

test("maps each audio test to its device kind and label", () => {
  assert.equal(audioTestDeviceKind("playback"), "speaker");
  assert.equal(audioTestDeviceKind("microphone"), "microphone");
  assert.equal(audioTestDeviceKind("loopback"), "speaker");
  assert.equal(audioTestLabel("playback"), "播放测试音");
  assert.equal(audioTestLabel("microphone"), "麦克风测试");
  assert.equal(audioTestLabel("loopback"), "回环测试");
});

test("classifies audio test outcomes without losing undetected signals", () => {
  assert.equal(classifyAudioTestResult({ ok: true, detected: true }), "success");
  assert.equal(classifyAudioTestResult({ ok: true, detected: false }), "undetected");
  assert.equal(classifyAudioTestResult({ ok: false, detected: true }), "error");
  assert.equal(classifyAudioTestResult(null), "error");
});

test("normalizes the snake case sidecar result into the frontend contract", () => {
  assert.deepEqual(
    normalizeAudioTestResult(
      {
        ok: true,
        kind: "microphone",
        device_id: "mic-1",
        device_name: "USB microphone",
        duration_ms: 3001,
        peak: 0.21,
        rms: 0.08,
        detected: false,
        detail: "未检测到明显麦克风声音",
      },
      "microphone",
    ),
    {
      ok: true,
      kind: "microphone",
      deviceId: "mic-1",
      deviceName: "USB microphone",
      durationMs: 3001,
      peak: 0.21,
      rms: 0.08,
      detected: false,
      detail: "未检测到明显麦克风声音",
    },
  );
});

test("browser audio test result is deterministic and identifies the selected device", () => {
  const result = mockAudioTestResult({
    kind: "microphone",
    deviceId: "demo-mic",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "microphone");
  assert.equal(result.deviceId, "demo-mic");
  assert.equal(result.detected, true);
  assert.equal(result.deviceName, "演示麦克风");
});
