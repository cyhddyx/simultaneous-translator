import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

document.documentElement.lang = "zh-CN";
document.title = "同传翻译";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("找不到应用根节点 #root。");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
