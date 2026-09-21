import { useEffect, useState, type MouseEvent } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

import { windowControls, type ResizeEdge } from "./window";

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ResizeHandles() {
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

  if (!windowControls.available || maximized) {
    return null;
  }

  return (
    <div className="resize-handles" aria-hidden="true">
      {RESIZE_EDGES.map((edge) => (
        <span
          key={edge}
          className={`resize-handle resize-handle--${edge}`}
          onMouseDown={beginResize(edge)}
        />
      ))}
    </div>
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!windowControls.available) {
      const syncFullscreen = () => {
        const fullscreen = Boolean(document.fullscreenElement);
        setMaximized(fullscreen);
        document.documentElement.dataset.windowMaximized = String(fullscreen);
      };
      document.addEventListener("fullscreenchange", syncFullscreen);
      return () => {
        document.removeEventListener("fullscreenchange", syncFullscreen);
        delete document.documentElement.dataset.windowMaximized;
      };
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void windowControls.isMaximized().then((value) => {
        if (!disposed) {
          setMaximized(value);
          document.documentElement.dataset.windowMaximized = String(value);
        }
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
      delete document.documentElement.dataset.windowMaximized;
    };
  }, []);

  const handleMinimize = () => {
    if (windowControls.available) {
      void windowControls.minimize();
    }
  };

  const handleToggleMaximize = () => {
    if (windowControls.available) {
      void windowControls.toggleMaximize();
    } else {
      // Browser fallback: toggle fullscreen
      if (!document.fullscreenElement) {
        void document.documentElement
          .requestFullscreen?.()
          .then(() => setMaximized(true));
      } else {
        void document.exitFullscreen?.().then(() => setMaximized(false));
      }
    }
  };

  const handleClose = () => {
    if (windowControls.available) {
      void windowControls.close();
    } else {
      window.close();
    }
  };

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        className="window-control"
        type="button"
        onClick={handleMinimize}
        aria-label="最小化"
        title="最小化"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        className="window-control"
        type="button"
        onClick={handleToggleMaximize}
        aria-label={maximized ? "向下还原" : "最大化"}
        title={maximized ? "向下还原" : "最大化"}
      >
        {maximized ? (
          <Copy size={12} aria-hidden="true" />
        ) : (
          <Square size={11} aria-hidden="true" />
        )}
      </button>
      <button
        className="window-control window-control--close"
        type="button"
        onClick={handleClose}
        aria-label="关闭"
        title="关闭"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
