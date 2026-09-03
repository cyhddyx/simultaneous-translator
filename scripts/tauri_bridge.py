"""Headless JSONL bridge for the Tauri simultaneous-translator frontend.

The process intentionally has no GUI and no listening socket.  Tauri starts it as
a sidecar and sends one JSON object per line over stdin.  Every stdout line is a
JSON object written by :class:`JsonlWriter`; diagnostics never use stdout so the
protocol cannot be corrupted by a background callback.

Requests
--------

``{"id": "...", "command": "ping", "params": {}}``
``{"id": "...", "command": "start", "params": {"config": {...}, "secrets": {...}}}``
``{"id": "...", "command": "stop", "params": {}}``
``{"id": "...", "command": "shutdown", "params": {}}``
``{"id": "...", "command": "probe.models", "params": {"kind": ..., "provider": {...}, "secrets": {...}}}``
``{"id": "...", "command": "probe.connect", "params": {"kind": ..., "provider": {...}, "secrets": {...}}}``

``start`` params carry one provider per service::

    {"session_id": "...",
     "config": {"sourceLanguage": "...", "targetLanguage": "...",
                "translation": {"protocol": "gemini|openai", "baseUrl": "https://...",
                                "model": "..."},
                "recognition": {"protocol": "dashscope", "baseUrl": "wss://...",
                                "model": "..."}},
     "secrets": {"translation_api_key": "...", "recognition_api_key": "..."}}

For convenience ``start`` also accepts the configuration fields directly in
``params``, and every key is read in either snake_case or Tauri's camelCase.  The
bridge never persists a secret; Tauri owns the credential store.

``probe.models`` and ``probe.connect`` are one-shot: Tauri launches a throwaway
sidecar, sends a single request, and kills the process.  They never touch a
session, so they are safe to run while a translation session is live in the
long-running sidecar.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, TextIO
from urllib.parse import urlsplit, urlunsplit


PROTOCOL_VERSION = 1
MAX_INPUT_LINE_BYTES = 1_000_000
MAX_TRANSLATION_QUEUE = 8
# Translation responses are streamed, which turns the read timeout into a *gap*
# budget: it only fires when the relay goes completely silent for this long.  A
# slow model no longer fails merely because the whole answer outlasted one
# timeout, because every delta (and every SSE keepalive comment) restarts it.
TRANSLATION_CONNECT_TIMEOUT_S = 10.0
TRANSLATION_IDLE_TIMEOUT_S = 12.0
# A stream that dribbles forever would still hold the session's single ordered
# worker and starve every later sentence, so the whole response is also capped.
TRANSLATION_TOTAL_TIMEOUT_S = 45.0
PROBE_TIMEOUT_S = 15.0
# The audio thread is a daemon, so the interpreter would exit without running its
# ``recognition.stop()`` cleanup.  Give it a bounded window to close the ASR
# stream before the process goes away and leaves the task dangling server-side.
SHUTDOWN_JOIN_TIMEOUT_S = 0.7
# A native audio call should either open quickly or fail visibly.  Without this
# guard, a driver/COM stall can leave the desktop UI in "connecting" forever.
AUDIO_STARTUP_TIMEOUT_S = 10.0

DEFAULT_DASHSCOPE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com"
DEFAULT_TRANSLATION_MODEL = "gemini-3.7-flash"
DEFAULT_ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming"
DEFAULT_TARGET_LANGUAGE = "简体中文"
DEFAULT_SOURCE_LANGUAGE = "自动检测"

TRANSLATION_PROTOCOLS = ("gemini", "openai")
RECOGNITION_PROTOCOLS = ("dashscope",)

# Both wire protocols stream with text/event-stream framing.  Only ``data:``
# carries a payload; ``[DONE]`` is the OpenAI terminator and Gemini simply ends
# the body instead.
SSE_DATA_PREFIX = "data:"
SSE_DONE_SENTINEL = "[DONE]"


def preload_audio_dependencies() -> None:
    """Load native audio/scientific modules on the bridge's main thread.

    On Windows with Python 3.14, importing NumPy for the first time from the
    sidecar's audio thread can stall while its native ``multiarray`` module is
    initialized.  A session is constructed by the JSONL main thread, so loading
    the complete audio stack here guarantees the worker only reads fully
    initialized modules from ``sys.modules``.
    """

    import dashscope  # noqa: F401
    import numpy  # noqa: F401
    import soundcard  # noqa: F401
    from dashscope.audio.asr import (  # noqa: F401
        Recognition,
        RecognitionCallback,
        RecognitionResult,
    )
    from scipy.signal import resample_poly  # noqa: F401


class ProtocolError(ValueError):
    """An invalid JSONL request that can be reported to the controller."""


def force_utf8_stdio() -> None:
    """Pin the protocol streams to UTF-8 before a single byte is read.

    Tauri writes and reads UTF-8, but Python's default stdio encoding for a pipe
    on Windows is the ANSI code page (gbk on a Chinese install).  One non-ASCII
    character is enough to break the protocol, and the stock default target
    language 简体中文 guarantees it: the GBK decode turns the incoming UTF-8 bytes
    into lone surrogates, and the outgoing translations become GBK bytes that the
    Rust reader rejects as invalid UTF-8.

    ``errors="replace"`` keeps a malformed line recoverable - it degrades into a
    JSON parse error instead of an exception that no caller expects.
    """

    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            # A stream that refuses to be reconfigured still works for ASCII,
            # which is all the writer emits.
            pass


def nested(data: Any, *keys: str, default: Any = None) -> Any:
    """Read a value from SDK dicts or objects without assuming their shape."""

    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            current = getattr(current, key, default)
        if current is None:
            return default
    return current


def sdk_result_message(result: Any) -> str:
    """Read an SDK error without trusting its potentially broken ``__str__``."""

    message = nested(result, "message", default=None)
    if message not in (None, ""):
        return str(message)
    try:
        return str(result)
    except Exception:  # noqa: BLE001 - third-party result objects may fail here
        return type(result).__name__


def redact_secret(message: Any, *secrets: str) -> str:
    """Replace every non-empty secret with ``***`` and bound the message length."""

    text = str(message)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text[:1_000]


def _string(value: Any, field: str, *, required: bool = False, default: str = "") -> str:
    if value is None:
        value = default
    if not isinstance(value, str):
        raise ProtocolError(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        raise ProtocolError(f"{field} is required")
    return value


def _config_value(values: dict[str, Any], snake_case: str, default: Any = None) -> Any:
    """Read a bridge-native field or Tauri's serde camelCase equivalent."""

    if snake_case in values:
        return values[snake_case]
    head, *tail = snake_case.split("_")
    camel_case = head + "".join(part.capitalize() for part in tail)
    return values.get(camel_case, default)


