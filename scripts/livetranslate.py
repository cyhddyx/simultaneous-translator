"""Qwen LiveTranslate realtime speech-translation channels.

A single DashScope realtime WebSocket carries speech recognition, translation
and speech synthesis for **one** direction, so a live channel both consumes
microphone (or WASAPI loopback) audio and produces the translated voice of the
speaker.  Two channels therefore implement a two-way interpreter:

``listen``
    System playback (WASAPI loopback) in, my language out.
``speak``
    My microphone in, the other side's language out.

Wire protocol (``wss://<host>/api-ws/v1/realtime?model=<model>``):

* ``session.update`` configures target language, output modality and voice.
* ``input_audio_buffer.append`` streams base64 PCM.  Inbound audio is
  uncompressed 16-bit little-endian PCM, mono, 16 kHz; outbound audio is the
  same encoding at 24 kHz.  Voice activity detection is left to the server, so
  the client never sends ``input_audio_buffer.commit``.
* ``session.finish`` must be sent before closing, otherwise the last utterance
  is lost; the server acknowledges with ``session.finished``.

Qwen3.8 text arrives through ``response.text.delta`` (text only) or
``response.audio_transcript.delta`` (text + audio). Fragments are accumulated
until the corresponding completion event. No external ASR or TTS is used.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

# Load the resampler's native dependencies before capture workers start.
from system_capture import SystemCapture
from audio_test_helpers import (
    AUDIO_TEST_SAMPLE_RATE,
    ProtocolError,
    audio_metrics,
    build_test_tone,
    signal_detected,
    validate_audio_test_request,
)

DEFAULT_LIVETRANSLATE_WS_URL = "wss://maas.qianwenaiapi.com/api-ws/v1/realtime"
DEFAULT_LIVETRANSLATE_MODEL = "qwen3.8-livetranslate-flash-realtime"
LIVETRANSLATE_PROTOCOLS = ("livetranslate",)

CHANNEL_IDS = ("listen", "speak")
INPUT_KINDS = ("system", "loopback", "microphone")
VOICE_CLONE_FREQUENCIES = ("never", "once", "always")

# ---------------------------------------------------------------------------
# Runtime channel control (contract: docs/runtime-channel-control.md).
#
# Three states stay strictly apart:
#   * configuration state - ``ChannelSpec.enabled``, built from settings.json and
#     never written back by anything in this module;
#   * runtime channel state - ``RuntimeChannelState``, memory only, one object
#     per session, reset to the configuration defaults by the next session;
#   * speak mute - ``RuntimeChannelState``, memory only.
#
# The capture loop consults the runtime state before every send, so closing a
# channel drops frames *before* they reach the engine without touching the
# recorder, the WebSocket or the sibling channel.
# ---------------------------------------------------------------------------
STATUS_CONNECTING = "connecting"
STATUS_READY = "ready"
STATUS_DEGRADED = "degraded"
STATUS_FAILED = "failed"
STATUS_VALUES = (STATUS_CONNECTING, STATUS_READY, STATUS_DEGRADED, STATUS_FAILED)

SERVICE_AUDIO = "audio"
SERVICE_NETWORK = "network"
SERVICE_CONFIGURATION = "configuration"
SERVICE_SYSTEM = "system"
ERROR_SERVICES = (SERVICE_AUDIO, SERVICE_NETWORK, SERVICE_CONFIGURATION, SERVICE_SYSTEM)

NETWORK_STATUS_EVENT = "network.status"
AUDIO_STATUS_EVENT = "audio.status"

# Contract 4.4 codes this module emits for scenarios that had no dedicated code
# before.  ``tauri_bridge`` owns the JSONL protocol surface and mirrors these
# literals; ``test_runtime_channels.py`` asserts the two modules never drift.
ERROR_CODE_AUDIO_DEVICE_LOST = "audio_device_lost"
ERROR_CODE_WEBSOCKET_CONNECT_FAILED = "websocket_connect_failed"
ERROR_CODE_AUTH_FAILED = "auth_failed"
ENGINE_CONTRACT_ERROR_CODES = (
    ERROR_CODE_AUDIO_DEVICE_LOST,
    ERROR_CODE_WEBSOCKET_CONNECT_FAILED,
    ERROR_CODE_AUTH_FAILED,
)

# Contract 4.4: engine error code -> service, and the recoverable override for
# the scenarios the table pins down.  Unknown codes stay ``system``/recoverable.
ERROR_CODE_SERVICES = {
    "audio_device_missing": SERVICE_AUDIO,
    "audio_device_failed": SERVICE_AUDIO,
    "audio_startup_timeout": SERVICE_AUDIO,
    "audio_start_failed": SERVICE_AUDIO,
    "audio_device_lost": SERVICE_AUDIO,
    "audio_playback_failed": SERVICE_AUDIO,
    "audio_or_asr_failed": SERVICE_AUDIO,
    "realtime_connect_timeout": SERVICE_NETWORK,
    "realtime_connection_closed": SERVICE_NETWORK,
    "realtime_receive_failed": SERVICE_NETWORK,
    "realtime_send_failed": SERVICE_NETWORK,
    "realtime_protocol_error": SERVICE_NETWORK,
    "realtime_configuration_timeout": SERVICE_NETWORK,
    "realtime_stream_timeout": SERVICE_NETWORK,
    "websocket_connect_failed": SERVICE_NETWORK,
    "websocket_reconnecting": SERVICE_NETWORK,
    "auth_failed": SERVICE_NETWORK,
    "translation_timeout": SERVICE_NETWORK,
    "translation_disconnected": SERVICE_NETWORK,
    "realtime_output_mismatch": SERVICE_CONFIGURATION,
    "realtime_voice_clone_unsupported": SERVICE_CONFIGURATION,
}
ERROR_CODE_RECOVERABLE = {
    "audio_device_missing": False,
    "audio_device_failed": False,
    "audio_start_failed": False,
    "realtime_output_mismatch": False,
    "realtime_voice_clone_unsupported": False,
    "auth_failed": False,
    "audio_device_lost": True,
    "websocket_connect_failed": True,
    "websocket_reconnecting": True,
    "translation_timeout": True,
    "translation_disconnected": True,
}

# Strings that mark a service rejection as an authentication failure rather than
# a generic protocol error.  DashScope reports the reason inside the payload.
_AUTH_FAILURE_HINTS = (
    "401",
    "403",
    "unauthorized",
    "invalidapikey",
    "invalid_api_key",
    "invalid api key",
    "authentication",
    "apikey",
    "api key",
    "鉴权",
    "认证",
    "密钥",
)


def error_service(code: str, default: str = SERVICE_SYSTEM) -> str:
    """Classify one engine error code into contract 4.4's ``service`` field."""

    return ERROR_CODE_SERVICES.get(code, default)


def error_recoverable(code: str, default: bool = True) -> bool:
    return ERROR_CODE_RECOVERABLE.get(code, default)


