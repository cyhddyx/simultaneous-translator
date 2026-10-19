import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import SubtitleWindow from "./SubtitleWindow";
import "./styles.css";
import "./pixel-theme.css";

/**
 * The native layer creates the overlay with
 * `WebviewUrl::App("index.html?window=subtitle")`, so this is the single place
 * that decides which window is rendered (docs/subtitle-window.md §1).
 */
const isSubtitleWindow =
  new URLSearchParams(window.location.search).get("window") === "subtitle";

document.documentElement.lang = "zh-CN";
document.title = isSubtitleWindow ? "字幕悬浮窗" : "同传翻译";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("找不到应用根节点 #root。");
}

createRoot(rootElement).render(
  <StrictMode>
    {isSubtitleWindow ? <SubtitleWindow /> : <App />}
  </StrictMode>,
);
