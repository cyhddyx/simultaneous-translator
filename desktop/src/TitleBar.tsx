import { useEffect, useState, type MouseEvent } from "react";
import { Copy, Languages, Minus, Square, X } from "lucide-react";

import { windowControls, type ResizeEdge } from "./window";

// An undecorated window loses the native frame, so the edges have to be redrawn
// as hit targets that hand the gesture back to the window manager.
const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

interface TitleBarProps {
  runtimeLabel: string;
}

export function TitleBar({ runtimeLabel }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!windowControls.available) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void windowControls.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    };

    sync();
    void windowControls.onGeometryChange(sync).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const beginResize = (edge: ResizeEdge) => (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void windowControls.startResize(edge);
  };

  return (
    <>
      <div className="titlebar" data-tauri-drag-region="deep">
        <span className="titlebar__mark" aria-hidden="true">
          <Languages size={14} />
        </span>
        <span className="titlebar__title">同传翻译</span>
        <span className="titlebar__runtime">{runtimeLabel}</span>

        {windowControls.available && (
          <div className="window-controls">
            <button
              className="window-control"
              type="button"
              onClick={() => void windowControls.minimize()}
              aria-label="最小化"
              title="最小化"
            >
              <Minus size={15} aria-hidden="true" />
            </button>
            <button
              className="window-control"
              type="button"
              onClick={() => void windowControls.toggleMaximize()}
              aria-label={maximized ? "向下还原" : "最大化"}
              title={maximized ? "向下还原" : "最大化"}
            >
              {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
            </button>
            <button
              className="window-control window-control--close"
              type="button"
              onClick={() => void windowControls.close()}
              aria-label="关闭"
              title="关闭"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {windowControls.available && !maximized && (
        <div className="resize-handles" aria-hidden="true">
          {RESIZE_EDGES.map((edge) => (
            <span
              key={edge}
              className={`resize-handle resize-handle--${edge}`}
              onMouseDown={beginResize(edge)}
            />
          ))}
        </div>
      )}
    </>
  );
}