def looks_like_auth_failure(detail: str) -> bool:
    text = detail.lower()
    return any(hint in text for hint in _AUTH_FAILURE_HINTS)

# Encodings are fixed by the service: PCM16 mono, 16 kHz up / 24 kHz down.
INPUT_SAMPLE_RATE = 16_000
OUTPUT_SAMPLE_RATE = 24_000
FRAME_SECONDS = 0.1
FRAME_SAMPLES = int(INPUT_SAMPLE_RATE * FRAME_SECONDS)
# 24 kHz deltas arrive roughly every 100 ms; a couple of hundred of them is
# already many seconds of slack, and the queue sheds the oldest audio first so
# playback never drifts behind live speech.
PLAYER_QUEUE_CHUNKS = 240
CONNECT_TIMEOUT_S = 20.0
FINISH_TIMEOUT_S = 15.0
CLOSE_TIMEOUT_S = 5.0

# Shared with the desktop UI and native save/start validation.
_LANGUAGES = json.loads(Path(__file__).with_name("translation_languages.json").read_text(encoding="utf-8"))["languages"]
_LANGUAGES_BY_CODE = {language["code"]: language for language in _LANGUAGES}
_LANGUAGE_CODES = {
    alias.lower(): language["code"]
    for language in _LANGUAGES
    for alias in [language["code"], language["label"], *language["aliases"]]
}
_LANGUAGE_CODES.update({alias: "auto" for alias in ("自动检测", "自动", "auto", "automatic")})


def language_code(value: Any, default: str = "en") -> str:
    """Map a UI language label (or an ISO code) to the model's language code."""

    text = value.strip() if isinstance(value, str) else ""
    return _LANGUAGE_CODES.get(text.lower(), default)


def validate_output_language(value: str, play_audio: bool, label: str) -> str:
    code = language_code(value, "")
    language = _LANGUAGES_BY_CODE.get(code)
    if language is None:
        raise ValueError(f"{label}通道的目标语言不受当前模型支持，请重新选择。")
    if play_audio and not language["audio"]:
        raise ValueError(f"{label}通道：{language['label']}仅支持文字输出，不能语音播报。请改为文字输出，或选择其他译文语言。")
    return code


@dataclass(frozen=True)
class RealtimeOptions:
    """Session-wide realtime model options shared by every channel."""

    voice: str = "default"
    enable_voice_clone: bool = True
    voice_clone_frequency: str = "once"


@dataclass(frozen=True)
class ChannelSpec:
    """One direction of the interpreter."""

    channel: str
    enabled: bool
    input_kind: str
    input_device: str
    target_language: str
    output_device: str
    play_audio: bool
    voice_mode: str = ""

    @property
    def label(self) -> str:
        return "收听" if self.channel == "listen" else "发言"


