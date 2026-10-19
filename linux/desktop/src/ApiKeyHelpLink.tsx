import { useState } from "react";
import { ExternalLink } from "./PixelIcons";
import { API_KEY_HELP_URLS, type ApiKeyHelpKind } from "./apiKeyHelp";
import { translatorApi } from "./tauri";

export function ApiKeyHelpLink({ kind = "console" }: { kind?: ApiKeyHelpKind }) {
  const [error, setError] = useState("");
  return (
    <span className="api-key-help">
      <a href={API_KEY_HELP_URLS[kind]} target="_blank" rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          setError("");
          void translatorApi.openApiKeyHelp(kind).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          });
        }}>
        {kind === "console" ? "获取密钥" : "查看官方教程"}
        <ExternalLink size={12} />
      </a>
      {error && <span className="field-error" role="alert">{error}</span>}
    </span>
  );
}
