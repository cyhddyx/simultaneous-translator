import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCaptionHistoryExport,
  captionClockRange,
  captionDateKey,
  captionDateLabel,
  groupCaptionsByDate,
  mergeCaptionHistory,
} from "../src/history.ts";

/** Local-time constructor keeps the assertions timezone independent. */
const at = (year, month, day, hour, minute, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).toISOString();

let nextSequence = 0;

function caption(patch = {}) {
  nextSequence += 1;
  return {
    id: `caption-${nextSequence}`,
    sessionId: "session-a",
    sequence: nextSequence,
    sourceText: "source text",
    translationText: "translated text",
    status: "translated",
    createdAt: at(2026, 10, 18, 9, 0),
    channel: "listen",
    ...patch,
  };
}

test("captionDateKey uses the local calendar day, not UTC", () => {
  assert.equal(captionDateKey(at(2026, 10, 18, 0, 5)), "2026-10-18");
  assert.equal(captionDateKey(at(2026, 10, 18, 23, 55)), "2026-10-18");
  assert.equal(captionDateKey(at(2026, 1, 2, 12, 0)), "2026-01-02");
  assert.equal(captionDateKey("not a date"), "unknown");
  assert.equal(captionDateLabel("unknown"), "未标记日期");
  assert.match(captionDateLabel("2026-10-18"), /2026/);
});

test("mergeCaptionHistory keeps one row per caption and applies newer updates", () => {
  const first = caption({ id: "c1", translationText: "旧译文", createdAt: at(2026, 10, 18, 9, 0) });
  const update = { ...first, translationText: "新译文", status: "translated" };
  const merged = mergeCaptionHistory([first], [update]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].translationText, "新译文");
  assert.equal(merged[0].createdAt, first.createdAt, "creation time must not move with an update");
});

test("groupCaptionsByDate returns days newest first and sessions newest first", () => {
  const yesterday = caption({ id: "y1", sessionId: "s-yesterday", createdAt: at(2026, 10, 17, 20, 0) });
  const yesterdayLater = caption({ id: "y2", sessionId: "s-yesterday", createdAt: at(2026, 10, 17, 20, 5) });
  const todayMorning = caption({ id: "t1", sessionId: "s-morning", createdAt: at(2026, 10, 18, 8, 0) });
  const todayEvening = caption({ id: "t2", sessionId: "s-evening", createdAt: at(2026, 10, 18, 18, 0) });
  const unknown = caption({ id: "u1", createdAt: "bad timestamp" });

  const days = groupCaptionsByDate([yesterday, todayMorning, yesterdayLater, todayEvening, unknown]);

  assert.deepEqual(days.map((day) => day.key), ["2026-10-18", "2026-10-17", "unknown"]);
  assert.deepEqual(days[0].captions.map((item) => item.id), ["t2", "t1"]);
  assert.deepEqual(days[0].sessions.map((session) => session.key), ["s-evening", "s-morning"]);
  assert.deepEqual(days[0].sessions.map((session) => session.index), [2, 1]);
  assert.deepEqual(days[1].sessions[0].captions.map((item) => item.id), ["y2", "y1"]);
  assert.equal(days[1].sessions[0].startedAt, yesterday.createdAt);
  assert.equal(days[1].sessions[0].endedAt, yesterdayLater.createdAt);
});

test("captionClockRange compresses a one-caption session to a single time", () => {
  const single = caption({ id: "one", sessionId: "s-single", createdAt: at(2026, 10, 18, 9, 0, 7) });
  const first = caption({ id: "first", sessionId: "s-longer", createdAt: at(2026, 10, 18, 10, 0, 0) });
  const last = caption({ id: "last", sessionId: "s-longer", createdAt: at(2026, 10, 18, 10, 30, 0) });
  const sessions = groupCaptionsByDate([single, last, first])[0].sessions;
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  assert.match(captionClockRange(byKey.get("s-single")), /^09:00:07$/);
  assert.match(captionClockRange(byKey.get("s-longer")), /^10:00:00 - 10:30:00$/);
});

test("one-day export is chronological, keeps session headings and only that day", () => {
  const early = caption({
    id: "e1", sessionId: "s1", createdAt: at(2026, 10, 18, 9, 0, 1),
    sourceText: "早上好", translationText: "Good morning", channel: "listen",
  });
  const late = caption({
    id: "l1", sessionId: "s2", createdAt: at(2026, 10, 18, 15, 30, 2),
    sourceText: "下午见", translationText: "See you", channel: "speak",
  });
  const otherDay = caption({
    id: "o1", sessionId: "s3", createdAt: at(2026, 10, 17, 9, 0, 0),
    sourceText: "昨天的内容",
  });

  const exported = buildCaptionHistoryExport([late, early, otherDay], "2026-10-18");

  assert.equal(exported.filename, "会话历史-2026-10-18.txt");
  assert.ok(exported.text.startsWith("\uFEFF会话历史"));
  assert.ok(exported.text.includes("共 2 条字幕 · 2 段会话"));
  assert.ok(exported.text.includes("=== 2026"));
  assert.ok(exported.text.includes("--- 会话 1 · 09:00:01 · 1 条 ---"));
  assert.ok(exported.text.includes("--- 会话 2 · 15:30:02 · 1 条 ---"));
  assert.ok(exported.text.includes("[09:00:01] 对方\n原文：早上好\n译文：Good morning"));
  assert.ok(exported.text.includes("[15:30:02] 我说\n原文：下午见\n译文：See you"));
  assert.ok(!exported.text.includes("昨天的内容"), "a different day must not leak into the export");
  assert.ok(
    exported.text.indexOf("[09:00:01]") < exported.text.indexOf("[15:30:02]"),
    "export rows must be chronological",
  );
});

test("export-all groups every day chronologically in one file", () => {
  const yesterday = caption({ id: "y", createdAt: at(2026, 10, 17, 21, 0), sourceText: "昨天" });
  const today = caption({ id: "t", createdAt: at(2026, 10, 18, 8, 0), sourceText: "今天" });

  const exported = buildCaptionHistoryExport([today, yesterday]);

  assert.match(exported.filename, /^会话历史-全部-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.ok(exported.text.includes("全部记录"));
  assert.ok(exported.text.includes("2 天"));
  assert.ok(exported.text.indexOf("昨天") < exported.text.indexOf("今天"));
  assert.ok(exported.text.indexOf("=== 2026") < exported.text.indexOf("=== 2026", exported.text.indexOf("=== 2026") + 1));
});

test("pending and failed captions are exported with their status text", () => {
  const failed = caption({
    id: "f1", createdAt: at(2026, 10, 18, 9, 0), status: "failed",
    translationText: undefined, errorMessage: "翻译服务超时",
  });
  const pending = caption({
    id: "p1", createdAt: at(2026, 10, 18, 9, 1), status: "timed_out",
    translationText: undefined, errorMessage: undefined,
  });

  const exported = buildCaptionHistoryExport([failed, pending], "2026-10-18");

  assert.ok(exported.text.includes("译文：翻译服务超时"));
  assert.ok(exported.text.includes("译文：翻译超时"));
});

test("export refuses empty selections instead of writing a header-only file", () => {
  assert.throws(() => buildCaptionHistoryExport([]), /还没有可导出的会话记录/);
  assert.throws(
    () => buildCaptionHistoryExport([caption({ createdAt: at(2026, 10, 17, 9, 0) })], "2026-10-18"),
    /所选日期没有可导出的会话记录/,
  );
});
