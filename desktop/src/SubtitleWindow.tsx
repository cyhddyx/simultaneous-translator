import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CircleAlert,
  Eye,
  Headphones,
  LoaderCircle,
  MicOff,
  Pin,
  PinOff,
  TriangleAlert,
  VolumeX,
  WifiOff,
  X,
} from "./PixelIcons";

import { ResizeHandles } from "./TitleBar";
import { windowControls } from "./window";
import { translatorApi } from "./tauri";
import {
  SUBTITLE_FONT_PX,
  applyRuntimeState,
  runtimeErrorRows,
  trayStatusLabel,
} from "./runtime";
import { applyTranslatorEvent, errorMessage, selectSubtitleView } from "./snapshot";
import {
  createInitialSnapshot,
  type AppSnapshot,
  type RuntimeState,
  type TranslatorEvent,
} from "./types";

/**
 * Subtitle overlay body (window label `subtitle`, docs/subtitle-window.md §5).
 *
 * It renders subtitles only: no settings entry, no session controls, no history
 * management. Captions come from the existing `translatorApi.subscribe()` /
 * `getSnapshot()` pair and the existing reducer — this window never opens a
 * second subscription protocol or its own revision counter.
 */
export default function SubtitleWindow() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() =>
    createInitialSnapshot(),
  );
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const [pinned, setPinned] = useState(true);
  // Browser demo only: there is no native window to hide, so the close button
  // swaps in a placeholder and mirrors `subtitleVisible = false`.
  const [browserHidden, setBrowserHidden] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const runtimeUnsubscribeRef = useRef<(() => void) | null>(null);

  // `transparent(true)` needs a transparent root; the class lives only while
  // this window is mounted (docs/subtitle-window.md §6).
  useLayoutEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.add("subtitle-root");
    body.classList.add("subtitle-root");
    return () => {
      root.classList.remove("subtitle-root");
      body.classList.remove("subtitle-root");
    };
  }, []);

  const applyEvent = useCallback((event: TranslatorEvent) => {
    setSnapshot((current) => applyTranslatorEvent(current, event));
  }, []);

  const applyRuntimeEvent = useCallback((incoming: RuntimeState) => {
    setRuntime((current) => applyRuntimeState(current, incoming));
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = async () => {
      try {
        const unsubscribe = await translatorApi.subscribe(applyEvent);
        if (disposed) {
          unsubscribe();
          return;
        }
        unsubscribeRef.current = unsubscribe;
        // A fresh WebView (first open or reload) restores subtitles from the
        // snapshot instead of relying on replayed events.
        const initial = await translatorApi.getSnapshot();
        if (!disposed) {
          setSnapshot((current) =>
            initial.revision >= current.revision ? initial : current,
          );
        }
      } catch (error) {
        if (!disposed) {
          setBootError(errorMessage(error, "无法连接翻译引擎。"));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void connect();
    return () => {
      disposed = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [applyEvent]);

  useEffect(() => {
    let disposed = false;

    const connect = async () => {
      try {
        const unsubscribe =
          await translatorApi.subscribeRuntimeState(applyRuntimeEvent);
        if (disposed) {
          unsubscribe();
          return;
        }
        runtimeUnsubscribeRef.current = unsubscribe;
        const initial = await translatorApi.getRuntimeState();
        if (!disposed) {
          setRuntime((current) => applyRuntimeState(current, initial));
        }
      } catch {
        // Status text simply stays unavailable; subtitles keep working.
      }
    };

    void connect();
    return () => {
      disposed = true;
      runtimeUnsubscribeRef.current?.();
      runtimeUnsubscribeRef.current = null;
    };
  }, [applyRuntimeEvent]);

  const view = selectSubtitleView(snapshot);
  const size = snapshot.settings.subtitleSize;
  const trayStatus = runtime?.trayStatus ?? null;
  const statusText = trayStatus ? trayStatusLabel(trayStatus) : "状态不可用";
  const errorRows = runtimeErrorRows(runtime)
    .filter((row) => row.service === "audio" || row.service === "network")
    .filter((row) => !dismissedErrors.includes(row.key));

  const sourceLine =
    view.source ||
    view.current?.sourceText ||
    (loading ? "正在加载…" : view.active ? "正在聆听…" : "等待会话开始");
  const translationLine = view.translation || view.current?.translationText || "";
  const translationPending = !translationLine && Boolean(view.current?.pending);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void windowControls.setAlwaysOnTop(next);
  };

  /**
   * Native close always goes through the window controls: Rust intercepts
   * `CloseRequested`, hides the window and flips `subtitleVisible`. In the
   * browser `windowControls.close()` is a no-op, so the same outcome is
   * mirrored by toggling the runtime state.
   */
  const syncSubtitleVisibility = (target: boolean) => {
    if (!runtime || runtime.subtitleVisible === target) return;
    void translatorApi
      .dispatchNativeAction("toggle_subtitle_window")
      .then((state) => setRuntime((current) => applyRuntimeState(current, state)))
      .catch(() => {
        // The close button must never throw; the status text stays as it is.
      });
  };

  const closeWindow = () => {
    if (windowControls.available) {
      void windowControls.close();
      return;
    }
    setBrowserHidden(true);
    syncSubtitleVisibility(false);
  };

  const restoreWindow = () => {
    setBrowserHidden(false);
    syncSubtitleVisibility(true);
  };

  if (browserHidden) {
    return (
      <main
        className="subtitle-window subtitle-window--hidden"
        aria-label="字幕悬浮窗"
      >
        <ResizeHandles />
        <header className="subtitle-window__bar" data-tauri-drag-region>
          <span className="subtitle-window__status subtitle-window__status--unavailable">
            <span className="subtitle-window__dot" aria-hidden="true" />
            <span>已隐藏</span>
          </span>
          <button
            className="subtitle-window__restore"
            type="button"
            onClick={restoreWindow}
            aria-label="重新显示字幕悬浮窗"
            title="重新显示字幕悬浮窗"
          >
            <Eye size={13} aria-hidden="true" />
            重新显示
          </button>
        </header>
        <section className="subtitle-window__stage">
          <p className="subtitle-window__hint">
            浏览器演示：字幕悬浮窗已隐藏（桌面版会隐藏原生窗口）。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="subtitle-window" aria-label="字幕悬浮窗">
      <ResizeHandles />

      <header
        className="subtitle-window__bar"
        data-tauri-drag-region
        title="按住拖动字幕窗口"
      >
        <span
          className={
            trayStatus
              ? `subtitle-window__status subtitle-window__status--${trayStatus}`
              : "subtitle-window__status subtitle-window__status--unavailable"
          }
          role="status"
        >
          <span className="subtitle-window__dot" aria-hidden="true" />
          <span>{statusText}</span>
        </span>

        <span className="subtitle-window__flags">
          {runtime && runtime.speakMuted && view.active && (
            <span className="subtitle-window__flag subtitle-window__flag--muted">
              <VolumeX size={12} aria-hidden="true" />
              已静音
            </span>
          )}
          {runtime && view.active && !runtime.listenEnabled && (
            <span className="subtitle-window__flag">
              <Headphones size={12} aria-hidden="true" />
              收听关
            </span>
          )}
          {runtime && view.active && !runtime.speakEnabled && (
            <span className="subtitle-window__flag">
              <MicOff size={12} aria-hidden="true" />
              发言关
            </span>
          )}
        </span>

        <span className="subtitle-window__actions">
          <button
            className="subtitle-window__button"
            type="button"
            onClick={togglePin}
            aria-pressed={pinned}
            aria-label={pinned ? "取消置顶" : "窗口置顶"}
            title={pinned ? "取消置顶" : "窗口置顶"}
          >
            {pinned ? (
              <Pin size={13} aria-hidden="true" />
            ) : (
              <PinOff size={13} aria-hidden="true" />
            )}
          </button>
          <button
            className="subtitle-window__button subtitle-window__button--close"
            type="button"
            onClick={closeWindow}
            aria-label="关闭字幕窗口"
            title="关闭字幕窗口"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </header>

      <section className="subtitle-window__stage">
        <p className="subtitle-window__source">{sourceLine}</p>
        <p
          className={
            translationLine
              ? "subtitle-window__translation"
              : "subtitle-window__translation is-placeholder"
          }
          style={{ fontSize: `${SUBTITLE_FONT_PX[size]}px` }}
          aria-live="polite"
        >
          {translationLine ? (
            translationLine
          ) : translationPending && view.current ? (
            <>
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              {view.current.statusLabel}
            </>
          ) : (
            "等待翻译"
          )}
        </p>
      </section>

      {errorRows.map((row) => (
        <div
          key={row.key}
          className={`subtitle-window__error subtitle-window__error--${row.service}${
            row.severity === "warning" ? " is-warning" : ""
          }`}
          role={row.severity === "warning" ? "status" : "alert"}
        >
          {row.service === "audio" ? (
            <VolumeX size={15} aria-hidden="true" />
          ) : (
            <WifiOff size={15} aria-hidden="true" />
          )}
          <span>
            <strong>{row.title}</strong>
            <em>{row.message}</em>
          </span>
          <button
            className="subtitle-window__button"
            type="button"
            onClick={() =>
              setDismissedErrors((current) => [...current, row.key])
            }
            aria-label={`关闭${row.title}提示`}
            title="关闭提示"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}

      {bootError && (
        <div className="subtitle-window__error subtitle-window__error--system" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>
            <strong>无法连接翻译引擎</strong>
            <em>{bootError}</em>
          </span>
          <button
            className="subtitle-window__button"
            type="button"
            onClick={() => setBootError(null)}
            aria-label="关闭错误提示"
            title="关闭提示"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {!runtime && !bootError && (
        <div className="subtitle-window__hint" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          运行时状态不可用
        </div>
      )}
    </main>
  );
}