def _secure_url(value: Any, field: str, scheme: str) -> tuple[str, Any]:
    """Validate one service endpoint and return its normalized split form."""

    candidate = _string(value, field, required=True)
    try:
        parsed = urlsplit(candidate)
        # Accessing port forces urllib to reject malformed port values as well.
        _ = parsed.port
    except ValueError as exc:
        raise ProtocolError(f"{field} is not a valid URL") from exc
    if parsed.scheme.lower() != scheme:
        raise ProtocolError(f"{field} must use {scheme}://")
    if not parsed.netloc:
        raise ProtocolError(f"{field} must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ProtocolError(f"{field} must not contain URL credentials")
    if parsed.query or parsed.fragment:
        raise ProtocolError(f"{field} must not contain a query string or fragment")
    return candidate, parsed


def normalize_dashscope_ws_url(value: Any, field: str = "dashscope_ws_url") -> str:
    """Allow only a canonical secure DashScope WebSocket endpoint."""

    _, parsed = _secure_url(value, field, "wss")
    path = parsed.path.rstrip("/")
    return urlunsplit(("wss", parsed.netloc, path, "", ""))


def _normalize_https_base_url(value: Any, field: str, version_suffix: str) -> str:
    """Return an HTTPS base URL without a duplicated trailing API-version path.

    Every client appends its own API-version path.  Relays are often documented
    as ``https://relay.example/v1beta`` (or ``/v1``); passing that exact string
    through would produce ``.../v1beta/v1beta/...``.  Keep a relay's preceding
    path, but strip only a terminal version component.
    """

    _, parsed = _secure_url(value, field, "https")
    path = parsed.path.rstrip("/")
    if path.lower().endswith(version_suffix):
        path = path[: -len(version_suffix)]
    path = path.rstrip("/")
    return urlunsplit(("https", parsed.netloc, path, "", ""))


def normalize_gemini_base_url(value: Any, field: str = "gemini_base_url") -> str:
    return _normalize_https_base_url(value, field, "/v1beta")


def normalize_openai_base_url(value: Any, field: str = "openai_base_url") -> str:
    return _normalize_https_base_url(value, field, "/v1")


def normalize_provider_base_url(protocol: str, value: Any, field: str = "base_url") -> str:
    """Normalize one provider endpoint according to its wire protocol."""

    if protocol == "gemini":
        return normalize_gemini_base_url(value, field)
    if protocol == "openai":
        return normalize_openai_base_url(value, field)
    if protocol == "dashscope":
        return normalize_dashscope_ws_url(value, field)
    raise ProtocolError(f"unsupported provider protocol: {protocol}")


@dataclass(frozen=True)
class ProviderSpec:
    """One configured service endpoint plus the credential that reaches it."""

    protocol: str
    base_url: str
    model: str
    api_key: str


def _provider_spec(
    values: dict[str, Any],
    field: str,
    *,
    api_key: str,
    allowed: tuple[str, ...],
    default_protocol: str,
    default_base_url: str,
    default_model: str,
) -> ProviderSpec:
    raw = _config_value(values, field, {})
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ProtocolError(f"{field} must be an object")

    protocol = _string(
        _config_value(raw, "protocol", default_protocol), f"{field}.protocol", required=True
    ).lower()
    if protocol not in allowed:
        raise ProtocolError(f"{field}.protocol must be one of {', '.join(allowed)}")

    base_url = normalize_provider_base_url(
        protocol,
        _config_value(raw, "base_url", default_base_url),
        f"{field}.base_url",
    )
    model = _string(
        _config_value(raw, "model"), f"{field}.model", default=default_model, required=True
    )
    return ProviderSpec(protocol=protocol, base_url=base_url, model=model, api_key=api_key)


@dataclass(frozen=True)
class RuntimeConfig:
    translation: ProviderSpec
    recognition: ProviderSpec
    source_language: str
    target_language: str

    @property
    def secrets(self) -> tuple[str, str]:
        return (self.translation.api_key, self.recognition.api_key)

    @classmethod
    def from_start_params(cls, params: Any) -> "RuntimeConfig":
        if not isinstance(params, dict):
            raise ProtocolError("start params must be an object")

        raw_config = params.get("config", params)
        if not isinstance(raw_config, dict):
            raise ProtocolError("start params.config must be an object")
        raw_secrets = params.get("secrets", {})
        if raw_secrets is None:
            raw_secrets = {}
        if not isinstance(raw_secrets, dict):
            raise ProtocolError("start params.secrets must be an object")

        # A direct ``params`` payload remains useful for local protocol smoke
        # tests, while Tauri should send the recommended config/secrets split.
        values = dict(raw_config)
        values.update(raw_secrets)

        translation_key = _string(
            _config_value(values, "translation_api_key", os.environ.get("GEMINI_API_KEY")),
            "translation_api_key",
            required=True,
        )
        recognition_key = _string(
            _config_value(values, "recognition_api_key", os.environ.get("DASHSCOPE_API_KEY")),
            "recognition_api_key",
            required=True,
        )

        return cls(
            translation=_provider_spec(
                values,
                "translation",
                api_key=translation_key,
                allowed=TRANSLATION_PROTOCOLS,
                default_protocol="gemini",
                default_base_url=DEFAULT_GEMINI_BASE_URL,
                default_model=DEFAULT_TRANSLATION_MODEL,
            ),
            recognition=_provider_spec(
                values,
                "recognition",
                api_key=recognition_key,
                allowed=RECOGNITION_PROTOCOLS,
                default_protocol="dashscope",
                default_base_url=DEFAULT_DASHSCOPE_WS_URL,
                default_model=DEFAULT_ASR_MODEL,
            ),
            source_language=_string(
                _config_value(values, "source_language"),
                "source_language",
                default=DEFAULT_SOURCE_LANGUAGE,
            ),
            target_language=_string(
                _config_value(values, "target_language"),
                "target_language",
                default=DEFAULT_TARGET_LANGUAGE,
            ),
        )


class JsonlWriter:
    """The sole, serialized writer for protocol output on stdout."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._sequence = 0

    @staticmethod
    def _encode(payload: dict[str, Any]) -> str:
        # ASCII-escaping every non-ASCII character keeps the protocol readable by
        # the controller under any stdout encoding, so a stream that could not be
        # reconfigured to UTF-8 cannot silently corrupt a line.
        return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))

    def _write(self, payload: dict[str, Any]) -> None:
        encoded = self._encode(payload)
        with self._lock:
            self._stream.write(encoded + "\n")
            self._stream.flush()

    def response(
        self,
        request_id: Any,
        *,
        ok: bool,
        result: dict[str, Any] | None = None,
        error: dict[str, str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "type": "response",
            "id": request_id,
            "ok": ok,
        }
        if ok:
            payload["result"] = result or {}
        else:
            payload["error"] = error or {"code": "unknown", "message": "Unknown bridge error"}
        self._write(payload)

    def event(self, event: str, session_id: str | None, data: dict[str, Any] | None = None) -> None:
        with self._lock:
            self._sequence += 1
            payload = {
                "v": PROTOCOL_VERSION,
                "type": "event",
                "event": event,
                "sequence": self._sequence,
                "session_id": session_id,
                "data": data or {},
            }
            self._stream.write(self._encode(payload) + "\n")
            self._stream.flush()


class ProviderClient:
    """Minimal HTTPS client shared by translation and connectivity probes.

    Using one hand-written client for both means the settings dialog's 检测
    button exercises exactly the request a live session would make.
    """

    protocol = ""

    def __init__(
        self,
        spec: ProviderSpec,
        *,
        connect_timeout_s: float = TRANSLATION_CONNECT_TIMEOUT_S,
        idle_timeout_s: float = TRANSLATION_IDLE_TIMEOUT_S,
        total_timeout_s: float = TRANSLATION_TOTAL_TIMEOUT_S,
        disable_thinking: bool = True,
        transport: Any = None,
    ) -> None:
        # Import lazily so ping and protocol errors work without the audio and
        # HTTP dependencies installed, which keeps packaging diagnostics clear.
        import httpx

        self._spec = spec
        self._total_timeout_s = total_timeout_s
        # Live subtitles cannot afford a chain of thought, and several providers
        # now reason by default (DeepSeek V4 does, at "high" effort).  The switch
        # is provider-specific, so a rejection downgrades this for the rest of
        # the session instead of failing every sentence.
        self._disable_thinking = disable_thinking
        self._client = httpx.Client(
            timeout=httpx.Timeout(idle_timeout_s, connect=connect_timeout_s),
            follow_redirects=False,
            transport=transport,
        )

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    def _headers(self) -> dict[str, str]:
        raise NotImplementedError

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = self._client.request(
            method,
            self._spec.base_url + path,
            headers=self._headers(),
            json=json_body,
            params=params,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError(f"服务返回了非 JSON 响应：{response.text[:300]}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("服务返回了非预期的响应结构")
        return payload

    def _delta_text(self, chunk: dict[str, Any]) -> str:
        """Text carried by one streamed event.  Empty is normal and expected."""

        raise NotImplementedError

    def _complete_text(self, payload: dict[str, Any]) -> str:
        """Text carried by a whole non-streamed response body.

        Relays that accept the streaming request and then answer with a single
        buffered JSON object are common enough that the streaming reader falls
        back to this instead of reporting an empty translation.
        """

        raise NotImplementedError

    @staticmethod
    def _raise_for_stream_error(chunk: dict[str, Any]) -> None:
        """Fail on an error object delivered inside an HTTP 200 event stream."""

        error = chunk.get("error")
        if not error:
            return
        message = nested(error, "message", default=None)
        if not message:
            message = json.dumps(error, ensure_ascii=False)
        raise RuntimeError(f"翻译服务返回错误：{message}")

    def _stream_translation(
        self,
        path: str,
        *,
        json_body: dict[str, Any],
        params: dict[str, Any] | None = None,
    ) -> str:
        """Read one streamed completion and return its concatenated text.

        Streaming is what keeps a slow generation alive.  A buffered response
        sends nothing until the model has finished, so its first byte arrives
        only after the full answer is built and the read timeout becomes a hard
        cap on generation time.  Here every event rearms that timeout, so only a
        connection that has genuinely gone silent fails.
        """

        started = time.monotonic()
        pieces: list[str] = []
        buffered: list[str] = []
        saw_event = False
        with self._client.stream(
            "POST",
            self._spec.base_url + path,
            headers=self._headers(),
            json=json_body,
            params=params,
        ) as response:
            if response.status_code >= 400:
                # A streamed response arrives with its body unread, so the error
                # text has to be pulled in before it can be reported.
                response.read()
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
            for line in response.iter_lines():
                if time.monotonic() - started > self._total_timeout_s:
                    raise RuntimeError(f"翻译流在 {self._total_timeout_s:.0f} 秒内没有结束")
                stripped = line.strip()
                if not stripped or stripped.startswith(":"):
                    # Blank separators and comment keepalives carry no payload,
                    # but receiving them is exactly what stops the idle timeout
                    # from firing while the model is still thinking.
                    continue
                if not stripped.startswith(SSE_DATA_PREFIX):
                    # ``event:``/``id:``/``retry:`` fields, or the body of a
                    # relay that answered with plain JSON; keep it for the
                    # non-streamed fallback below.
                    buffered.append(line)
                    continue
                data = stripped[len(SSE_DATA_PREFIX) :].strip()
                if data == SSE_DONE_SENTINEL:
                    saw_event = True
                    break
                if not data:
                    continue
                try:
                    chunk = json.loads(data)
                except ValueError:
                    raise RuntimeError(f"翻译服务返回了无法解析的流数据：{data[:300]}") from None
                if not isinstance(chunk, dict):
                    raise RuntimeError("翻译服务返回了非预期的流数据结构")
                saw_event = True
                self._raise_for_stream_error(chunk)
                pieces.append(self._delta_text(chunk))
        if saw_event:
            return "".join(pieces).strip()

        body = "\n".join(buffered).strip()
        if body:
            try:
                payload = json.loads(body)
            except ValueError:
                payload = None
            if isinstance(payload, dict):
                self._raise_for_stream_error(payload)
                return self._complete_text(payload).strip()
        raise RuntimeError(f"翻译服务没有返回可用的流式响应：{body[:300]}")

    def translate(self, prompt: str) -> str:
        """Stream one translation, with thinking switched off when possible.

        The "no thinking" request fragment is not portable: DeepSeek wants a
        top-level ``thinking`` object, Gemini wants a ``thinkingConfig`` budget,
        and an endpoint that knows neither answers 400.  So a rejection retries
        once without the fragment and downgrades this client for good, which
        keeps an unknown relay working at the cost of one wasted round trip on
        the session's first sentence.
        """

        try:
            return self._stream_translation(
                self._translate_path(),
                json_body=self._translate_body(prompt, disable_thinking=self._disable_thinking),
                params=self._translate_params(),
            )
        except RuntimeError as exc:
            if not self._disable_thinking or not _rejects_request_body(exc):
                raise
            self._disable_thinking = False
        return self._stream_translation(
            self._translate_path(),
            json_body=self._translate_body(prompt, disable_thinking=False),
            params=self._translate_params(),
        )

    def _translate_path(self) -> str:
        raise NotImplementedError

    def _translate_params(self) -> dict[str, Any] | None:
        return None

    def _translate_body(self, prompt: str, *, disable_thinking: bool) -> dict[str, Any]:
        raise NotImplementedError

    def list_models(self) -> list[str]:
        raise NotImplementedError


def _rejects_request_body(exc: Exception) -> bool:
    """True when a failure looks like the endpoint refusing a body field.

    Matching on the status alone rather than on a field name is deliberate: a
    gateway that rejects the thinking switch may describe it in any wording, and
    an unrelated 400 simply fails again on the retry with its own message.
    """

    message = str(exc)
    return any(status in message for status in ("HTTP 400", "HTTP 422"))


def _unique_sorted(names: list[str]) -> list[str]:
    return sorted({name for name in names if name})


class GeminiClient(ProviderClient):
    """Gemini Developer API, as exposed by Google and by compatible relays."""

    protocol = "gemini"

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self._spec.api_key, "Content-Type": "application/json"}

    def _model_path(self) -> str:
        model = self._spec.model
        if model.startswith("models/"):
            model = model[len("models/") :]
        return model

    def _translate_path(self) -> str:
        # ``alt=sse`` (see _translate_params) is what turns this endpoint into
        # real text/event-stream framing; without it the reply is a JSON array
        # that cannot be parsed incrementally.
        return f"/v1beta/models/{self._model_path()}:streamGenerateContent"

    def _translate_params(self) -> dict[str, Any] | None:
        return {"alt": "sse"}

    def _translate_body(self, prompt: str, *, disable_thinking: bool) -> dict[str, Any]:
        generation_config: dict[str, Any] = {"temperature": 0.1}
        if disable_thinking:
            # Budget 0 is the documented "do not think" value on the models that
            # allow it.  The 3.x series switched to thinkingLevel and rejects the
            # two together, which is what translate()'s retry covers.
            generation_config["thinkingConfig"] = {"thinkingBudget": 0}
        return {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": generation_config,
        }

    @staticmethod
    def _candidate_text(payload: dict[str, Any]) -> str:
        blocked = nested(payload, "promptFeedback", "blockReason")
        if blocked:
            raise RuntimeError(f"请求被安全策略拦截：{blocked}")
        candidates = payload.get("candidates") or []
        if not candidates:
            return ""
        parts = nested(candidates[0], "content", "parts", default=[]) or []
        texts = [str(nested(part, "text", default="")) for part in parts]
        return "".join(text for text in texts if text)

    def _delta_text(self, chunk: dict[str, Any]) -> str:
        # A streamed chunk has the same shape as a whole response, and chunks
        # that only carry usage or safety metadata legitimately have no parts.
        return self._candidate_text(chunk)

    def _complete_text(self, payload: dict[str, Any]) -> str:
        text = self._candidate_text(payload)
        if not payload.get("candidates"):
            raise RuntimeError("翻译服务没有返回候选结果")
        return text

    def list_models(self) -> list[str]:
        payload = self._request("GET", "/v1beta/models", params={"pageSize": 1000})
        names: list[str] = []
        for item in payload.get("models") or []:
            name = str(nested(item, "name", default="")).strip()
            if name.startswith("models/"):
                name = name[len("models/") :]
            methods = nested(item, "supportedGenerationMethods", default=None)
            if isinstance(methods, list) and methods and "generateContent" not in methods:
                continue
            names.append(name)
        return _unique_sorted(names)


class OpenAICompatibleClient(ProviderClient):
    """OpenAI chat-completions protocol, shared by most relays and local servers."""

    protocol = "openai"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._spec.api_key}", "Content-Type": "application/json"}

    def _translate_path(self) -> str:
        return "/v1/chat/completions"

    def _translate_body(self, prompt: str, *, disable_thinking: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self._spec.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "stream": True,
        }
        if disable_thinking:
            # DeepSeek V4 reasons by default at "high" effort, which costs tens
            # of seconds per sentence; this is its documented OpenAI-format
            # switch.  Thinking mode also ignores temperature, so turning it off
            # is what makes the setting above mean anything.
            body["thinking"] = {"type": "disabled"}
        return body

    @staticmethod
    def _content_text(content: Any) -> str:
        if isinstance(content, list):
            # Some relays mirror the multimodal content-part shape.
            return "".join(str(nested(part, "text", default="")) for part in content)
        return str(content or "")

    def _delta_text(self, chunk: dict[str, Any]) -> str:
        choices = chunk.get("choices") or []
        if not choices:
            # The opening role-only chunk and trailing usage chunks land here.
            return ""
        return self._content_text(nested(choices[0], "delta", "content", default=""))

    def _complete_text(self, payload: dict[str, Any]) -> str:
        choices = payload.get("choices") or []
        if not choices:
            raise RuntimeError("翻译服务没有返回候选结果")
        return self._content_text(nested(choices[0], "message", "content", default=""))

    def list_models(self) -> list[str]:
        payload = self._request("GET", "/v1/models")
        names = [
            str(nested(item, "id", default="")).strip() for item in payload.get("data") or []
        ]
        return _unique_sorted(names)


TRANSLATION_CLIENTS: dict[str, type[ProviderClient]] = {
    "gemini": GeminiClient,
    "openai": OpenAICompatibleClient,
}


def build_translation_client(spec: ProviderSpec, **kwargs: Any) -> ProviderClient:
    client_cls = TRANSLATION_CLIENTS.get(spec.protocol)
    if client_cls is None:
        raise ProtocolError(f"unsupported translation protocol: {spec.protocol}")
    return client_cls(spec, **kwargs)


def translation_prompt(text: str, source_language: str, target_language: str) -> str:
    return (
        "You are a professional simultaneous interpreter. Translate the speech segment below "
        f"from {source_language} into {target_language}. Preserve meaning, names, numbers, "
        "and tone. Return only the translation, with no notes or quotation marks.\n\n"
        f"Speech: {text}"
    )


class TranslationService:
    """Synchronous translation client used by one ordered executor worker."""

    def __init__(self, config: RuntimeConfig) -> None:
        self._client = build_translation_client(config.translation)
        self._source_language = config.source_language
        self._target_language = config.target_language

    def translate(self, text: str) -> str:
        prompt = translation_prompt(text, self._source_language, self._target_language)
        return self._client.translate(prompt)


class AudioWorker(threading.Thread):
    """Capture the default Windows speaker loopback and forward ASR callbacks."""

    def __init__(self, server: "BridgeServer", session: "TranslationSession") -> None:
        super().__init__(name=f"audio-{session.session_id[:8]}", daemon=True)
        self._server = server
        self._session = session

    def run(self) -> None:
        recognition: Any = None
        try:
            import dashscope
            import numpy as np
            import soundcard as sc
            from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult
            from scipy.signal import resample_poly

            session = self._session
            server = self._server

            class AsrCallback(RecognitionCallback):
                def on_open(self) -> None:
                    server.on_asr_open(session)

                def on_close(self) -> None:
                    server.on_asr_ended(session, "closed")

                def on_error(self, result: RecognitionResult) -> None:
                    message = sdk_result_message(result)
                    server.on_asr_error(session, f"语音识别错误：{message}")

                def on_complete(self) -> None:
                    server.on_asr_ended(session, "complete")

                def on_event(self, result: RecognitionResult) -> None:
                    sentence = nested(result, "output", "sentence")
                    if sentence is None:
                        sentence = nested(result, "payload", "output", "sentence", default={})
                    text = nested(sentence, "text", default="") if sentence else ""
                    if not text:
                        return
                    is_final = bool(
                        nested(sentence, "sentence_end", default=False)
                        or nested(sentence, "end_time", default=None) is not None
                    )
                    server.on_transcript(session, str(text).strip(), is_final)

            dashscope.api_key = session.config.recognition.api_key
            dashscope.base_websocket_api_url = session.config.recognition.base_url
            recognition = Recognition(
                model=session.config.recognition.model,
                format="pcm",
                sample_rate=16000,
                callback=AsrCallback(),
                semantic_punctuation_enabled=False,
                heartbeat=True,
            )

            speaker = sc.default_speaker()
            if speaker is None:
                raise RuntimeError("未找到 Windows 默认播放设备")
            raw_speaker_id = getattr(speaker, "id", None)
            if not isinstance(raw_speaker_id, str) or not raw_speaker_id.strip():
                raise RuntimeError("默认播放设备没有可用的稳定 ID")
            speaker_id = raw_speaker_id.strip()

            # speaker.name is not stable or unique.  ``speaker.id`` maps to the
            # corresponding WASAPI loopback endpoint, and loopback.channels is
            # the count the recorder must actually use.
            loopback = sc.get_microphone(id=speaker_id, include_loopback=True)
            if loopback is None:
                raise RuntimeError("无法为默认播放设备打开 WASAPI 回环输入")
            loopback_channels = int(getattr(loopback, "channels", 0) or getattr(speaker, "channels", 0) or 0)
            if loopback_channels < 1:
                raise RuntimeError("默认播放设备没有可用的音频通道")

            server.emit_session_event(
                session,
                "audio.device",
                {
                    "id": speaker_id,
                    "name": str(getattr(speaker, "name", speaker_id)),
                    "channels": loopback_channels,
                },
            )
            recognition.start()

            capture_rate = 48_000
            frame_count = capture_rate // 10
            with loopback.recorder(samplerate=capture_rate, channels=loopback_channels) as recorder:
                server.on_audio_ready(session)
                while not session.stop_event.is_set():
                    audio = np.asarray(recorder.record(numframes=frame_count))
                    if audio.ndim == 1:
                        mono = audio
                    else:
                        mono = np.mean(audio, axis=1)
                    pcm = resample_poly(mono, 1, 3)
                    pcm = np.clip(pcm, -1.0, 1.0)
                    recognition.send_audio_frame((pcm * 32767).astype("<i2").tobytes())
        except Exception as exc:
            if not self._session.stop_event.is_set():
                self._server.stop_session_with_error(
                    self._session,
                    scope="audio",
                    code="audio_or_asr_failed",
                    message=f"音频采集或识别失败：{exc}",
                    recoverable=True,
                )
        finally:
            self._session.mark_audio_startup_settled()
            if recognition is not None:
                try:
                    recognition.stop()
                except Exception:
                    pass
            self._server.on_audio_worker_stopped(self._session)


class TranslationSession:
    """One session's audio worker and strictly ordered bounded translation work."""

    def __init__(self, server: "BridgeServer", session_id: str, config: RuntimeConfig) -> None:
        preload_audio_dependencies()
        self.server = server
        self.session_id = session_id
        self.config = config
        self.stop_event = threading.Event()
        self._audio_startup_settled = threading.Event()
        self._audio_ready = False
        self._audio_startup_lock = threading.Lock()
        self.state = "starting"
        self.translator = TranslationService(config)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"translation-{session_id[:8]}")
        # This semaphore is the admission gate for the executor's logical queue.
        # At most eight jobs (one may be executing) can exist for this session.
        self._queue_slots = threading.BoundedSemaphore(MAX_TRANSLATION_QUEUE)
        self._futures_lock = threading.Lock()
        self._futures: set[Future[str]] = set()
        self._source_lock = threading.Lock()
        self._last_final = ""
        self._source_sequence = 0
        self.audio_worker = AudioWorker(server, self)

    def start(self) -> None:
        self.audio_worker.start()
        threading.Thread(
            target=self._watch_audio_startup,
            name=f"audio-startup-{self.session_id[:8]}",
            daemon=True,
        ).start()

    def _watch_audio_startup(self) -> None:
        if not self._audio_startup_settled.wait(AUDIO_STARTUP_TIMEOUT_S):
            self.server.on_audio_startup_timeout(self)

    def mark_audio_ready(self) -> None:
        with self._audio_startup_lock:
            self._audio_ready = True
            self._audio_startup_settled.set()

    def mark_audio_startup_settled(self) -> None:
        self._audio_startup_settled.set()

    @property
    def audio_ready(self) -> bool:
        with self._audio_startup_lock:
            return self._audio_ready

    def begin_stop(self) -> None:
        self.stop_event.set()
        self._audio_startup_settled.set()

    def join_audio_worker(self, timeout: float = SHUTDOWN_JOIN_TIMEOUT_S) -> None:
        """Wait briefly for the audio thread to run its ASR cleanup.

        Only meaningful after :meth:`begin_stop`; the worker checks the stop flag
        once per captured chunk and closes the recognition stream on its way out.
        """

        if self.audio_worker.is_alive():
            self.audio_worker.join(timeout)

    def cancel_pending_translations(self) -> None:
        """Cancel executor-queued futures without waiting for an in-flight HTTP call."""

        with self._futures_lock:
            futures = tuple(self._futures)
        for future in futures:
            future.cancel()
        try:
            self.executor.shutdown(wait=False, cancel_futures=True)
        except TypeError:
            # Python 3.8 compatibility for manually run development environments.
            self.executor.shutdown(wait=False)

    def next_final_sequence(self, text: str) -> int | None:
        with self._source_lock:
            if not text or text == self._last_final:
                return None
            self._last_final = text
            self._source_sequence += 1
            return self._source_sequence

    def submit_translation(self, source_seq: int, text: str) -> None:
        if self.stop_event.is_set() or not self.server.is_current_session(self):
            return
        if not self._queue_slots.acquire(blocking=False):
            self.server.emit_session_event(
                self,
                "translation.dropped",
                {
                    "source_seq": source_seq,
                    "source_text": text,
                    "reason": "queue_full",
                    "limit": MAX_TRANSLATION_QUEUE,
                },
            )
            return

        try:
            future = self.executor.submit(self.translator.translate, text)
        except Exception as exc:
            self._queue_slots.release()
            self.server.emit_session_error(
                self,
                scope="translation",
                code="translation_submit_failed",
                message=f"翻译任务提交失败：{exc}",
                recoverable=True,
            )
            return

        with self._futures_lock:
            self._futures.add(future)
        # The executor thread invokes this callback.  There is deliberately no
        # per-future waiting thread, which was the unbounded-thread bug in the
        # original desktop implementation.
        future.add_done_callback(
            lambda completed: self._on_translation_done(completed, source_seq=source_seq, source_text=text)
        )

    def _on_translation_done(self, future: Future[str], *, source_seq: int, source_text: str) -> None:
        try:
            translation = future.result()
        except CancelledError:
            return
        except Exception as exc:
            message = self.server._redact(f"翻译失败：{exc}", self.config)
            self.server.emit_session_event(
                self,
                "translation.failed",
                {
                    "source_seq": source_seq,
                    "source_text": source_text,
                    "message": message,
                },
            )
            self.server.emit_session_error(
                self,
                scope="translation",
                code="translation_failed",
                message=message,
                recoverable=True,
            )
        else:
            # is_current_session also checks stop_event, so stale HTTP responses
            # from a stopped or replaced session are never forwarded to Tauri.
            self.server.emit_session_event(
                self,
                "translation",
                {
                    "source_seq": source_seq,
                    "source_text": source_text,
                    "text": translation or "（无翻译结果）",
                },
            )
        finally:
            with self._futures_lock:
                self._futures.discard(future)
            self._queue_slots.release()


