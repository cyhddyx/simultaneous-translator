import type { CaptionSegment } from "./types";

/**
 * Session-history model shared by the history dialog and the export writer.
 *
 * The main screen keeps a compact preview of the newest captions, while the
 * complete archive stays in memory (and in IndexedDB, see `tauri.ts`).  These
 * helpers only read captions, so they are pure and can be unit tested from
 * Node (`desktop/tests/history.test.mjs`) without a DOM.
 */

export interface CaptionHistorySession {
  /** `CaptionSegment.sessionId`, or a synthetic key for legacy records. */
  key: string;
  /** 1-based position inside its day, chronological. */
  index: number;
  startedAt: string;
  endedAt: string;
  /** Newest first, matching the dialog's browse order. */
  captions: CaptionSegment[];
}

export interface CaptionDay {
  key: string;
  label: string;
  /** Newest first, matching the dialog's browse order. */
  captions: CaptionSegment[];
  /** Newest session first. */
  sessions: CaptionHistorySession[];
}

export interface HistoryExport {
  text: string;
  filename: string;
}

const dayFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "long", day: "numeric", weekday: "short",
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** Use the computer's local calendar, including around UTC midnight. */
export function captionDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function captionDateLabel(key: string): string {
  if (key === "unknown") return "未标记日期";
  const date = new Date(`${key}T12:00:00`);
  return Number.isNaN(date.getTime()) ? key : dayFormatter.format(date);
}

/** Wall-clock time of one caption, or "时间未知" for malformed timestamps. */
export function captionClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : timeFormatter.format(date);
}

/** "14:03:12 - 14:31:05" for one session; the export header uses it. */
export function captionClockRange(session: CaptionHistorySession): string {
  const start = captionClock(session.startedAt);
  const end = captionClock(session.endedAt);
  return start === end ? start : `${start} - ${end}`;
}

function compareCaptions(left: CaptionSegment, right: CaptionSegment): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime) ||
    left.sequence - right.sequence || left.id.localeCompare(right.id);
}

/**
 * Later sources contain updates for the same caption, never duplicate rows.
 * The original creation time is authoritative so an edited caption cannot
 * jump to the end of the history when its translation arrives.
 */
export function mergeCaptionHistory(...sources: CaptionSegment[][]): CaptionSegment[] {
  const byId = new Map<string, CaptionSegment>();
  for (const source of sources) {
    for (const caption of source) {
      const previous = byId.get(caption.id);
      byId.set(caption.id, previous
        ? { ...previous, ...caption, createdAt: previous.createdAt }
        : caption);
    }
  }
  return [...byId.values()].sort(compareCaptions);
}

function groupSessions(captions: CaptionSegment[]): CaptionHistorySession[] {
  const buckets = new Map<string, CaptionSegment[]>();
  for (const caption of captions) {
    const key = caption.sessionId || "unknown-session";
    const bucket = buckets.get(key) ?? [];
    bucket.push(caption);
    buckets.set(key, bucket);
  }
  // Number sessions chronologically so "会话 1" is always the first session of
  // the day, even though the dialog lists the newest session at the top.
  const chronological = [...buckets.entries()]
    .map(([key, items]) => {
      const ordered = [...items].sort(compareCaptions);
      return {
        key,
        index: 0,
        startedAt: ordered[0].createdAt,
        endedAt: ordered[ordered.length - 1].createdAt,
        captions: ordered,
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.startedAt);
      const rightTime = Date.parse(right.startedAt);
      return (Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime) -
        (Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime) ||
        left.key.localeCompare(right.key);
    })
    .map((session, index) => ({ ...session, index: index + 1 }));
  return chronological
    .map((session) => ({ ...session, captions: [...session.captions].reverse() }))
    .reverse();
}

/** Newest day and newest caption first for browsing. */
export function groupCaptionsByDate(captions: CaptionSegment[]): CaptionDay[] {
  const grouped = new Map<string, CaptionSegment[]>();
  for (const caption of captions) {
    const key = captionDateKey(caption.createdAt);
    const bucket = grouped.get(key) ?? [];
    bucket.push(caption);
    grouped.set(key, bucket);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left === "unknown" ? 1 : right === "unknown" ? -1 : right.localeCompare(left))
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => compareCaptions(b, a));
      return {
        key,
        label: captionDateLabel(key),
        captions: sorted,
        sessions: groupSessions(sorted),
      };
    });
}

const statusNotes: Record<CaptionSegment["status"], string> = {
  queued: "等待翻译",
  translating: "正在翻译",
  translated: "译文为空",
  timed_out: "翻译超时",
  failed: "翻译失败",
  dropped: "为保持实时性已跳过",
};

function translationForExport(caption: CaptionSegment): string {
  return caption.translationText ?? caption.errorMessage ?? statusNotes[caption.status];
}

function channelForExport(caption: CaptionSegment): string {
  if (caption.channel === "speak") return "我说";
  if (caption.channel === "listen") return "对方";
  return "字幕";
}

function exportRow(caption: CaptionSegment): string {
  return `[${captionClock(caption.createdAt)}] ${channelForExport(caption)}\n`
    + `原文：${caption.sourceText}\n`
    + `译文：${translationForExport(caption)}`;
}

function exportDay(day: CaptionDay): string {
  // `sessions` is newest first; chronological index numbers come from
  // `groupSessions`, so reversing gives "会话 1 ... 会话 N" in export order.
  const sessions = [...day.sessions].reverse();
  const body = sessions.map((session) => {
    const heading = `--- 会话 ${session.index} · ${captionClockRange(session)} · ${session.captions.length} 条 ---`;
    const rows = [...session.captions].reverse().map(exportRow);
    return `${heading}\n\n${rows.join("\n\n")}`;
  });
  return `=== ${day.label} · ${day.captions.length} 条字幕 · ${sessions.length} 段会话 ===\n\n`
    + body.join("\n\n");
}

/**
 * Build a complete, chronological text export.  `dateKey` limits the file to
 * one local calendar day ("今天" is the dialog's default); omitting it exports
 * every saved day.  A BOM keeps Chinese readable in desktop text editors.
 */
export function buildCaptionHistoryExport(captions: CaptionSegment[], dateKey?: string): HistoryExport {
  const days = groupCaptionsByDate(captions)
    .filter((day) => !dateKey || day.key === dateKey)
    .reverse();
  if (!days.length) {
    throw new Error(dateKey ? "所选日期没有可导出的会话记录。" : "还没有可导出的会话记录。");
  }
  const count = days.reduce((sum, day) => sum + day.captions.length, 0);
  const sessionCount = days.reduce((sum, day) => sum + day.sessions.length, 0);
  const now = new Date();
  const title = dateKey ? `会话历史 · ${captionDateLabel(dateKey)}` : "会话历史 · 全部记录";
  const summary = dateKey
    ? `共 ${count} 条字幕 · ${sessionCount} 段会话`
    : `共 ${count} 条字幕 · ${sessionCount} 段会话 · ${days.length} 天`;
  return {
    filename: dateKey ? `会话历史-${dateKey}.txt` : `会话历史-全部-${captionDateKey(now)}.txt`,
    text: `\uFEFF${title}\n`
      + `导出时间：${dateTimeFormatter.format(now)}\n`
      + `${summary}\n\n`
      + `${days.map(exportDay).join("\n\n\n")}\n`,
  };
}
