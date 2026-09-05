import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Edges and corners the custom title bar exposes for resizing. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_DIRECTION = {
  n: "North",
  s: "South",
  e: "East",
  w: "West",
  ne: "NorthEast",
  nw: "NorthWest",
  se: "SouthEast",
  sw: "SouthWest",
} as const;

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let handle: Window | null = null;

// getCurrentWindow() reads the label out of Tauri's injected metadata, so it
// throws in the browser demo. Resolve it lazily and keep the browser a no-op.
function target(): Window | null {
  if (!inTauri) return null;
  if (!handle) {
    try {
      handle = getCurrentWindow();
    } catch {
      return null;
    }
  }
  return handle;
}

export const windowControls = {
  available: inTauri,

  async minimize(): Promise<void> {
    await target()?.minimize();
  },

  async toggleMaximize(): Promise<void> {
    await target()?.toggleMaximize();
  },

  async close(): Promise<void> {
    await target()?.close();
  },

  async isMaximized(): Promise<boolean> {
    return (await target()?.isMaximized()) ?? false;
  },

  async startResize(edge: ResizeEdge): Promise<void> {
    await target()?.startResizeDragging(RESIZE_DIRECTION[edge]);
  },

  /** Fires on every geometry change, which covers maximize and restore. */
  async onGeometryChange(handler: () => void): Promise<UnlistenFn> {
    const current = target();
    if (!current) return () => {};
    return current.onResized(() => handler());
  },
};