def parse_probe_params(params: Any) -> tuple[str, ProviderSpec]:
    """Validate one probe request and return its service kind plus endpoint."""

    if not isinstance(params, dict):
        raise ProtocolError("probe params must be an object")

    kind = _string(params.get("kind"), "kind", default="translation").lower()
    if kind == "translation":
        allowed = TRANSLATION_PROTOCOLS
        default_protocol = "gemini"
        default_base_url = DEFAULT_GEMINI_BASE_URL
        default_model = DEFAULT_TRANSLATION_MODEL
    elif kind == "recognition":
        allowed = RECOGNITION_PROTOCOLS
        default_protocol = "dashscope"
        default_base_url = DEFAULT_DASHSCOPE_WS_URL
        default_model = DEFAULT_ASR_MODEL
    else:
        raise ProtocolError("kind must be translation or recognition")

    raw_secrets = params.get("secrets", {})
    if raw_secrets is None:
        raw_secrets = {}
    if not isinstance(raw_secrets, dict):
        raise ProtocolError("probe params.secrets must be an object")
    api_key = _string(_config_value(raw_secrets, "api_key"), "api_key", required=True)

    spec = _provider_spec(
        params,
        "provider",
        api_key=api_key,
        allowed=allowed,
        default_protocol=default_protocol,
        default_base_url=default_base_url,
        default_model=default_model,
    )
    return kind, spec