def _flag(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _field(entry: dict[str, Any], snake_case: str, default: Any = None) -> Any:
    """Read a bridge-native field or Tauri's serde camelCase equivalent."""

    if snake_case in entry:
        return entry[snake_case]
    head, *tail = snake_case.split("_")
    camel_case = head + "".join(part.capitalize() for part in tail)
    return entry.get(camel_case, default)


def _choice(value: Any, allowed: tuple[str, ...], default: str) -> str:
    text = value.strip().lower() if isinstance(value, str) else ""
    return text if text in allowed else default


def parse_channel_specs(
    raw: Any,
    *,
    default_target_language: str,
    listen_default_input: str = "system",
    speak_default_input: str = "microphone",
) -> tuple[ChannelSpec, ...]:
    """Build both channel specifications from the ``audio`` config object.

    Missing fields retain their defaults. Explicit unsupported output languages
    fail validation before any channel starts capturing or connecting.
    """

    table = raw if isinstance(raw, dict) else {}
    specs: list[ChannelSpec] = []
    for channel in CHANNEL_IDS:
        entry = table.get(channel)
        entry = entry if isinstance(entry, dict) else {}
        default_input = listen_default_input if channel == "listen" else speak_default_input
        target = _field(entry, "target_language")
        if not isinstance(target, str) or not target.strip():
            target = default_target_language if channel == "listen" else "English"
        target = target.strip()
        input_device = _field(entry, "input_device")
        output_device = _field(entry, "output_device")
        specs.append(
            ChannelSpec(
                channel=channel,
                enabled=_flag(_field(entry, "enabled"), channel == "listen"),
                input_kind=_choice(_field(entry, "input"), INPUT_KINDS, default_input),
                input_device=input_device.strip() if isinstance(input_device, str) else "",
                target_language=target,
                output_device=output_device.strip() if isinstance(output_device, str) else "",
                play_audio=_flag(_field(entry, "play_audio"), False),
                voice_mode=_choice(_field(entry, "voice_mode"), ("system", "clone"), ""),
            )
        )
    for spec in specs:
        if spec.enabled:
            validate_output_language(spec.target_language, spec.play_audio, spec.label)
    return tuple(specs)


def enabled_channels(specs: tuple[ChannelSpec, ...]) -> tuple[ChannelSpec, ...]:
    return tuple(spec for spec in specs if spec.enabled)


class RuntimeChannelState:
    """Per-session runtime channel switches and the speak-mute flag.

    Configuration state lives in :class:`ChannelSpec`; this object only holds
    what a shortcut, tray item or toolbar button changed while the session runs.
    Nothing here is ever written to a settings file, and a new session builds a
    fresh object, which is exactly how the contract restores the configured
    defaults on restart.
    """

    def __init__(self, configured: Any = None) -> None:
        table = dict(configured) if isinstance(configured, dict) else {}
        self._lock = threading.Lock()
        self._configured = {channel: bool(table.get(channel, False)) for channel in CHANNEL_IDS}
        # Runtime defaults equal the configuration, so a rebuilt session needs no
        # explicit reset step: it simply starts from the configured values again.
        self._enabled = dict(self._configured)
        self._speak_muted = False

    # --------------------------------------------------------- audio hot path
    def should_capture(self, channel: str) -> bool:
        """Whether this channel's frames may be forwarded to the engine.

        Deliberately lock free: it is called once per captured frame from the
        audio path, where the contract forbids blocking work.  Reading a ``bool``
        out of a dict that only ever receives whole-value assignments is atomic
        under the GIL, and the worst case is one extra frame in flight while a
        switch flips.
        """

        if not self._enabled.get(channel, False):
            return False
        if channel == "speak" and self._speak_muted:
            return False
        return True

    # -------------------------------------------------------------- queries
    def configured(self, channel: str) -> bool:
        """Configuration state: whether settings.json enabled this channel."""

        return bool(self._configured.get(channel, False))

    def effective_enabled(self, channel: str) -> bool:
        """Runtime state that is actually in force (configuration wins)."""

        with self._lock:
            return self._effective(channel)

    def speak_muted(self) -> bool:
        with self._lock:
            return self._speak_muted

    # ------------------------------------------------------------- mutators
    def set_channel(self, channel: str, enabled: bool) -> bool:
        """Apply one runtime switch, returning whether the effective value moved."""

        with self._lock:
            before = self._effective(channel)
            self._enabled[channel] = bool(enabled)
            return self._effective(channel) != before

    def set_speak_muted(self, muted: bool) -> bool:
        with self._lock:
            before = self._speak_muted
            self._speak_muted = bool(muted)
            return self._speak_muted != before

    def _effective(self, channel: str) -> bool:
        # A channel the settings disabled can never be switched on at runtime;
        # the command layer rejects that case with ``channel_not_configured``.
        return bool(self._enabled.get(channel, False)) and self.configured(channel)


class HealthStatusTracker:
    """Remembers the last published health status per event/channel pair.

    Contract 4.3 allows ``network.status`` and ``audio.status`` to be sent only
    when the status actually changes, so every publisher asks this object first.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: dict[tuple[str, str], str] = {}

    def changed(self, event: str, status: str, channel: str = "") -> bool:
        with self._lock:
            key = (event, channel or "")
            if self._last.get(key) == status:
                return False
            self._last[key] = status
            return True

    def current(self, event: str, channel: str = "") -> str | None:
        with self._lock:
            return self._last.get((event, channel or ""))


def channel_audio_enabled(session: Any, channel: str) -> bool:
    """Runtime gate the capture loop consults before sending one frame.

    Duck-typed sessions without a runtime state keep the pre-existing behaviour
    of always forwarding audio, which is what the lighter test doubles rely on.
    """

    runtime = getattr(session, "runtime", None)
    if runtime is None:
        return True
    return bool(runtime.should_capture(channel))


def report_status(
    server: Any,
    session: Any,
    event: str,
    status: str,
    *,
    channel: str = "",
    detail: str = "",
) -> None:
    """Publish one health status, tolerating servers without health reporting."""

    reporter = getattr(server, "emit_session_status", None)
    if reporter is None:
        return
    reporter(session, event, status, channel=channel, detail=detail)


def report_channel_network(session: Any, channel: str, status: str, detail: str = "") -> None:
    """Record one channel's connection health on the session that aggregates it."""

    recorder = getattr(session, "set_channel_network", None)
    if recorder is None:
        return
    recorder(channel, status, detail)


def report_error(
    server: Any,
    session: Any,
    *,
    scope: str,
    code: str,
    message: str,
    recoverable: bool = True,
    service: str | None = None,
) -> None:
    """Report an engine error with its contract 4.4 service classification.

    The ``TypeError`` fallback keeps embedding test servers that still implement
    the pre-4.4 signature working, mirroring ``RealtimeSession._emit_session_event``.
    """

    resolved = service or error_service(code)
    try:
        server.emit_session_error(
            session,
            scope=scope,
            code=code,
            message=message,
            recoverable=recoverable,
            service=resolved,
        )
    except TypeError as error:
        if "service" not in str(error):
            raise
        server.emit_session_error(
            session,
            scope=scope,
            code=code,
            message=message,
            recoverable=recoverable,
        )


def list_audio_devices() -> dict[str, Any]:
    """Enumerate the audio endpoints the channels can bind to."""

    _ensure_com_initialized()
    import soundcard as sc

    default_speaker_id = ""
    with contextlib.suppress(Exception):
        speaker = sc.default_speaker()
        default_speaker_id = getattr(speaker, "id", "") or ""

    default_microphone_id = ""
    with contextlib.suppress(Exception):
        microphone = sc.default_microphone()
        default_microphone_id = getattr(microphone, "id", "") or ""

    def describe(items: list[Any], default_id: str, include_loopback: bool) -> list[dict[str, Any]]:
        described: list[dict[str, Any]] = []
        for item in items:
            device_id = getattr(item, "id", "") or ""
            if not device_id:
                continue
            described.append(
                {
                    "id": device_id,
                    "name": str(getattr(item, "name", device_id)),
                    "channels": int(getattr(item, "channels", 0) or 0),
                    "isDefault": bool(default_id) and device_id == default_id,
                    "loopback": include_loopback,
                }
            )
        return described

    return {
        # A playback endpoint doubles as a WASAPI loopback capture source, so the
        # same list drives both the translation voice output and "listen" input.
        "speakers": describe(sc.all_speakers(), default_speaker_id, True),
        "microphones": describe(sc.all_microphones(), default_microphone_id, False),
    }


def _audio_test_device_name(device: Any, fallback: str) -> str:
    return str(getattr(device, "name", "") or fallback)


def _audio_test_result(
    kind: str,
    device: Any,
    started: float,
    *,
    peak: float = 0.0,
    rms: float = 0.0,
    detected: bool,
    detail: str,
) -> dict[str, Any]:
    device_id = str(getattr(device, "id", "") or "")
    return {
        "ok": True,
        "kind": kind,
        "device_id": device_id,
        "device_name": _audio_test_device_name(device, device_id or "默认设备"),
        "duration_ms": max(0, int((time.monotonic() - started) * 1000)),
        "peak": float(peak),
        "rms": float(rms),
        "detected": bool(detected),
        "detail": detail,
    }


def _audio_test_speaker(soundcard: Any, device_id: str) -> Any:
    speaker = soundcard.get_speaker(id=device_id) if device_id else soundcard.default_speaker()
    if speaker is None:
        raise RuntimeError("未找到可用的播放设备")
    return speaker


def _audio_test_microphone(soundcard: Any, device_id: str, *, loopback: bool = False) -> Any:
    if loopback:
        microphone = soundcard.get_microphone(id=device_id, include_loopback=True)
    else:
        microphone = (
            soundcard.get_microphone(id=device_id)
            if device_id
            else soundcard.default_microphone()
        )
    if microphone is None:
        raise RuntimeError("未找到可用的麦克风")
    return microphone


def _audio_test_channels(device: Any) -> int:
    channels = int(getattr(device, "channels", 0) or 1)
    return max(1, channels)


def run_audio_test(kind: str, device_id: str = "") -> dict[str, Any]:
    """Run one local audio probe without contacting the translation service."""

    kind, device_id = validate_audio_test_request(kind, device_id)
    _ensure_com_initialized()
    import soundcard as sc

    started = time.monotonic()
    if kind == "playback":
        speaker = _audio_test_speaker(sc, device_id)
        try:
            with speaker.player(samplerate=AUDIO_TEST_SAMPLE_RATE, channels=1) as player:
                player.play(build_test_tone())
        except Exception as exc:  # noqa: BLE001 - converted to a probe error by the bridge
            raise RuntimeError(f"播放测试音失败：{exc}") from exc
        return _audio_test_result(
            kind,
            speaker,
            started,
            detected=True,
            detail="播放测试音成功",
        )

    if kind == "microphone":
        microphone = _audio_test_microphone(sc, device_id)
        channels = _audio_test_channels(microphone)
        try:
            with microphone.recorder(
                samplerate=AUDIO_TEST_SAMPLE_RATE,
                channels=channels,
            ) as recorder:
                samples = recorder.record(AUDIO_TEST_SAMPLE_RATE * 3)
        except Exception as exc:  # noqa: BLE001 - converted to a probe error by the bridge
            raise RuntimeError(f"麦克风录音失败：{exc}") from exc
        peak, rms = audio_metrics(samples)
        detected = signal_detected(peak)
        return _audio_test_result(
            kind,
            microphone,
            started,
            peak=peak,
            rms=rms,
            detected=detected,
            detail="检测到麦克风声音" if detected else "未检测到明显麦克风声音",
        )

    speaker = _audio_test_speaker(sc, device_id)
    speaker_id = str(getattr(speaker, "id", "") or device_id)
    if not speaker_id:
        raise RuntimeError("所选播放设备没有可用的回环端点")
    loopback = _audio_test_microphone(sc, speaker_id, loopback=True)
    channels = _audio_test_channels(loopback)
    tone = build_test_tone()
    try:
        with speaker.player(samplerate=AUDIO_TEST_SAMPLE_RATE, channels=1) as player:
            with loopback.recorder(
                samplerate=AUDIO_TEST_SAMPLE_RATE,
                channels=channels,
            ) as recorder:
                captured: list[Any] = []
                playback_errors: list[BaseException] = []

                def play() -> None:
                    _ensure_com_initialized()
                    try:
                        player.play(tone)
                    except BaseException as exc:  # noqa: BLE001 - forwarded after joining
                        playback_errors.append(exc)

                playback = threading.Thread(
                    target=play,
                    name="audio-test-playback",
                    daemon=True,
                )
                playback.start()
                try:
                    captured.append(recorder.record(AUDIO_TEST_SAMPLE_RATE))
                finally:
                    playback.join(timeout=2.0)
                if playback.is_alive():
                    raise RuntimeError("回环测试播放超时")
                if playback_errors:
                    raise RuntimeError(f"回环测试播放失败：{playback_errors[0]}")
    except RuntimeError:
        raise
    except Exception as exc:  # noqa: BLE001 - converted to a probe error by the bridge
        raise RuntimeError(f"回环测试失败：{exc}") from exc
    peak, rms = audio_metrics(captured[0] if captured else [])
    detected = signal_detected(peak)
    return _audio_test_result(
        kind,
        speaker,
        started,
        peak=peak,
        rms=rms,
        detected=detected,
        detail="回环测试成功" if detected else "未检测到播放回环信号",
    )


_COM_INIT_LOCK = threading.Lock()
_COM_THREAD_STATE = threading.local()


def _ensure_com_initialized() -> None:
    """Claim a COM apartment for the calling thread.

    Order matters. ``soundcard`` calls ``CoInitializeEx`` for whichever thread
    imports it and raises on any result other than ``S_OK`` or
    ``RPC_E_CHANGED_MODE`` — including the ``S_FALSE`` that a repeat call on the
    same thread returns. So the import must come first, and only other threads
    (and the importing thread afterwards) claim the apartment themselves.
    """

    if sys.platform != "win32":
        return
    if "soundcard" not in sys.modules:
        with _COM_INIT_LOCK:
            if "soundcard" not in sys.modules:
                import soundcard  # noqa: F401
    if getattr(_COM_THREAD_STATE, "initialized", False):
        return
    import ctypes

    COINIT_MULTITHREADED = 0x0
    with contextlib.suppress(Exception):
        ctypes.windll.ole32.CoInitializeEx(None, COINIT_MULTITHREADED)
    _COM_THREAD_STATE.initialized = True


class _PcmPlayer(threading.Thread):
    """Render 24 kHz mono PCM on a dedicated thread."""

    def __init__(self, device_id: str, channel: str, on_error: Callable[[BaseException], None] | None = None) -> None:
        super().__init__(name=f"livetranslate-player-{channel}", daemon=True)
        self._device_id = device_id
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=PLAYER_QUEUE_CHUNKS)
        self._stop_event = threading.Event()
        self.error: BaseException | None = None
        self._on_error = on_error

    def push(self, samples: Any) -> None:
        """Queue one decoded delta, dropping the oldest audio when behind."""

        if self._stop_event.is_set():
            return
        try:
            self._queue.put_nowait(samples)
            return
        except queue.Full:
            pass
        with contextlib.suppress(queue.Empty):
            self._queue.get_nowait()
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(samples)

    def stop(self) -> None:
        self._stop_event.set()
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(None)

    def run(self) -> None:
        try:
            _ensure_com_initialized()
            import soundcard as sc

            speaker = (
                sc.get_speaker(self._device_id) if self._device_id else sc.default_speaker()
            )
            if speaker is None:
                raise RuntimeError("未找到可用的播放设备")
            with speaker.player(samplerate=OUTPUT_SAMPLE_RATE, channels=1) as player:
                while not self._stop_event.is_set():
                    try:
                        item = self._queue.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if item is None:
                        break
                    player.play(item)
        except BaseException as exc:  # noqa: BLE001 - reported to the session
            self.error = exc
            if self._on_error is not None and not self._stop_event.is_set():
                self._on_error(exc)


