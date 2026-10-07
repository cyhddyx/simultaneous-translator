import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MockRuntimeController,
  SUBTITLE_FONT_PX,
  applyRuntimeState,
  createInitialRuntimeState,
  runtimeErrorRows,
} from "../src/runtime.ts";
import {
  applyTranslatorEvent,
  selectSubtitleView,
  sessionCanReceive,
} from "../src/snapshot.ts";
import { createInitialSnapshot } from "../src/types.ts";

const EMITTED_AT = "2026-10-07T11:00:00.000Z";
const envelope = (revision, sessionId, payload) => ({
  revision,
  sessionId,
  emittedAt: EMITTED_AT,
  payload,
});
const sessionEvent = (revision, sessionId, patch) => ({
  type: "session",
  data: envelope(revision, sessionId, patch),
});
const captionEvent = (revision, sessionId, caption) => ({
  type: "caption",
  data: envelope(revision, sessionId, caption),
});
const settingsEvent = (revision, settings) => ({
  type: "settings",
  data: envelope(revision, null, settings),
});
const caption = (index, channel, translationText = `译文 ${index}`) => ({
  id: `c${index}`,
  sessionId: "s1",
  sequence: index,
  sourceText: `source ${index}`,
  translationText,
  status: "translated",
  createdAt: new Date(Date.UTC(2026, 9, 7, 11, 0, index)).toISOString(),
  channel,
});

test("a fresh subtitle window renders the waiting state", () => {
  const view = selectSubtitleView(createInitialSnapshot());

  assert.equal(view.sessionId, null);
  assert.equal(view.active, false);
  assert.equal(view.source, "");
  assert.equal(view.translation, "");
  assert.equal(view.current, null);
  assert.deepEqual(view.lines, []);
  assert.deepEqual(SUBTITLE_FONT_PX, { small: 15, medium: 19, large: 24 });
});

test("live lines and the three newest captions come from the shared reducer", () => {
  let snapshot = createInitialSnapshot();
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(1, "s1", { phase: "starting", sessionId: "s1" }),
  );
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(2, "s1", {
      phase: "listening",
      partialTranscript: "Hello everyone",
      partialTranslation: "各位好",
    }),
  );
  for (let index = 1; index <= 4; index += 1) {
    snapshot = applyTranslatorEvent(
      snapshot,
      captionEvent(2 + index, "s1", caption(index, index % 2 ? "listen" : "speak")),
    );
  }

  const view = selectSubtitleView(snapshot);
  assert.equal(view.active, true);
  assert.equal(view.sessionId, "s1");
  assert.equal(view.source, "Hello everyone");
  assert.equal(view.translation, "各位好");
  assert.deepEqual(
    view.lines.map((line) => line.id),
    ["c4", "c3", "c2"],
  );
  assert.equal(view.lines[0].channel, "speak");
  assert.equal(view.lines[0].translationText, "译文 4");
  assert.equal(view.lines[0].pending, false);
  assert.equal(view.current.id, "c4");
  assert.equal(view.current.sourceText, "source 4");

  // The limit is a parameter, and the live caption stays the newest one.
  assert.equal(selectSubtitleView(snapshot, 1).lines.length, 1);
  assert.deepEqual(selectSubtitleView(snapshot, 0).lines, []);
});

test("an in-flight caption is marked as pending, not as translated", () => {
  let snapshot = createInitialSnapshot();
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(1, "s1", { phase: "starting", sessionId: "s1" }),
  );
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(2, "s1", { phase: "listening" }),
  );
  snapshot = applyTranslatorEvent(
    snapshot,
    captionEvent(3, "s1", {
      ...caption(9, "listen"),
      translationText: undefined,
      status: "translating",
    }),
  );

  const view = selectSubtitleView(snapshot);
  assert.equal(view.current.pending, true);
  assert.equal(view.current.translationText, "");
  assert.equal(view.current.statusLabel, "正在翻译");
  assert.equal(view.lines[0].pending, true);
});