def probe_recognition_connection(spec: ProviderSpec, timeout_s: float = PROBE_TIMEOUT_S) -> None:
    """Open and immediately close one DashScope recognition stream.

    Safe to mutate the dashscope module globals because probes only ever run in
    a throwaway sidecar process that exits right afterwards.
    """

    import dashscope
    from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult

    settled = threading.Event()
    outcome: dict[str, Any] = {"opened": False, "error": None}

    class ProbeCallback(RecognitionCallback):
        def on_open(self) -> None:
            outcome["opened"] = True
            settled.set()

        def on_close(self) -> None:
            settled.set()

        def on_error(self, result: RecognitionResult) -> None:
            outcome["error"] = sdk_result_message(result)
            settled.set()

        def on_event(self, result: RecognitionResult) -> None:
            settled.set()

    dashscope.api_key = spec.api_key
    dashscope.base_websocket_api_url = spec.base_url
    recognition = Recognition(
        model=spec.model,
        format="pcm",
        sample_rate=16000,
        callback=ProbeCallback(),
        semantic_punctuation_enabled=False,
    )
    try:
        recognition.start()
        if not settled.wait(timeout_s):
            raise RuntimeError("识别服务在超时前没有建立连接")
        if outcome["error"]:
            raise RuntimeError(str(outcome["error"]))
        if not outcome["opened"]:
            raise RuntimeError("识别服务在握手完成前关闭了连接")
    finally:
        try:
            recognition.stop()
        except Exception:
            pass


