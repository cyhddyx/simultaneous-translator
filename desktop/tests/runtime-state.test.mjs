import assert from "node:assert/strict";
import { test } from "node:test";
import { engineErrorTitle, errorServiceFromEvent } from "../src/snapshot.ts";
import {
  applyRuntimeState,
  createInitialRuntimeState,
  deriveMockTrayStatus,
  describeRuntimeActionResult,
  describeRuntimeChange,
  normalizeRuntimeState,
  runtimeChangeSignature,
  runtimeCoversService,
  runtimeErrorRows,
  shortcutFailureNotice,
  trayStatusLabel,
} from "../src/runtime.ts";

const TRAY_STATUS_VALUES = [
  "not_started",
  "connecting",
  "translating",
  "audio_error",
  "network_error",
];

test("initial runtime state carries exactly the frozen contract fields", () => {
  assert.deepEqual(createInitialRuntimeState(), {
    revision: 0,
    trayStatus: "not_started",
    sessionPhase: "idle",
    sessionId: null,
    audioHealth: "unknown",
    networkHealth: "unknown",
    listenEnabled: false,
    speakEnabled: false,
    speakMuted: false,
    subtitleVisible: false,
    shortcutFailures: [],
    lastError: null,
    updatedAt: "1970-01-01T00:00:00Z",
  });
});

test("the five tray status labels match the contract wording", () => {
  assert.deepEqual(TRAY_STATUS_VALUES.map(trayStatusLabel), [
    "未启动",
    "正在连接",
    "正常翻译",
    "音频异常",
    "网络异常",
  ]);
});

test("a stale or repeated runtime revision is dropped without a new object", () => {
  const first = {
    ...createInitialRuntimeState(),
    revision: 4,
    trayStatus: "connecting",
    sessionPhase: "starting",
  };
  const applied = applyRuntimeState(null, first);
  assert.equal(applied, first);

  const newer = { ...first, revision: 5, trayStatus: "translating" };
  assert.equal(applyRuntimeState(applied, newer), newer);
  // Older and equal revisions keep the previous object identity, which lets
  // React skip the render entirely.
  assert.equal(applyRuntimeState(newer, first), newer);
  assert.equal(applyRuntimeState(newer, { ...newer, trayStatus: "audio_error" }), newer);
});

test("normalizeRuntimeState rejects unknown values instead of leaking them", () => {
  assert.deepEqual(normalizeRuntimeState(null), createInitialRuntimeState());

  const normalized = normalizeRuntimeState({
    revision: "9",
    trayStatus: "bogus",
    sessionPhase: "nope",
    sessionId: 42,
    audioHealth: "failed",
    networkHealth: "ready",
    listenEnabled: "yes",
    speakEnabled: true,
    subtitleVisible: 1,
    shortcutFailures: [
      { accelerator: " Ctrl+Shift+M ", action: "toggle_speak_mute", reason: "已被占用" },
      { accelerator: "" },
      "nonsense",
    ],
    lastError: { service: "network", code: "websocket_disconnected", message: "翻译服务连接已断开。" },
  });

  assert.equal(normalized.revision, 0);
  assert.equal(normalized.trayStatus, "not_started");
  assert.equal(normalized.sessionPhase, "idle");
  assert.equal(normalized.sessionId, null);
  assert.equal(normalized.audioHealth, "failed");
  assert.equal(normalized.networkHealth, "ready");
  assert.equal(normalized.listenEnabled, false);
  assert.equal(normalized.speakEnabled, true);
  assert.equal(normalized.subtitleVisible, false);
  assert.equal(normalized.updatedAt, "1970-01-01T00:00:00Z");
  assert.deepEqual(normalized.shortcutFailures, [
    { accelerator: "Ctrl+Shift+M", action: "toggle_speak_mute", reason: "已被占用" },
  ]);
  assert.deepEqual(normalized.lastError, {
    id: "runtime-error-websocket_disconnected",
    service: "network",
    code: "websocket_disconnected",
    message: "翻译服务连接已断开。",
    recoverable: true,
    sessionId: null,
  });
});