test("stale revisions and other sessions never reach the overlay", () => {
  let snapshot = createInitialSnapshot();
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(4, "s1", { phase: "starting", sessionId: "s1" }),
  );
  snapshot = applyTranslatorEvent(
    snapshot,
    sessionEvent(5, "s1", { phase: "listening", partialTranscript: "keep me" }),
  );

  const stale = applyTranslatorEvent(
    snapshot,
    sessionEvent(4, "s1", { partialTranscript: "stale" }),
  );
  assert.equal(stale, snapshot);
  assert.equal(selectSubtitleView(stale).source, "keep me");

  const foreign = sessionEvent(6, "s2", { partialTranscript: "other session" });
  assert.equal(sessionCanReceive(foreign, snapshot), false);
  assert.equal(applyTranslatorEvent(snapshot, foreign), snapshot);
  assert.equal(selectSubtitleView(snapshot).source, "keep me");
  assert.equal(selectSubtitleView(snapshot).sessionId, "s1");
});

test("the overlay reuses settings.subtitleSize instead of adding a setting", () => {
  let snapshot = createInitialSnapshot();
  snapshot = applyTranslatorEvent(
    snapshot,
    settingsEvent(1, { ...snapshot.settings, subtitleSize: "large" }),
  );
  assert.equal(snapshot.settings.subtitleSize, "large");
  assert.equal(SUBTITLE_FONT_PX[snapshot.settings.subtitleSize], 24);

  const small = applyTranslatorEvent(
    snapshot,
    settingsEvent(2, { ...snapshot.settings, subtitleSize: "small" }),
  );
  assert.equal(SUBTITLE_FONT_PX[small.settings.subtitleSize], 15);
});

test("a reloaded overlay rebuilds its data from a snapshot plus a subscription", () => {
  // No Tauri runtime here: the mock controller exposes the same three entry
  // points, so the wiring the overlay uses can be exercised in plain Node.
  const runtime = new MockRuntimeController({ connectDelayMs: 0 });
  const received = [];
  const unlisten = runtime.subscribeRuntimeState((state) => received.push(state));

  const toggled = runtime.dispatchNativeAction("toggle_subtitle_window");
  assert.equal(toggled.subtitleVisible, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].revision, toggled.revision);
  unlisten();
  assert.equal(runtime.dispatchNativeAction("toggle_subtitle_window").subtitleVisible, false);
  assert.equal(received.length, 1);

  // The overlay merges runtime updates by revision, exactly like the main
  // window: an older broadcast must not roll the status text back.
  const older = { ...toggled, revision: toggled.revision - 1, trayStatus: "not_started" };
  assert.equal(applyRuntimeState(toggled, older), toggled);

  // Subtitles are reconstructed from the snapshot the API returns, not from a
  // replayed in-memory event stream. `getSnapshot()` reattaches to the live
  // session id, after which the regular events are accepted again.
  const restoredSnapshot = createInitialSnapshot();
  restoredSnapshot.session = {
    ...restoredSnapshot.session,
    phase: "listening",
    sessionId: "s7",
  };
  const reattached = applyTranslatorEvent(
    restoredSnapshot,
    sessionEvent(1, "s7", { partialTranscript: "restored" }),
  );
  assert.equal(selectSubtitleView(reattached).source, "restored");

  // Without that reattach the first event of a session must be "starting".
  const coldStart = applyTranslatorEvent(
    createInitialSnapshot(),
    sessionEvent(2, "s8", { phase: "starting", sessionId: "s8" }),
  );
  assert.equal(selectSubtitleView(coldStart).sessionId, "s8");
});

test("the overlay error hint keeps audio and network apart", () => {
  const idle = createInitialRuntimeState();
  const rows = runtimeErrorRows({
    ...idle,
    revision: 2,
    audioHealth: "failed",
    networkHealth: "failed",
    trayStatus: "network_error",
  }).filter((row) => row.service === "audio" || row.service === "network");

  assert.deepEqual(
    rows.map((row) => row.key.split(":")[0]),
    ["audio", "network"],
  );
  assert.equal(rows[0].title, "音频异常");
  assert.equal(rows[1].title, "网络异常");

  // A configuration-only failure has no audio/network row in the overlay.
  const configurationOnly = runtimeErrorRows({
    ...idle,
    revision: 3,
    lastError: {
      id: "e9",
      service: "configuration",
      code: "invalid_configuration",
      message: "请至少启用一个音频通道。",
      recoverable: false,
      sessionId: null,
    },
  }).filter((row) => row.service === "audio" || row.service === "network");
  assert.deepEqual(configurationOnly, []);
});
