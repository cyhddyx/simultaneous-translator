import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MockOpenSettingsChannel,
  MockRuntimeController,
  trayStatusLabel,
} from "../src/runtime.ts";

const build = (options = {}) =>
  new MockRuntimeController({ connectDelayMs: 0, ...options });

test("start_or_stop_session drives the mocked engine state machine", async () => {
  const runtime = build();
  const broadcasts = [];
  const unlisten = runtime.subscribeRuntimeState((state) => broadcasts.push(state));

  const starting = runtime.dispatchNativeAction("start_or_stop_session");
  assert.equal(starting.sessionPhase, "starting");
  assert.equal(starting.trayStatus, "connecting");
  assert.equal(trayStatusLabel(starting.trayStatus), "正在连接");
  assert.equal(starting.listenEnabled, false);
  assert.ok(starting.sessionId);
  assert.equal(broadcasts.length, 1);

  await runtime.settle();
  const listening = runtime.getRuntimeState();
  assert.equal(listening.sessionPhase, "listening");
  assert.equal(listening.trayStatus, "translating");
  assert.equal(trayStatusLabel(listening.trayStatus), "正常翻译");
  assert.equal(listening.sessionId, starting.sessionId);
  assert.equal(listening.listenEnabled, true);
  assert.equal(listening.speakEnabled, true);
  assert.ok(listening.revision > starting.revision);
  assert.equal(broadcasts.at(-1).revision, listening.revision);

  unlisten();
  const seen = broadcasts.length;
  assert.equal(runtime.dispatchNativeAction("toggle_subtitle_window").subtitleVisible, true);
  assert.equal(broadcasts.length, seen);
});

test("a duplicate subscription with the same callback survives one cleanup", () => {
  // React Strict Mode mounts, cleans up and mounts again with the same callback
  // reference; the first cleanup must not remove the live subscription.
  const runtime = build();
  const seen = [];
  const listener = (state) => seen.push(state.revision);

  const firstCleanup = runtime.subscribeRuntimeState(listener);
  runtime.subscribeRuntimeState(listener);
  firstCleanup();

  runtime.dispatchNativeAction("toggle_subtitle_window");
  assert.equal(seen.length, 1);
  assert.equal(runtime.getRuntimeState().subtitleVisible, true);
});

test("stopping is a single transition and resets the runtime channels", async () => {
  const runtime = build();
  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();

  const stopping = runtime.dispatchNativeAction("start_or_stop_session");
  assert.equal(stopping.sessionPhase, "stopping");
  assert.equal(stopping.trayStatus, "connecting");
  // Second press while stopping must not create a second transition.
  assert.deepEqual(runtime.dispatchNativeAction("start_or_stop_session"), stopping);

  await runtime.settle();
  const idle = runtime.getRuntimeState();
  assert.equal(idle.sessionPhase, "idle");
  assert.equal(idle.sessionId, null);
  assert.equal(idle.trayStatus, "not_started");
  assert.equal(idle.audioHealth, "unknown");
  assert.equal(idle.networkHealth, "unknown");
  assert.equal(idle.listenEnabled, false);
  assert.equal(idle.speakEnabled, false);
  assert.equal(idle.speakMuted, false);
});

test("channel toggles require a live session and follow the configured channels", async () => {
  const runtime = build();

  assert.throws(
    () => runtime.dispatchNativeAction("toggle_listen_channel"),
    /请先开始同传，再使用通道控制。/,
  );
  assert.throws(
    () => runtime.dispatchNativeAction("toggle_speak_mute"),
    /请先开始同传，再使用通道控制。/,
  );
  assert.equal(runtime.getRuntimeState().lastError.code, "no_active_session");

  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();

  assert.equal(runtime.dispatchNativeAction("toggle_listen_channel").listenEnabled, false);
  assert.equal(runtime.dispatchNativeAction("toggle_listen_channel").listenEnabled, true);

  assert.equal(runtime.dispatchNativeAction("toggle_speak_channel").speakEnabled, false);
  assert.throws(
    () => runtime.dispatchNativeAction("toggle_speak_mute"),
    /发言通道未开启/,
  );
  assert.equal(runtime.dispatchNativeAction("toggle_speak_channel").speakEnabled, true);

  assert.equal(runtime.dispatchNativeAction("toggle_speak_mute").speakMuted, true);
  const unmuted = runtime.dispatchNativeAction("toggle_speak_mute");
  assert.equal(unmuted.speakMuted, false);
  // Muting never stops the session.
  assert.equal(unmuted.sessionPhase, "listening");
  assert.ok(unmuted.sessionId);
});