test("audio failures and network failures are classified and worded differently", () => {
  const idle = createInitialRuntimeState();
  const audioFailed = { ...idle, revision: 1, audioHealth: "failed", trayStatus: "audio_error" };
  const networkFailed = { ...idle, revision: 1, networkHealth: "failed", trayStatus: "network_error" };

  assert.equal(runtimeChangeSignature(idle, audioFailed), "audio_error");
  assert.equal(runtimeChangeSignature(idle, networkFailed), "network_error");

  const audioText = describeRuntimeChange(idle, audioFailed);
  const networkText = describeRuntimeChange(idle, networkFailed);
  assert.notEqual(audioText, networkText);
  assert.match(audioText, /音频/);
  assert.match(networkText, /网络/);

  // Contract §3 priority: network wins when both fail.
  const both = {
    ...idle,
    revision: 2,
    audioHealth: "failed",
    networkHealth: "failed",
    trayStatus: "network_error",
  };
  assert.equal(deriveMockTrayStatus(both), "network_error");
  assert.equal(runtimeChangeSignature(idle, both), "network_error");
  assert.match(describeRuntimeChange(idle, both), /网络/);
});

test("the error area reports audio and network side by side", () => {
  const state = {
    ...createInitialRuntimeState(),
    revision: 3,
    trayStatus: "network_error",
    audioHealth: "failed",
    networkHealth: "failed",
    lastError: {
      id: "e1",
      service: "network",
      code: "websocket_disconnected",
      message: "翻译服务连接已断开。",
      recoverable: true,
      sessionId: "s1",
    },
  };
  const rows = runtimeErrorRows(state);

  assert.deepEqual(
    rows.map((row) => row.service),
    ["audio", "network"],
  );
  assert.notEqual(rows[0].title, rows[1].title);
  assert.equal(rows[0].title, "音频异常");
  assert.equal(rows[1].title, "网络异常");
  // The network row carries the newest runtime error; the audio row keeps its
  // own wording instead of being overwritten.
  assert.equal(rows[1].message, "翻译服务连接已断开。");
  assert.equal(rows[0].message, "音频设备或采集链路不可用，请检查设备后重试。");
  assert.ok(runtimeCoversService(rows, "audio"));
  assert.ok(runtimeCoversService(rows, "network"));
  assert.ok(!runtimeCoversService(rows, "recognition"));

  assert.deepEqual(runtimeErrorRows(null), []);
  assert.deepEqual(runtimeErrorRows(createInitialRuntimeState()), []);
});

test("a degraded chain gets an intermediate wording, never a failure row", () => {
  const idle = createInitialRuntimeState();
  const degraded = {
    ...idle,
    revision: 7,
    trayStatus: "translating",
    networkHealth: "degraded",
    audioHealth: "degraded",
    lastError: {
      id: "e2",
      service: "network",
      code: "websocket_reconnecting",
      message: "WebSocket 重连中（第 2 次）",
      recoverable: true,
      sessionId: "s1",
    },
  };
  const rows = runtimeErrorRows(degraded);

  assert.deepEqual(
    rows.map((row) => [row.service, row.severity]),
    [
      ["audio", "warning"],
      ["network", "warning"],
    ],
  );
  // Only `failed` may ever read as 异常.
  assert.ok(rows.every((row) => !row.title.includes("异常")));
  assert.equal(rows[1].title, "网络不稳定");
  assert.equal(rows[1].message, "WebSocket 重连中（第 2 次）");
  assert.ok(rows.every((row) => row.recoverable === false));
  // The tray status is rendered as reported by native; degraded never turns it
  // into network_error (contract §3).
  assert.equal(degraded.trayStatus, "translating");
});

