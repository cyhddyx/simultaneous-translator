import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Download,
  LoaderCircle,
  X,
} from "./PixelIcons";
import { captionStatusLabel, formatCaptionTime } from "./snapshot";
import {
  captionDateKey,
  captionClockRange,
  groupCaptionsByDate,
} from "./history";
import type { CaptionSegment } from "./types";

/**
 * Full-width archive dialog: every saved caption, grouped by local calendar
 * day and by realtime session, with per-day and complete text exports.
 * The main screen only keeps a compact preview (see `RECENT_CAPTION_LIMIT`).
 */
export function HistoryDialog({
  captions,
  onClose,
  onExport,
  onExportAll,
}: {
  captions: CaptionSegment[];
  onClose: () => void;
  onExport: (dateKey: string) => string | void | Promise<string | void>;
  onExportAll: () => string | void | Promise<string | void>;
}) {
  const days = useMemo(() => groupCaptionsByDate(captions), [captions]);
  const todayKey = captionDateKey(new Date());
  const [selectedDate, setSelectedDate] = useState(
    () => days.find((day) => day.key === todayKey)?.key ?? days[0]?.key ?? "",
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"day" | "all" | null>(null);
  const selectedDay = days.find((day) => day.key === selectedDate);
  const sessionCount = days.reduce((sum, day) => sum + day.sessions.length, 0);
  const lastSaved = captions.reduce((latest, caption) => {
    const time = Date.parse(caption.createdAt);
    return Number.isNaN(time) ? latest : Math.max(latest, time);
  }, 0);

  useEffect(() => {
    if (days.length && !days.some((day) => day.key === selectedDate)) {
      setSelectedDate(days[0].key);
    }
  }, [days, selectedDate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const runExport = async (kind: "day" | "all") => {
    if (exporting) return;
    setExporting(kind);
    setFeedback(null);
    try {
      const result = kind === "day" && selectedDay
        ? await onExport(selectedDay.key)
        : await onExportAll();
      setFeedback(result ?? (kind === "day" && selectedDay
        ? `已导出 ${selectedDay.label} 的 ${selectedDay.captions.length} 条记录`
        : `已导出全部 ${captions.length} 条记录`));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "导出失败，请重试。");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div
      className="modal-backdrop history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-dialog-title"
      >
        <header className="history-dialog__header">
          <div>
            <p className="eyebrow">TRANSLATION ARCHIVE</p>
            <h2 id="history-dialog-title">会话历史</h2>
            <p className="history-dialog__subtitle">按日期浏览并导出完整字幕记录</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭会话历史">
            <X size={16} />
          </button>
        </header>

        {days.length ? (
          <div className="history-dialog__body">
            <nav className="history-dialog__date-panel" aria-label="按日期筛选会话历史">
              <div className="history-dialog__panel-heading">
                <p className="history-dialog__section-label">记录日期</p>
                <p className="history-dialog__date-summary">
                  {days.length} 天 · {sessionCount} 段会话 · {captions.length} 条
                </p>
              </div>
              <div className="history-dialog__dates">
                {days.map((day) => {
                  const today = day.key === todayKey;
                  return (
                    <button
                      key={day.key}
                      type="button"
                      className={`history-date${day.key === selectedDate ? " is-selected" : ""}`}
                      aria-pressed={day.key === selectedDate}
                      onClick={() => {
                        setSelectedDate(day.key);
                        setFeedback(null);
                      }}
                    >
                      <CalendarDays size={16} aria-hidden="true" />
                      <span className="history-date__copy">
                        <strong>{today ? "今天" : day.key}</strong>
                        <small title={day.label}>
                          {today ? `${day.key} · ` : ""}
                          {day.captions.length} 条
                          {day.sessions.length > 1 ? ` · ${day.sessions.length} 段` : ""}
                        </small>
                      </span>
                      <span className="history-date__count">{day.captions.length}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            <section
              className="history-dialog__day"
              aria-label={selectedDay?.label ?? "所选日期的会话记录"}
            >
              {selectedDay && (
                <>
                  <header className="history-dialog__day-header">
                    <div>
                      <h3>{selectedDay.label}</h3>
                      <p>
                        {selectedDay.captions.length} 条字幕记录
                        {selectedDay.sessions.length > 1
                          ? ` · ${selectedDay.sessions.length} 段会话`
                          : ""}
                      </p>
                    </div>
                    {selectedDay.key === todayKey && (
                      <span className="history-dialog__today">今天</span>
                    )}
                  </header>
                  <ol className="history-sessions" aria-label="所选日期的会话历史">
                    {selectedDay.sessions.map((session) => (
                      <li key={session.key} className="history-session">
                        <header className="history-session__header">
                          <span className="history-session__name">会话 {session.index}</span>
                          <time className="history-session__range" dateTime={session.startedAt}>
                            {captionClockRange(session)}
                          </time>
                          <span className="history-session__count">{session.captions.length} 条</span>
                        </header>
                        <ol className="caption-history history-dialog__captions">
                          {session.captions.map((caption) => (
                            <li key={caption.id} className="caption-history__item">
                              <time dateTime={caption.createdAt}>
                                {formatCaptionTime(caption.createdAt)}
                                {caption.channel && (
                                  <em className="channel-chip">
                                    {caption.channel === "speak" ? "我说" : "对方"}
                                  </em>
                                )}
                              </time>
                              <div className="caption-history__content">
                                <p className="history-source">{caption.sourceText}</p>
                                <p
                                  className={
                                    caption.status === "translated"
                                      ? "history-translation"
                                      : "history-translation is-pending"
                                  }
                                >
                                  {caption.translationText ??
                                    caption.errorMessage ??
                                    captionStatusLabel(caption)}
                                </p>
                              </div>
                              <CaptionStatus caption={caption} />
                            </li>
                          ))}
                        </ol>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          </div>
        ) : (
          <div className="history-dialog__empty">
            <CalendarDays size={30} aria-hidden="true" />
            <strong>还没有保存的会话记录</strong>
            <span>完成同传后，字幕会自动按日期保存在这里。</span>
          </div>
        )}

        <footer className="history-dialog__footer">
          <div className="history-dialog__feedback" role="status">
            {feedback ?? (captions.length
              ? `完整历史共 ${captions.length} 条字幕${lastSaved
                ? ` · 最近保存 ${new Date(lastSaved).toLocaleString("zh-CN", { hour12: false })}`
                : ""}`
              : "历史记录会按日期自动归档")}
          </div>
          <div className="history-dialog__actions">
            <button className="button button--secondary" type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void runExport("all")}
              disabled={!captions.length || exporting !== null}
            >
              {exporting === "all"
                ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
                : <Download size={15} />}
              导出全部
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => void runExport("day")}
              disabled={!selectedDay || exporting !== null}
            >
              {exporting === "day"
                ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
                : <Download size={15} />}
              导出这一天
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function CaptionStatus({ caption }: { caption: CaptionSegment }) {
  if (caption.status === "translated") {
    return <span className="caption-state caption-state--translated"><CheckCircle2 size={14} aria-hidden="true" />已翻译</span>;
  }
  if (caption.status === "translating" || caption.status === "queued") {
    return <span className="caption-state caption-state--working"><LoaderCircle size={14} className="spin" aria-hidden="true" />{captionStatusLabel(caption)}</span>;
  }
  return <span className="caption-state caption-state--error"><CircleAlert size={14} aria-hidden="true" />{captionStatusLabel(caption)}</span>;
}
