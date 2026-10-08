import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioTestDeviceKind,
  audioTestLabel,
  classifyAudioTestResult,
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