test("a non-recoverable configuration error is never retryable", () => {
  const idle = createInitialRuntimeState();
  const configuration = {
    id: "e3",
    service: "configuration",
    code: "realtime_voice_clone_unsupported",
    message: "当前模型不支持声音复刻。",
    recoverable: false,
    sessionId: null,
  };

  const onlyConfiguration = runtimeErrorRows({
    ...idle,
    revision: 8,
    lastError: configuration,
  });
  assert.equal(onlyConfiguration.length, 1);
  assert.equal(onlyConfiguration[0].service, "configuration");
  assert.equal(onlyConfiguration[0].recoverable, false);
  assert.equal(onlyConfiguration[0].severity, "error");

  // An audio failure next to a configuration error keeps its own retry entry;
  // the configuration row stays non-retryable.
  const mixed = runtimeErrorRows({
    ...idle,
    revision: 9,
    audioHealth: "failed",
    lastError: configuration,
  });
  assert.deepEqual(
    mixed.map((row) => [row.service, row.recoverable]),
    [
      ["audio", true],
      ["configuration", false],
    ],
  );
});

test("local action toasts only fire when that action changed the state", () => {
  const idle = createInitialRuntimeState();
  const shown = { ...idle, revision: 1, subtitleVisible: true };

  assert.equal(
    describeRuntimeActionResult("toggle_subtitle_window", idle, shown),
    "字幕悬浮窗已显示",
  );
  // Idempotent rejection: nothing changed, so nothing is announced.
  assert.equal(describeRuntimeActionResult("toggle_subtitle_window", idle, idle), null);
  // A different field changed; this action is not the one to report.
  assert.equal(
    describeRuntimeActionResult("start_or_stop_session", idle, {
      ...idle,
      revision: 1,
      listenEnabled: true,
    }),
    null,
  );
  const started = {
    ...idle,
    revision: 1,
    sessionPhase: "starting",
    sessionId: "s1",
    trayStatus: "connecting",
  };
  assert.equal(
    describeRuntimeActionResult("start_or_stop_session", idle, started),
    "同传已开始",
  );
  assert.equal(
    describeRuntimeActionResult("toggle_speak_mute", idle, started),
    null,
  );
});

test("engine errors are classified by service, never by code", () => {
  // The sidecar's `service` field wins over the legacy `scope`.
  assert.equal(errorServiceFromEvent("network", "asr"), "network");
  assert.equal(errorServiceFromEvent("audio", "translation"), "audio");
  assert.equal(errorServiceFromEvent("configuration", "asr"), "configuration");
  assert.equal(errorServiceFromEvent("system", "audio"), "system");

  // Legacy payloads without `service` keep the previous scope mapping.
  assert.equal(errorServiceFromEvent(undefined, "audio"), "audio");
  assert.equal(errorServiceFromEvent(undefined, "asr"), "recognition");
  assert.equal(errorServiceFromEvent(undefined, "translation"), "translation");
  assert.equal(errorServiceFromEvent(undefined, ""), "system");
  assert.equal(errorServiceFromEvent("bogus", "asr"), "recognition");

  // Audio failures are told apart by `service`; an unknown code still reads as
  // an audio failure instead of silently becoming a generic engine error.
  assert.equal(engineErrorTitle("audio", "audio_device_lost"), "音频采集失败");
  assert.equal(engineErrorTitle("audio", "audio_start_failed"), "音频采集失败");
  assert.equal(engineErrorTitle("audio", "audio_playback_failed"), "译文播放失败");
  assert.equal(engineErrorTitle("network", "websocket_connect_failed"), "网络连接异常");
  assert.equal(engineErrorTitle("configuration", "realtime_output_mismatch"), "配置有问题");
});

test("shortcut registration failures produce one readable notice", () => {
  assert.equal(shortcutFailureNotice([]), null);
  assert.equal(shortcutFailureNotice(null), null);
  assert.equal(shortcutFailureNotice(undefined), null);

  const notice = shortcutFailureNotice([
    { accelerator: "Ctrl+Shift+Space", action: "start_or_stop_session", reason: "已被占用" },
    { accelerator: "Ctrl+Shift+O", action: "toggle_subtitle_window", reason: "" },
  ]);
  assert.match(notice, /Ctrl\+Shift\+Space/);
  assert.match(notice, /已被占用/);
  assert.match(notice, /Ctrl\+Shift\+O/);
  assert.match(notice, /注册失败/);
});