class BridgeServer:
    """Own the active session and translate JSONL requests into lifecycle calls."""

    def __init__(self, stdin: TextIO, stdout: TextIO) -> None:
        self._stdin = stdin
        self.writer = JsonlWriter(stdout)
        self._session_lock = threading.RLock()
        self._current_session: TranslationSession | None = None
        self._shutting_down = False

    def is_current_session(self, session: TranslationSession) -> bool:
        with self._session_lock:
            return (
                not self._shutting_down
                and self._current_session is session
                and not session.stop_event.is_set()
            )

    def emit_session_event(
        self, session: TranslationSession, event: str, data: dict[str, Any] | None = None
    ) -> bool:
        """Atomically reject callbacks from stopped or replaced sessions."""

        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
            ):
                return False
            self.writer.event(event, session.session_id, data)
            return True

    def emit_session_error(
        self,
        session: TranslationSession,
        *,
        scope: str,
        code: str,
        message: str,
        recoverable: bool,
    ) -> None:
        self.emit_session_event(
            session,
            "error",
            {
                "scope": scope,
                "code": code,
                "message": self._redact(message, session.config),
                "recoverable": recoverable,
            },
        )

    def stop_session_with_error(
        self,
        session: TranslationSession,
        *,
        scope: str,
        code: str,
        message: str,
        recoverable: bool,
    ) -> bool:
        """Report a fatal session error and make every later callback stale."""

        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
            ):
                return False
            self.writer.event(
                "error",
                session.session_id,
                {
                    "scope": scope,
                    "code": code,
                    "message": self._redact(message, session.config),
                    "recoverable": recoverable,
                },
            )
            session.begin_stop()
            return True

    @staticmethod
    def _redact(message: Any, config: RuntimeConfig) -> str:
        return redact_secret(message, *config.secrets)

    def on_asr_open(self, session: TranslationSession) -> None:
        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
            ):
                return
            session.state = "listening"
            self.writer.event("asr.status", session.session_id, {"status": "opened"})
            self.writer.event("state", session.session_id, {"state": "listening"})

    def on_asr_error(self, session: TranslationSession, message: str) -> None:
        self.stop_session_with_error(
            session,
            scope="asr",
            code="asr_error",
            message=message,
            recoverable=True,
        )

    def on_asr_ended(self, session: TranslationSession, status: str) -> None:
        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
            ):
                return
            self.writer.event("asr.status", session.session_id, {"status": status})
        message = (
            "语音识别连接已结束，请重新开始同传。"
            if status == "complete"
            else "语音识别连接意外断开，请重新开始同传。"
        )
        self.stop_session_with_error(
            session,
            scope="asr",
            code=f"asr_{status}",
            message=message,
            recoverable=True,
        )

    def on_audio_ready(self, session: TranslationSession) -> None:
        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
            ):
                return
            session.mark_audio_ready()
            self.writer.event("audio.ready", session.session_id, {})

    def on_audio_startup_timeout(self, session: TranslationSession) -> None:
        with self._session_lock:
            if (
                self._shutting_down
                or self._current_session is not session
                or session.stop_event.is_set()
                or session.audio_ready
            ):
                return
            self.writer.event(
                "error",
                session.session_id,
                {
                    "scope": "audio",
                    "code": "audio_startup_timeout",
                    "message": "打开默认播放设备超时，请检查音频设备后重新开始同传。",
                    "recoverable": True,
                },
            )
            session.begin_stop()
        # The worker may be blocked in a native driver call, so publish the
        # terminal state now. Tauri will then terminate the sidecar process.
        self.on_audio_worker_stopped(session)

    def on_transcript(self, session: TranslationSession, text: str, is_final: bool) -> None:
        if not text:
            return
        if not is_final:
            self.emit_session_event(session, "source.partial", {"text": text})
            return

        source_seq = session.next_final_sequence(text)
        if source_seq is None:
            return
        if not self.emit_session_event(
            session,
            "source.final",
            {"source_seq": source_seq, "text": text},
        ):
            return
        session.submit_translation(source_seq, text)

    def on_audio_worker_stopped(self, session: TranslationSession) -> None:
        """Only the still-current session may transition the UI back to stopped."""

        with self._session_lock:
            if self._current_session is not session:
                return
            self._current_session = None
            # An unexpected audio/ASR exit must invalidate the translation queue
            # just like an explicit stop.  Otherwise its worker could keep making
            # stale requests after there is no session left to receive them.
            session.begin_stop()
            if not self._shutting_down:
                session.state = "stopped"
                self.writer.event("state", session.session_id, {"state": "stopped"})
                self.writer.event("stopped", session.session_id, {})
        session.cancel_pending_translations()

    def _start(self, request_id: Any, params: Any) -> None:
        try:
            config = RuntimeConfig.from_start_params(params)
            requested_session_id = params.get("session_id")
            if requested_session_id is None:
                # The standalone smoke test does not need to coordinate an ID
                # with Tauri.  Production callers must supply their Rust-created
                # UUID so UI event filtering observes the exact same value.
                session_id = str(uuid.uuid4())
            else:
                if not isinstance(requested_session_id, str) or not requested_session_id.strip():
                    raise ProtocolError("session_id must be a non-empty UUID string")
                session_id = requested_session_id.strip()
                try:
                    uuid.UUID(session_id)
                except ValueError as exc:
                    raise ProtocolError("session_id must be a valid UUID string") from exc
            session = TranslationSession(self, session_id, config)
        except ProtocolError as exc:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "invalid_start_config", "message": str(exc)},
            )
            return
        except Exception as exc:
            # This covers missing/incompatible Python dependencies without
            # printing a traceback into the sidecar's stdout protocol.
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "startup_initialization_failed", "message": str(exc)[:1_000]},
            )
            return

        with self._session_lock:
            if self._shutting_down:
                self.writer.response(
                    request_id,
                    ok=False,
                    error={"code": "shutting_down", "message": "Bridge is shutting down"},
                )
                session.cancel_pending_translations()
                return
            existing = self._current_session
            if existing is not None and not existing.stop_event.is_set():
                self.writer.response(
                    request_id,
                    ok=False,
                    error={"code": "session_active", "message": "A translation session is already active"},
                )
                session.cancel_pending_translations()
                return
            # A previous session already stopping may still have an in-flight
            # request, but its stop flag plus identity check make every callback
            # stale before the replacement becomes visible.
            self._current_session = session
            self.writer.response(
                request_id,
                ok=True,
                result={"session_id": session.session_id, "state": "starting"},
            )
            self.writer.event("state", session.session_id, {"state": "starting"})

        try:
            session.start()
        except Exception as exc:
            self.emit_session_error(
                session,
                scope="audio",
                code="audio_worker_start_failed",
                message=f"无法启动音频线程：{exc}",
                recoverable=True,
            )
            self.on_audio_worker_stopped(session)

    def _probe_models(self, request_id: Any, params: Any) -> None:
        api_key = ""
        try:
            kind, spec = parse_probe_params(params)
            api_key = spec.api_key
        except ProtocolError as exc:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "invalid_probe_request", "message": str(exc)},
            )
            return

        if kind == "recognition":
            # DashScope's realtime ASR endpoint is a WebSocket with no model
            # catalogue, so the UI must fall back to a manually edited list.
            self.writer.response(
                request_id,
                ok=True,
                result={"models": [], "supported": False},
            )
            return

        client: ProviderClient | None = None
        try:
            client = build_translation_client(spec)
            models = client.list_models()
        except Exception as exc:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "probe_failed", "message": redact_secret(exc, api_key)},
            )
            return
        finally:
            if client is not None:
                client.close()
        self.writer.response(request_id, ok=True, result={"models": models, "supported": True})

    def _probe_connect(self, request_id: Any, params: Any) -> None:
        api_key = ""
        try:
            kind, spec = parse_probe_params(params)
            api_key = spec.api_key
        except ProtocolError as exc:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "invalid_probe_request", "message": str(exc)},
            )
            return

        started = time.monotonic()
        client: ProviderClient | None = None
        try:
            if kind == "recognition":
                probe_recognition_connection(spec)
                detail = "识别服务连接正常"
            else:
                # A probe translates three words, so it keeps the session's
                # request shape but not its generous streaming budget; the
                # settings dialog must not hang on a dead relay.
                client = build_translation_client(spec, total_timeout_s=PROBE_TIMEOUT_S)
                translation = client.translate(
                    translation_prompt("Connectivity check.", "English", "简体中文")
                )
                detail = "模型响应正常" if translation else "模型已连接但返回了空结果"
        except Exception as exc:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "probe_failed", "message": redact_secret(exc, api_key)},
            )
            return
        finally:
            if client is not None:
                client.close()

        self.writer.response(
            request_id,
            ok=True,
            result={
                "ok": True,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "detail": detail,
            },
        )

    def _stop(self, request_id: Any) -> None:
        with self._session_lock:
            session = self._current_session
            if session is None or session.stop_event.is_set():
                self.writer.response(request_id, ok=True, result={"already_stopped": True})
                return
            # Set this while holding the same lock used for event emission, so no
            # callback can write an old-session event after stop is acknowledged.
            session.begin_stop()
            session.state = "stopping"
            self.writer.response(
                request_id,
                ok=True,
                result={"session_id": session.session_id, "state": "stopping"},
            )
            self.writer.event("state", session.session_id, {"state": "stopping"})

        session.cancel_pending_translations()

    def _shutdown(self, request_id: Any) -> None:
        with self._session_lock:
            self._shutting_down = True
            session = self._current_session
            self._current_session = None
            if session is not None:
                session.begin_stop()
            self.writer.response(request_id, ok=True, result={"state": "shutting_down"})

        if session is not None:
            session.cancel_pending_translations()
            session.join_audio_worker()

    def _ping(self, request_id: Any) -> None:
        with self._session_lock:
            session = self._current_session
            self.writer.response(
                request_id,
                ok=True,
                result={
                    "protocol_version": PROTOCOL_VERSION,
                    "state": session.state if session is not None else "idle",
                    "session_id": session.session_id if session is not None else None,
                },
            )

    def handle_request(self, payload: Any) -> bool:
        if not isinstance(payload, dict):
            self.writer.response(
                None,
                ok=False,
                error={"code": "invalid_request", "message": "Request must be a JSON object"},
            )
            return True

        request_id = payload.get("id")
        command = payload.get("command", payload.get("method"))
        params = payload.get("params", {})
        if not isinstance(command, str):
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "invalid_request", "message": "command must be a string"},
            )
            return True
        if not isinstance(params, dict):
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "invalid_request", "message": "params must be an object"},
            )
            return True

        if command == "ping":
            self._ping(request_id)
        elif command == "start":
            self._start(request_id, params)
        elif command == "stop":
            self._stop(request_id)
        elif command == "probe.models":
            self._probe_models(request_id, params)
        elif command == "probe.connect":
            self._probe_connect(request_id, params)
        elif command == "shutdown":
            self._shutdown(request_id)
            return False
        else:
            self.writer.response(
                request_id,
                ok=False,
                error={"code": "unknown_command", "message": f"Unsupported command: {command}"},
            )
        return True

    def _dispatch_line(self, raw_line: str) -> bool:
        """Handle one request line, returning False to stop serving."""

        # "replace" so the guard itself cannot raise on a line that survived a
        # lossy decode; the JSON parse below rejects it cleanly instead.
        if len(raw_line.encode("utf-8", "replace")) > MAX_INPUT_LINE_BYTES:
            self.writer.response(
                None,
                ok=False,
                error={"code": "request_too_large", "message": "Request exceeds the JSONL size limit"},
            )
            return True
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            self.writer.response(
                None,
                ok=False,
                error={"code": "invalid_json", "message": f"Invalid JSON: {exc.msg}"},
            )
            return True
        return self.handle_request(payload)

    def serve(self) -> None:
        self.writer.event(
            "ready",
            None,
            {
                "protocol_version": PROTOCOL_VERSION,
                "commands": [
                    "ping",
                    "start",
                    "stop",
                    "shutdown",
                    "probe.models",
                    "probe.connect",
                ],
            },
        )
        try:
            for raw_line in self._stdin:
                try:
                    if not self._dispatch_line(raw_line):
                        break
                except Exception as exc:  # noqa: BLE001
                    # One bad line must never take the engine down: the
                    # controller cannot tell that apart from a crash, and the
                    # user only sees "翻译引擎在启动确认前退出".
                    self.writer.response(
                        None,
                        ok=False,
                        error={"code": "internal_error", "message": str(exc)[:1_000]},
                    )
        except KeyboardInterrupt:
            pass
        finally:
            # EOF is also a stop request from the parent process.  No response is
            # required because stdin is already closed, but stale callbacks must
            # still be invalidated and executor-queued work cancelled.
            with self._session_lock:
                self._shutting_down = True
                session = self._current_session
                self._current_session = None
                if session is not None:
                    session.begin_stop()
            if session is not None:
                session.cancel_pending_translations()
                session.join_audio_worker()


def main() -> int:
    force_utf8_stdio()
    BridgeServer(sys.stdin, sys.stdout).serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