test("the mock open-settings channel subscribes and unsubscribes without throwing", () => {
  // Tray menu item "设置" (tray-shortcuts-contract §9) reaches the window as the
  // `open-settings` event; the browser path must expose the same contract.
  const channel = new MockOpenSettingsChannel();
  const received = [];
  const unlisten = channel.subscribe(() => received.push("settings"));

  // The handler branch the main window installs: "event received → open the
  // settings dialog".
  let settingsOpen = false;
  const closeDialog = channel.subscribe(() => {
    settingsOpen = true;
  });
  assert.equal(settingsOpen, false);
  channel.emit();
  assert.equal(settingsOpen, true);
  assert.deepEqual(received, ["settings"]);
  closeDialog();

  unlisten();
  assert.doesNotThrow(() => channel.emit());
  assert.deepEqual(received, ["settings"]);

  // Strict Mode double-subscribe + one cleanup must keep the live registration;
  // this is the exact failure mode fixed for subscribeRuntimeState in task-3.
  const handler = () => received.push("strict");
  const firstCleanup = channel.subscribe(handler);
  channel.subscribe(handler);
  firstCleanup();
  channel.emit();
  assert.deepEqual(received, ["settings", "strict"]);
});

test("closing the speak channel clears a pending mute in two ordered updates", async () => {
  const runtime = build();
  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();

  const broadcasts = [];
  const unlisten = runtime.subscribeRuntimeState((state) => broadcasts.push(state));

  assert.equal(runtime.dispatchNativeAction("toggle_speak_mute").speakMuted, true);
  broadcasts.length = 0;

  const disabled = runtime.dispatchNativeAction("toggle_speak_channel");
  assert.equal(disabled.speakEnabled, false);
  assert.equal(disabled.speakMuted, false);

  // Contract docs/runtime-channel-control.md §1.5: the sidecar emits
  // `runtime.channel` first and the compensating `runtime.mute` second, and the
  // mock reproduces that order instead of collapsing both into one update.
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(
    broadcasts.map((state) => [state.speakEnabled, state.speakMuted]),
    [
      [false, true],
      [false, false],
    ],
  );
  assert.ok(broadcasts[1].revision > broadcasts[0].revision);

  // §1.5 reverse direction: re-enabling must not touch the mute flag, so this
  // stays a single update (no ghost `runtime.mute` event).
  broadcasts.length = 0;
  const enabled = runtime.dispatchNativeAction("toggle_speak_channel");
  assert.equal(enabled.speakEnabled, true);
  assert.equal(enabled.speakMuted, false);
  assert.equal(broadcasts.length, 1);

  // The channel is usable again and can be muted normally.
  assert.equal(runtime.dispatchNativeAction("toggle_speak_mute").speakMuted, true);
  unlisten();
});

test("a channel that is disabled in the settings is refused, not faked", async () => {
  const runtime = build({ channelEnabled: () => ({ listen: false, speak: true }) });
  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();

  assert.equal(runtime.getRuntimeState().listenEnabled, false);
  assert.throws(
    () => runtime.dispatchNativeAction("toggle_listen_channel"),
    /收听通道未在设置中启用。/,
  );
  assert.equal(runtime.getRuntimeState().listenEnabled, false);
});

test("toggle_subtitle_window and show_main_window work without a session", () => {
  const runtime = build();
  const before = runtime.getRuntimeState();

  assert.equal(runtime.dispatchNativeAction("toggle_subtitle_window").subtitleVisible, true);
  assert.equal(runtime.dispatchNativeAction("toggle_subtitle_window").subtitleVisible, false);

  const unchanged = runtime.dispatchNativeAction("show_main_window");
  assert.deepEqual(unchanged, runtime.getRuntimeState());
  assert.ok(unchanged.revision > before.revision);
});

test("a failing start guard returns a readable error and records lastError", () => {
  const runtime = build({ guardStart: () => "请至少启用一个音频通道。" });

  assert.throws(
    () => runtime.dispatchNativeAction("start_or_stop_session"),
    /请至少启用一个音频通道。/,
  );
  const state = runtime.getRuntimeState();
  assert.equal(state.sessionId, null);
  assert.equal(state.sessionPhase, "idle");
  assert.equal(state.trayStatus, "not_started");
  assert.equal(state.lastError.service, "configuration");
  assert.equal(state.lastError.message, "请至少启用一个音频通道。");
  assert.equal(state.lastError.recoverable, false);
});

test("session hooks fire once per transition with the same session id", async () => {
  const started = [];
  const stopped = [];
  const runtime = build({
    onSessionStarted: (sessionId) => started.push(sessionId),
    onSessionStopped: (sessionId) => stopped.push(sessionId),
  });

  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();
  assert.deepEqual(started, [runtime.getRuntimeState().sessionId]);

  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();
  assert.deepEqual(stopped, started);

  // A new session gets a new id: two starts never share one session.
  runtime.dispatchNativeAction("start_or_stop_session");
  await runtime.settle();
  assert.equal(started.length, 2);
  assert.notEqual(started[0], started[1]);
});

test("quit_application stops the simulated transitions and keeps the state", async () => {
  const runtime = build();
  runtime.dispatchNativeAction("start_or_stop_session");
  const quitting = runtime.dispatchNativeAction("quit_application");
  assert.equal(quitting.sessionPhase, "starting");
  await runtime.settle();
  // The pending timer was cancelled, so the state never advanced.
  assert.equal(runtime.getRuntimeState().sessionPhase, "starting");
});