class LiveTranslateChannel(threading.Thread):
    """One full-duplex direction against the realtime translation model."""

    def __init__(
        self,
        server: Any,
        session: "RealtimeSession",
        spec: ChannelSpec,
        *,
        base_url: str,
        model: str,
        api_key: str,
        options: RealtimeOptions,
    ) -> None:
        super().__init__(name=f"livetranslate-{spec.channel}", daemon=True)
        self._server = server
        self._session = session
        self._spec = spec
        self._base_url = base_url
        self._model = model
        self._api_key = api_key
        self._options = options
        self._finished = asyncio.Event()
        self._failed = False
        self._player: _PcmPlayer | None = None
        self._system_capture: SystemCapture | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._updated = False
        self._configuration_ready = asyncio.Event()
        self._variant = 0
        self._source_deltas: dict[str, str] = {}
        self._translation_deltas: dict[str, str] = {}
        self._completed_responses: dict[str, None] = {}
        # Frames the runtime switch discarded before they reached the engine.
        # Diagnostics only; the audio thread owns the increment.
        self._dropped_frames = 0

    # ------------------------------------------------------------------ thread

    def run(self) -> None:
        try:
            _ensure_com_initialized()
            asyncio.run(self._main())
        except Exception as exc:  # noqa: BLE001 - surfaced as a channel error
            self._report_failure("realtime_channel_failed", f"{self._spec.label}通道失败：{exc}")
        finally:
            if self._player is not None:
                self._player.stop()
                self._player.join(timeout=1.0)
            self._session.mark_channel_settled(self._spec.channel)
            self._session.on_channel_exit(self._spec.channel)

    def request_stop(self) -> None:
        """Ask the channel to wind down from another thread."""

        self._session.stop_event.set()
        if self._loop is not None:
            # Wake the receive loop out of a long ``recv`` wait.
            with contextlib.suppress(RuntimeError):
                self._loop.call_soon_threadsafe(self._configuration_ready.set)
        if self._player is not None:
            self._player.stop()
        if self._system_capture is not None:
            self._system_capture.close()

    # -------------------------------------------------------------- async main

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        channel = self._spec.channel
        pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=f"livetranslate-capture-{self._spec.channel}"
        )
        recorder = None
        stage = "audio"
        report_status(
            self._server, self._session, AUDIO_STATUS_EVENT, STATUS_CONNECTING, channel=channel
        )
        try:
            device = await asyncio.wait_for(
                self._loop.run_in_executor(pool, self._prepare_input),
                self._session.startup_timeout_s,
            )
            if device is None:
                if self._session.stop_event.is_set():
                    return
                self._report_failure("audio_device_missing", f"{self._spec.label}通道未找到可用的输入设备")
                return
            recorder, device_info = device
            self._session.mark_channel_ready(self._spec.channel)
            # The device is open, so the audio link itself is healthy from here on
            # even if the WebSocket handshake later fails.
            report_status(
                self._server, self._session, AUDIO_STATUS_EVENT, STATUS_READY, channel=channel
            )
            self._server.on_realtime_channel(self._session, self._spec.channel, "connecting", device=device_info)
            stage = "connect"
            ws_url = f"{self._base_url}?model={self._model}"
            async with _build_connector(ws_url, self._api_key) as websocket:
                reader = asyncio.create_task(self._receive_loop(websocket))
                try:
                    stage = "configure"
                    await self._send_session_update(websocket)
                    await asyncio.wait_for(self._configuration_ready.wait(), CONNECT_TIMEOUT_S)
                    if self._failed or self._session.stop_event.is_set():
                        return
                    report_channel_network(self._session, channel, STATUS_READY)
                    if self._spec.play_audio:
                        self._player = _PcmPlayer(self._spec.output_device, self._spec.channel, self._on_playback_error)
                        self._player.start()
                    stage = "capture"
                    self._server.on_realtime_channel(self._session, self._spec.channel, "streaming")
                    await self._capture_loop(websocket, pool, recorder)
                finally:
                    if self._updated and not self._failed:
                        await self._finish(websocket)
                    reader.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await reader
        except asyncio.TimeoutError:
            if not self._session.stop_event.is_set():
                failures = {
                    "audio": ("audio_startup_timeout", "打开音频输入设备超时，请检查所选设备"),
                    "connect": ("realtime_connect_timeout", "连接同传接口超时，请检查网络和接口地址"),
                    "configure": ("realtime_configuration_timeout", "同传接口未及时确认会话配置，请检查接口是否支持当前模型"),
                }
                code, detail = failures.get(stage, ("realtime_stream_timeout", "同传连接等待超时"))
                self._report_failure(code, f"{self._spec.label}通道：{detail}")
        except Exception as exc:
            if stage == "audio":
                self._report_failure("audio_device_failed", f"{self._spec.label}通道音频设备打开失败：{exc}")
            elif stage == "connect":
                # The handshake itself failed (refused, TLS, 4xx upgrade).  The
                # generic ``realtime_channel_failed`` catch-all stays in place for
                # every other unexpected error; this scenario now carries the code
                # contract 4.4 names explicitly.
                self._report_failure(
                    ERROR_CODE_WEBSOCKET_CONNECT_FAILED,
                    f"{self._spec.label}通道连接同传接口失败：{exc}",
                )
            else:
                raise
        finally:
            if recorder is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        self._loop.run_in_executor(pool, recorder.__exit__, None, None, None),
                        self._session.startup_timeout_s,
                    )
            pool.shutdown(wait=False, cancel_futures=True)

    def _prepare_input(self) -> tuple[Any, dict[str, Any]] | None:
        device = self._open_input()
        if device is None:
            return None
        recorder, _ = device
        # WASAPI creation, opening, reads and closing belong to the same worker.
        recorder.__enter__()
        if self._failed or self._session.stop_event.is_set():
            recorder.__exit__(None, None, None)
            return None
        return device

    def _open_input(self) -> tuple[Any, dict[str, Any]] | None:
        if self._spec.input_kind == "system":
            self._system_capture = SystemCapture(startup_timeout=self._session.startup_timeout_s)
            return self._system_capture, {
                "id": "system-excluding-translator", "name": "系统声音（排除本软件）",
                "channels": 1, "kind": "system",
            }
        # Runs on the capture worker thread, which must claim its own COM
        # apartment before any WASAPI call.
        _ensure_com_initialized()
        import soundcard as sc

        if self._spec.input_kind == "loopback":
            device_id = self._spec.input_device
            if not device_id:
                speaker = sc.default_speaker()
                device_id = getattr(speaker, "id", "") or ""
                if not device_id:
                    return None
                name = str(getattr(speaker, "name", device_id))
            else:
                name = device_id
            microphone = sc.get_microphone(id=device_id, include_loopback=True)
            # Explicit device loopback remains available, but cannot share a
            # render endpoint with either translated voice.
            for spec in self._session.specs:
                if not spec.enabled or not spec.play_audio:
                    continue
                output = sc.get_speaker(spec.output_device) if spec.output_device else sc.default_speaker()
                if output is not None and output.id == device_id:
                    raise RuntimeError("所选设备会再次采集译文，请将音频来源改为系统声音（排除本软件）")
        else:
            if self._spec.input_device:
                microphone = sc.get_microphone(id=self._spec.input_device)
                name = self._spec.input_device
            else:
                microphone = sc.default_microphone()
                name = str(getattr(microphone, "name", "默认麦克风")) if microphone else ""
        if microphone is None:
            return None
        channels = int(getattr(microphone, "channels", 0) or 1)
        if channels < 1:
            channels = 1
        recorder = microphone.recorder(samplerate=INPUT_SAMPLE_RATE, channels=channels)
        info = {
            "id": str(getattr(microphone, "id", self._spec.input_device)),
            "name": str(getattr(microphone, "name", name)) or name,
            "channels": channels,
            "kind": self._spec.input_kind,
        }
        return recorder, info

    async def _capture_loop(self, websocket: Any, pool: ThreadPoolExecutor, recorder: Any) -> None:
        import numpy as np

        channel = self._spec.channel
        loop = asyncio.get_running_loop()
        counter = 0
        while not self._session.stop_event.is_set() and not self._failed:
            try:
                audio = await loop.run_in_executor(pool, recorder.record, FRAME_SAMPLES)
            except Exception as exc:  # noqa: BLE001 - the device itself failed
                # A recorder that raises mid-stream is an unplugged or reconfigured
                # device, not a protocol problem, so _report_failure publishes it as
                # audio health with contract 4.4's dedicated code.
                if not self._session.stop_event.is_set():
                    self._report_failure(
                        ERROR_CODE_AUDIO_DEVICE_LOST,
                        f"{self._spec.label}通道音频设备已断开：{exc}",
                    )
                return
            if self._session.stop_event.is_set():
                break
            if not channel_audio_enabled(self._session, channel):
                # Runtime channel switch (contract section 6).  The frame is
                # dropped here, before it is encoded or sent: the recorder keeps
                # draining the device, the realtime connection stays open and the
                # sibling channel keeps streaming.  Re-enabling resumes on the
                # next frame without rebuilding anything.
                self._dropped_frames += 1
                continue
            frames = np.asarray(audio, dtype="float32")
            mono = frames if frames.ndim == 1 else frames.mean(axis=1)
            pcm = np.clip(mono, -1.0, 1.0)
            payload = (pcm * 32767.0).astype("<i2").tobytes()
            counter += 1
            try:
                await websocket.send(
                    json.dumps(
                        {
                            "event_id": f"event_{self._spec.channel}_{counter}",
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(payload).decode("ascii"),
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001 - connection is gone
                if not self._session.stop_event.is_set():
                    self._report_failure("realtime_send_failed", f"{self._spec.label}通道音频发送失败：{exc}")
                return

    # ------------------------------------------------------------ protocol I/O

    @property
    def _clone_enabled(self) -> bool:
        if self._spec.voice_mode:
            return self._spec.voice_mode == "clone"
        return self._spec.channel == "speak" and self._options.enable_voice_clone

    @property
    def _clone_frequency(self) -> str:
        return "always" if self._spec.channel == "listen" else "once"

    def _session_variants(self) -> list[dict[str, Any]]:
        # 3.8 performs ASR inside the same model; no separate ASR model or TTS call.
        configuration = {
            "output_modalities": ["text", "audio"] if self._spec.play_audio else ["text"],
            "translation": {"language": validate_output_language(
                self._spec.target_language, self._spec.play_audio, self._spec.label,
            )},
        }
        if self._spec.play_audio:
            configuration["enable_voice_clone"] = self._clone_enabled
        if self._spec.play_audio and self._clone_enabled:
            configuration.update({
                "voice": "default",
                "enable_voice_clone": True,
                "voice_clone_options": {"frequency": self._clone_frequency},
            })
        return [configuration]

    async def _send_session_update(self, websocket: Any) -> None:
        variants = self._session_variants()
        self._variant = min(self._variant, len(variants) - 1)
        payload = {
            "event_id": f"event_{self._spec.channel}_session_{self._variant}",
            "type": "session.update",
            "session": variants[self._variant],
        }
        await websocket.send(json.dumps(payload))

    async def _receive_loop(self, websocket: Any) -> None:
        try:
            async for message in websocket:
                try:
                    event = json.loads(message)
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                self._handle_event(event, websocket)
            if not self._session.stop_event.is_set() and not self._finished.is_set():
                self._report_failure("realtime_connection_closed", f"{self._spec.label}通道连接已关闭")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - connection-level failure
            if not self._session.stop_event.is_set():
                self._report_failure("realtime_receive_failed", f"{self._spec.label}通道连接中断：{exc}")

    def _handle_event(self, event: dict[str, Any], websocket: Any) -> None:
        event_type = event.get("type")
        if not isinstance(event_type, str):
            return

        if event_type == "session.updated":
            session = event.get("session", {})
            actual = session.get("output_modalities") if isinstance(session, dict) else None
            expected = ["text", "audio"] if self._spec.play_audio else ["text"]
            if actual is not None and (not isinstance(actual, list) or set(actual) != set(expected)):
                self._report_failure("realtime_output_mismatch", "模型未接受所选输出模式")
                return
            if self._spec.play_audio and not self._clone_enabled and isinstance(session, dict) and session.get("enable_voice_clone") is True:
                self._report_failure("realtime_voice_clone_unsupported", "同传接口未关闭该通道的音色复刻，已停止连接")
                return
            if self._spec.play_audio and self._clone_enabled:
                clone = session.get("voice_clone_options", {}) if isinstance(session, dict) else {}
                if (not isinstance(session, dict) or session.get("enable_voice_clone") is not True
                        or not isinstance(clone, dict)
                        or clone.get("frequency") != self._clone_frequency):
                    self._report_failure("realtime_voice_clone_unsupported", "同传接口未确认本人音色复刻，已停止连接；可在设置中切换系统音色后重试")
                    return
            self._updated = True
            self._configuration_ready.set()
            return
        if event_type == "error":
            self._handle_protocol_error(event, websocket)
            return
        if event_type == "session.finished":
            self._finished.set()
            return

        if event_type == "conversation.item.input_audio_transcription.delta":
            key = str(event.get("item_id", "current"))
            text = self._source_deltas.get(key, "") + _event_text(event, "delta")
            self._source_deltas[key] = text
            self._trim_buffer(self._source_deltas)
            self._on_source_partial({"text": text})
            return
        if event_type == "conversation.item.input_audio_transcription.text":
            self._on_source_partial(event)
            return
        if event_type == "conversation.item.input_audio_transcription.completed":
            key = str(event.get("item_id", "current"))
            text = _event_text(event, "transcript") or self._source_deltas.get(key, "")
            self._source_deltas.pop(key, None)
            self._session.on_channel_transcript(self._spec.channel, text)
            return
        if event_type in ("response.audio_transcript.delta", "response.text.delta"):
            key = _response_key(event)
            text = self._translation_deltas.get(key, "") + _event_text(event, "delta")
            self._translation_deltas[key] = text
            self._trim_buffer(self._translation_deltas)
            self._session.on_channel_translation_partial(self._spec.channel, key, text)
            return
        if event_type in ("response.audio_transcript.text", "response.text.text"):
            text = _event_text(event, "text") + str(event.get("stash") or "")
            self._translation_deltas[_response_key(event)] = text
            self._session.on_channel_translation_partial(self._spec.channel, _response_key(event), text)
            return
        if event_type in ("response.audio_transcript.done", "response.text.done"):
            self._finish_translation(_response_key(event), _event_text(event, "text"))
            return
        if event_type == "response.done":
            response = event.get("response", {})
            if not isinstance(response, dict):
                return
            if response.get("status") in ("failed", "cancelled", "incomplete"):
                self._report_failure("realtime_response_failed", "同传响应未完成，请重新开始会话")
                return
            output = response.get("output", [])
            parts = [
                _event_text(content, "text")
                for item in output if isinstance(item, dict)
                for content in item.get("content", []) if isinstance(content, dict)
            ] if isinstance(output, list) else []
            self._finish_translation(str(response.get("id", "")), "".join(parts))
            return
        if event_type == "response.audio.delta":
            self._on_audio_delta(event)
            return

    def _handle_protocol_error(self, event: dict[str, Any], websocket: Any) -> None:
        detail = _event_error_message(event)
        if looks_like_auth_failure(detail):
            # Contract 4.4 names this scenario separately because it is not
            # recoverable: retrying with the same credential cannot succeed.
            self._report_failure(
                ERROR_CODE_AUTH_FAILED,
                f"{self._spec.label}通道服务端鉴权失败：{detail}",
                recoverable=False,
            )
            return
        self._report_failure("realtime_protocol_error", f"{self._spec.label}通道被模型拒绝：{detail}")

    @staticmethod
    def _trim_buffer(buffer: dict[str, Any]) -> None:
        while len(buffer) > 128:
            del buffer[next(iter(buffer))]

    def _finish_translation(self, key: str, text: str) -> None:
        if key and key in self._completed_responses:
            return
        text = text or self._translation_deltas.get(key, "")
        self._translation_deltas.pop(key, None)
        if not text:
            return
        if key:
            self._completed_responses[key] = None
            self._trim_buffer(self._completed_responses)
        self._session.on_channel_translation_done(self._spec.channel, key, text)

    def _on_source_partial(self, event: dict[str, Any]) -> None:
        text = _event_text(event, "text") + str(event.get("stash") or "")
        if not text:
            return
        self._server.emit_session_event(
            self._session,
            "source.partial",
            {"text": text, "channel": self._spec.channel},
        )

    def _on_playback_error(self, error: BaseException) -> None:
        if self._loop is not None:
            with contextlib.suppress(RuntimeError):
                self._loop.call_soon_threadsafe(
                    self._report_failure,
                    "audio_playback_failed",
                    f"{self._spec.label}通道译文播放失败，请检查译文播放设备：{error}",
                )

    def _on_audio_delta(self, event: dict[str, Any]) -> None:
        if not self._spec.play_audio or self._player is None:
            return
        encoded = event.get("delta")
        if not isinstance(encoded, str) or not encoded:
            return
        try:
            raw = base64.b64decode(encoded, validate=False)
        except Exception:  # noqa: BLE001 - a malformed delta is not fatal
            return
        if not raw or len(raw) % 2:
            return
        import numpy as np

        samples = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
        self._player.push(samples)

    async def _finish(self, websocket: Any) -> None:
        with contextlib.suppress(Exception):
            await websocket.send(
                json.dumps(
                    {
                        "event_id": f"event_{self._spec.channel}_finish",
                        "type": "session.finish",
                    }
                )
            )
            # Without waiting for ``session.finished`` the tail of the last
            # utterance is dropped server-side. The flag is an ``asyncio.Event``
            # and not a ``threading.Event``: awaiting the latter would block the
            # whole event loop and the acknowledgement could never be read.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._finished.wait(), timeout=FINISH_TIMEOUT_S)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(websocket.close(), timeout=CLOSE_TIMEOUT_S)

    # ------------------------------------------------------------------ errors

    def _report_failure(self, code: str, message: str, *, recoverable: bool | None = None) -> None:
        if self._failed:
            return
        self._failed = True
        self._configuration_ready.set()
        channel = self._spec.channel
        self._server.on_realtime_channel(self._session, channel, "failed", detail=message)
        if error_service(code) == SERVICE_AUDIO:
            report_status(
                self._server, self._session, AUDIO_STATUS_EVENT, STATUS_FAILED,
                channel=channel, detail=message,
            )
        # Session-level network health is aggregated by the session, so a channel
        # that dies while its sibling still streams degrades instead of failing.
        report_channel_network(self._session, channel, STATUS_FAILED, message)
        report_error(
            self._server,
            self._session,
            scope="audio" if code.startswith("audio_") else "translation",
            code=code,
            message=message,
            recoverable=error_recoverable(code) if recoverable is None else recoverable,
            service=error_service(code),
        )


def _build_connector(url: str, api_key: str) -> Any:
    """Create the websockets connector across websockets 12-16 API spellings."""

    from websockets.asyncio.client import connect

    headers = {"Authorization": f"Bearer {api_key}"}
    options: dict[str, Any] = {
        "open_timeout": CONNECT_TIMEOUT_S,
        "close_timeout": CLOSE_TIMEOUT_S,
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": None,
    }
    last_error: TypeError | None = None
    for keyword in ("additional_headers", "extra_headers"):
        try:
            return connect(url, **{keyword: headers}, **options)
        except TypeError as exc:
            last_error = exc
    raise last_error if last_error is not None else RuntimeError("无法创建 WebSocket 连接")


def _event_text(event: dict[str, Any], key: str) -> str:
    value = event.get(key)
    if isinstance(value, str):
        return value
    # ``response.audio_transcript.done`` and ``response.text.done`` disagree on
    # the field name across generations, so accept either spelling.
    for fallback in ("text", "transcript", "delta"):
        fallback_value = event.get(fallback)
        if isinstance(fallback_value, str):
            return fallback_value
    return ""


def _response_key(event: dict[str, Any]) -> str:
    for key in ("response_id", "item_id"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _event_error_message(event: dict[str, Any]) -> str:
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code")
        if message:
            return str(message)
    message = event.get("message") or event.get("code")
    return str(message) if message else "未知错误"


class RealtimeSession:
    """Owns the live channels of one realtime interop session.

    Presents the same duck-typed surface ``BridgeServer`` expects from
    ``TranslationSession`` so lifecycle, staleness checks and stop handling are
    shared between the pipeline and realtime engines.
    """

    def __init__(
        self,
        server: Any,
        session_id: str,
        config: Any,
        *,
        base_url: str,
        model: str,
        api_key: str,
        options: RealtimeOptions,
        specs: tuple[ChannelSpec, ...],
        startup_timeout_s: float,
    ) -> None:
        # Native NumPy/audio DLL loading can hang when first imported on a worker
        # while the sidecar's main thread is blocked reading its command pipe.
        _ensure_com_initialized()
        self.server = server
        self.session_id = session_id
        self.config = config
        self.stop_event = threading.Event()
        self.state = "starting"
        self.specs = specs
        self.startup_timeout_s = startup_timeout_s
        # Runtime switches for exactly this session.  Rebuilding the session
        # builds a new object, which restores the configured defaults and
        # ``speak_muted = False`` without any explicit reset (contract section 1).
        self.runtime = RuntimeChannelState({spec.channel: spec.enabled for spec in specs})
        self.status_tracker = HealthStatusTracker()
        self._channel_network: dict[str, tuple[str, str]] = {
            spec.channel: (STATUS_CONNECTING, "") for spec in specs
        }
        self._lock = threading.Lock()
        self._audio_ready = False
        self._audio_startup_settled = threading.Event()
        self._pending_channels = {spec.channel for spec in specs}
        self._pending_asr: dict[str, list[tuple[int, str]]] = {spec.channel: [] for spec in specs}
        self._orphan_translations: dict[str, list[str]] = {spec.channel: [] for spec in specs}
        self._response_seqs: dict[str, dict[str, int]] = {spec.channel: {} for spec in specs}
        self._sequence = 0
        self._source_text: dict[int, str] = {}
        self.channels = [
            LiveTranslateChannel(
                server,
                self,
                spec,
                base_url=base_url,
                model=model,
                api_key=api_key,
                options=options,
            )
            for spec in specs
        ]

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        for channel in self.channels:
            channel.start()

    def mark_channel_ready(self, channel: str) -> None:
        with self._lock:
            first = not self._audio_ready
            self._audio_ready = True
            self._pending_channels.discard(channel)
            if not self._pending_channels:
                self._audio_startup_settled.set()
        if first:
            self.server.on_audio_ready(self)

    def mark_audio_ready(self) -> None:
        """BridgeServer's shared ready hook; channel bookkeeping is separate."""

        with self._lock:
            self._audio_ready = True

    def mark_channel_settled(self, channel: str) -> None:
        with self._lock:
            self._pending_channels.discard(channel)
            if not self._pending_channels:
                self._audio_startup_settled.set()

    def mark_audio_startup_settled(self) -> None:
        self._audio_startup_settled.set()

    # ---------------------------------------------------------- network health

    def set_channel_network(self, channel: str, status: str, detail: str = "") -> None:
        """Record one channel's connection health and publish the session view.

        ``network.status`` is session scoped (contract 4.3), so the per-channel
        states are aggregated: one dead channel next to a live one is
        ``degraded``, every channel dead is ``failed``.
        """

        with self._lock:
            self._channel_network[channel] = (status, detail)
            aggregate, aggregate_detail = self._aggregate_network()
        report_status(self.server, self, NETWORK_STATUS_EVENT, aggregate, detail=aggregate_detail)

    def _aggregate_network(self) -> tuple[str, str]:
        """Combine per-channel states; the caller holds ``self._lock``."""

        states = list(self._channel_network.values())
        if not states:
            return STATUS_CONNECTING, ""
        failed = [state for state in states if state[0] == STATUS_FAILED]
        if failed and len(failed) == len(states):
            return STATUS_FAILED, failed[0][1]
        if failed:
            return STATUS_DEGRADED, failed[0][1]
        degraded = [state for state in states if state[0] == STATUS_DEGRADED]
        if degraded:
            return STATUS_DEGRADED, degraded[0][1]
        if any(state[0] == STATUS_CONNECTING for state in states):
            return STATUS_CONNECTING, ""
        return STATUS_READY, ""

    def on_channel_exit(self, channel: str) -> None:
        """Retire the session once every channel has stopped.

        Called from the exiting channel's own ``run``, so it is still ``alive``
        at this point and must be excluded from the liveness check.
        """

        exiting = threading.current_thread()
        with self._lock:
            self._pending_channels.discard(channel)
            remaining = any(
                item is not exiting and item.is_alive() for item in self.channels
            )
        if not remaining:
            self.server.on_realtime_all_channels_closed(self)

    @property
    def audio_ready(self) -> bool:
        with self._lock:
            return self._audio_ready

    def begin_stop(self) -> None:
        self.stop_event.set()
        self._audio_startup_settled.set()
        for channel in self.channels:
            if channel.is_alive():
                channel.request_stop()

    def join_audio_worker(self, timeout: float = 1.0) -> None:
        deadline = max(0.1, timeout)
        share = max(0.1, deadline / max(1, len(self.channels)))
        for channel in self.channels:
            if channel.is_alive():
                channel.join(share)

    def cancel_pending_translations(self) -> None:
        """The realtime model translates server-side, so there is no local queue."""

    # ------------------------------------------------------ caption assembly

    def _emit_session_event(
        self, event: str, data: dict[str, Any], *, allow_stopping: bool = False
    ) -> bool:
        if allow_stopping:
            try:
                return self.server.emit_session_event(
                    self, event, data, allow_stopping=True
                )
            except TypeError as error:
                # Keep lightweight test and embedding servers compatible with
                # the extended BridgeServer callback signature.
                if "allow_stopping" not in str(error):
                    raise
        return self.server.emit_session_event(self, event, data)

    def on_channel_transcript(self, channel: str, transcript: str) -> None:
        if not transcript:
            return
        orphans = self._orphan_translations.get(channel)
        if orphans:
            text = orphans.pop(0)
            sequence = self._emit_source_final(channel, transcript)
            if sequence is not None:
                self._pending_asr[channel] = [(seq, source) for seq, source in self._pending_asr[channel] if seq != sequence]
                self._emit_translation(channel, sequence, transcript, text)
            else:
                # Stopping can race the final transcript. Keep the completed
                # translation available until the source line is accepted.
                orphans.insert(0, text)
            return
        self._emit_source_final(channel, transcript)

    def on_channel_translation_partial(self, channel: str, response_key: str, text: str) -> None:
        if not text or self.stop_event.is_set():
            return
        self.server.emit_session_event(
            self,
            "translation.partial",
            {"channel": channel, "response_key": response_key, "text": text},
        )

    def on_channel_translation_done(self, channel: str, response_key: str, text: str) -> None:
        if not text:
            return
        mapping = self._response_seqs.get(channel, {})
        sequence = mapping.pop(response_key, None) if response_key else None
        if sequence is not None:
            self._emit_translation(channel, sequence, self._source_text.get(sequence, ""), text)
            return
        pending = self._pending_asr.get(channel)
        if pending:
            sequence, source_text = pending.pop(0)
            if response_key:
                mapping[response_key] = sequence
            self._emit_translation(channel, sequence, source_text, text)
            return
        # The model produced a translation before the transcript arrived; hold it
        # so the transcript can complete the same caption instead of creating a
        # second, source-less one.
        orphans = self._orphan_translations.setdefault(channel, [])
        orphans.append(text)
        del orphans[:-8]

    def _emit_source_final(self, channel: str, transcript: str) -> int | None:
        with self._lock:
            self._sequence += 1
            sequence = self._sequence
            self._source_text[sequence] = transcript
            self._pending_asr.setdefault(channel, []).append((sequence, transcript))
        if not self._emit_session_event(
            "source.final",
            {"source_seq": sequence, "text": transcript, "channel": channel},
            allow_stopping=True,
        ):
            with self._lock:
                self._source_text.pop(sequence, None)
                self._pending_asr[channel] = [
                    (seq, source)
                    for seq, source in self._pending_asr.get(channel, [])
                    if seq != sequence
                ]
            return None
        return sequence

    def _emit_translation(self, channel: str, sequence: int, source_text: str, text: str) -> None:
        self._emit_session_event(
            "translation",
            {
                "source_seq": sequence,
                "source_text": source_text,
                "text": text,
                "channel": channel,
            },
            allow_stopping=True,
        )
