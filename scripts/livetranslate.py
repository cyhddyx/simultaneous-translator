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

Translated text arrives through ``response.text.text`` (text-only modality) or
``response.audio_transcript.text`` (text + audio).  Note that these are *not*
the ``response.text.delta`` events of the full-duplex Omni models.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import queue
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

DEFAULT_LIVETRANSLATE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
DEFAULT_LIVETRANSLATE_MODEL = "qwen3.5-livetranslate-flash-realtime"
LIVETRANSLATE_PROTOCOLS = ("livetranslate",)

CHANNEL_IDS = ("listen", "speak")
INPUT_KINDS = ("loopback", "microphone")
VOICE_CLONE_FREQUENCIES = ("never", "once", "always")

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
ASR_MODEL = "qwen3-asr-flash-realtime"

_LANGUAGE_CODES = {
    "自动检测": "auto",
    "自动": "auto",
    "简体中文": "zh",
    "中文": "zh",
    "繁體中文": "zh",
    "粤语": "yue",
    "英语": "en",
    "日语": "ja",
    "韓語": "ko",
    "韩语": "ko",
    "俄语": "ru",
    "法语": "fr",
    "德语": "de",
    "葡萄牙语": "pt",
    "西班牙语": "es",
    "意大利语": "it",
    "印尼语": "id",
    "越南语": "vi",
    "泰语": "th",
    "阿拉伯语": "ar",
    "印地语": "hi",
    "希腊语": "el",
    "土耳其语": "tr",
}

_ENGLISH_LANGUAGE_CODES = {
    "auto": "auto",
    "automatic": "auto",
    "chinese": "zh",
    "mandarin": "zh",
    "cantonese": "yue",
    "english": "en",
    "japanese": "ja",
    "korean": "ko",
    "russian": "ru",
    "french": "fr",
    "german": "de",
    "portuguese": "pt",
    "spanish": "es",
    "italian": "it",
    "indonesian": "id",
    "vietnamese": "vi",
    "thai": "th",
    "arabic": "ar",
    "hindi": "hi",
    "greek": "el",
    "turkish": "tr",
}

_KNOWN_LANGUAGE_CODES = frozenset(
    value for value in list(_LANGUAGE_CODES.values()) + list(_ENGLISH_LANGUAGE_CODES.values())
)


def language_code(value: Any, default: str = "en") -> str:
    """Map a UI language label (or an ISO code) to the model's language code."""

    text = value.strip() if isinstance(value, str) else ""
    if not text:
        return default
    lowered = text.lower()
    if lowered in _KNOWN_LANGUAGE_CODES:
        return lowered
    for table in (_LANGUAGE_CODES, _ENGLISH_LANGUAGE_CODES):
        if text in table:
            return table[text]
        if lowered in table:
            return table[lowered]
    return default


@dataclass(frozen=True)
class RealtimeOptions:
    """Session-wide realtime model options shared by every channel."""

    voice: str = ""
    enable_voice_clone: bool = False
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
    listen_default_input: str = "loopback",
    speak_default_input: str = "microphone",
) -> tuple[ChannelSpec, ...]:
    """Build both channel specifications from the ``audio`` config object.

    Unknown or malformed fields fall back to a working default instead of
    failing the session, because a bad device id is already recoverable at
    runtime and should not cost the user the other channel.
    """

    table = raw if isinstance(raw, dict) else {}
    specs: list[ChannelSpec] = []
    for channel in CHANNEL_IDS:
        entry = table.get(channel)
        entry = entry if isinstance(entry, dict) else {}
        default_input = listen_default_input if channel == "listen" else speak_default_input
        target = _field(entry, "target_language")
        if not isinstance(target, str) or not target.strip():
            target = default_target_language
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
                play_audio=_flag(_field(entry, "play_audio"), True),
            )
        )
    return tuple(specs)


def enabled_channels(specs: tuple[ChannelSpec, ...]) -> tuple[ChannelSpec, ...]:
    return tuple(spec for spec in specs if spec.enabled)


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

    def __init__(self, device_id: str, channel: str) -> None:
        super().__init__(name=f"livetranslate-player-{channel}", daemon=True)
        self._device_id = device_id
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=PLAYER_QUEUE_CHUNKS)
        self._stop = threading.Event()
        self.error: BaseException | None = None

    def push(self, samples: Any) -> None:
        """Queue one decoded delta, dropping the oldest audio when behind."""

        if self._stop.is_set():
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
        self._stop.set()
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(None)

    def run(self) -> None:
        _ensure_com_initialized()
        try:
            import soundcard as sc

            speaker = (
                sc.get_speaker(self._device_id) if self._device_id else sc.default_speaker()
            )
            if speaker is None:
                raise RuntimeError("未找到可用的播放设备")
            with speaker.player(samplerate=OUTPUT_SAMPLE_RATE, channels=1) as player:
                while not self._stop.is_set():
                    try:
                        item = self._queue.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if item is None:
                        break
                    player.play(item)
        except BaseException as exc:  # noqa: BLE001 - reported to the session
            self.error = exc


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
        self._loop: asyncio.AbstractEventLoop | None = None
        self._updated = False
        self._variant = 0

    # ------------------------------------------------------------------ thread

    def run(self) -> None:
        _ensure_com_initialized()
        try:
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
                self._loop.call_soon_threadsafe(lambda: None)
        if self._player is not None:
            self._player.stop()

    # -------------------------------------------------------------- async main

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=f"livetranslate-capture-{self._spec.channel}"
        )
        device = await self._loop.run_in_executor(pool, self._open_input)
        if device is None:
            pool.shutdown(wait=False)
            self._report_failure("audio_device_missing", f"{self._spec.label}通道未找到可用的输入设备")
            return

        recorder, device_info = device
        ws_url = f"{self._base_url}?model={self._model}"
        connector = _build_connector(ws_url, self._api_key)

        async with connector as websocket:
            await self._send_session_update(websocket)
            if self._spec.play_audio:
                self._player = _PcmPlayer(self._spec.output_device, self._spec.channel)
                self._player.start()

            self._server.on_realtime_channel(
                self._session, self._spec.channel, "capturing", device=device_info
            )
            self._session.mark_channel_ready(self._spec.channel)

            reader = asyncio.create_task(self._receive_loop(websocket))
            try:
                with recorder:
                    self._server.on_realtime_channel(self._session, self._spec.channel, "streaming")
                    await self._capture_loop(websocket, pool, recorder)
            finally:
                await self._finish(websocket)
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader
                pool.shutdown(wait=False)

    def _open_input(self) -> tuple[Any, dict[str, Any]] | None:
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

        loop = asyncio.get_running_loop()
        counter = 0
        while not self._session.stop_event.is_set():
            audio = await loop.run_in_executor(pool, recorder.record, FRAME_SAMPLES)
            if self._session.stop_event.is_set():
                break
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

    def _session_variants(self) -> list[dict[str, Any]]:
        target = language_code(self._spec.target_language, "en")
        modalities = ["text", "audio"] if self._spec.play_audio else ["text"]
        modern = "3.8" in self._model
        legacy: dict[str, Any] = {
            "modalities": modalities,
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "sample_rate": INPUT_SAMPLE_RATE,
            "input_audio_transcription": {"model": ASR_MODEL},
            "translation": {"language": target},
        }
        modern_body: dict[str, Any] = {
            "output_modalities": modalities,
            "translation": {"language": target},
        }
        source = language_code(self._session.config.source_language, "auto")
        if source != "auto":
            legacy["input_audio_transcription"]["language"] = source
            modern_body["input_audio_transcription"] = {"language": source}
        if self._options.enable_voice_clone:
            options = {
                "enable_voice_clone": True,
                "voice_clone_options": {"frequency": self._options.voice_clone_frequency},
            }
            legacy.update(options)
            modern_body.update(options)
        voice = self._options.voice.strip()
        if self._options.enable_voice_clone and not voice:
            voice = "default"
        if voice:
            legacy["voice"] = voice
            modern_body["voice"] = voice

        primary, secondary = (modern_body, legacy) if modern else (legacy, modern_body)
        minimal: dict[str, Any] = {"translation": {"language": target}}
        minimal["output_modalities" if modern else "modalities"] = modalities
        return [primary, secondary, minimal]

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
            self._updated = True
            return
        if event_type == "error":
            self._handle_protocol_error(event, websocket)
            return
        if event_type == "session.finished":
            self._finished.set()
            return

        if event_type == "conversation.item.input_audio_transcription.text":
            self._on_source_partial(event)
            return
        if event_type == "conversation.item.input_audio_transcription.completed":
            self._session.on_channel_transcript(self._spec.channel, _event_text(event, "transcript"))
            return
        if event_type in ("response.audio_transcript.text", "response.text.text"):
            self._session.on_channel_translation_partial(
                self._spec.channel, _response_key(event), _event_text(event, "text")
            )
            return
        if event_type in ("response.audio_transcript.done", "response.text.done"):
            self._session.on_channel_translation_done(
                self._spec.channel, _response_key(event), _event_text(event, "text")
            )
            return
        if event_type == "response.audio.delta":
            self._on_audio_delta(event)
            return

    def _handle_protocol_error(self, event: dict[str, Any], websocket: Any) -> None:
        detail = _event_error_message(event)
        if not self._updated and self._variant + 1 < len(self._session_variants()):
            # The 3.5 and 3.8 generations disagree on ``modalities`` versus
            # ``output_modalities``; fall forward instead of failing the session.
            self._variant += 1
            asyncio.get_running_loop().create_task(self._send_session_update(websocket))
            return
        self._report_failure("realtime_protocol_error", f"{self._spec.label}通道被模型拒绝：{detail}")

    def _on_source_partial(self, event: dict[str, Any]) -> None:
        text = _event_text(event, "text") + _event_text(event, "stash")
        if not text:
            return
        self._server.emit_session_event(
            self._session,
            "source.partial",
            {"text": text, "channel": self._spec.channel},
        )

    def _on_audio_delta(self, event: dict[str, Any]) -> None:
        if self._player is None:
            return
        encoded = event.get("delta")
        if not isinstance(encoded, str) or not encoded:
            return
        try:
            raw = base64.b64decode(encoded, validate=False)
        except Exception:  # noqa: BLE001 - a malformed delta is not fatal
            return
        if not raw:
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

    def _report_failure(self, code: str, message: str) -> None:
        if self._failed:
            return
        self._failed = True
        self._server.on_realtime_channel(self._session, self._spec.channel, "failed", detail=message)
        self._server.emit_session_error(
            self._session,
            scope="translation",
            code=code,
            message=message,
            recoverable=True,
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
    for key in ("response_id", "item_id", "event_id"):
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
        self.server = server
        self.session_id = session_id
        self.config = config
        self.stop_event = threading.Event()
        self.state = "starting"
        self.specs = specs
        self.startup_timeout_s = startup_timeout_s
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
        threading.Thread(
            target=self._watch_audio_startup,
            name=f"livetranslate-startup-{self.session_id[:8]}",
            daemon=True,
        ).start()

    def _watch_audio_startup(self) -> None:
        # Unlike the pipeline, one failing channel must not hide the other, so
        # the watchdog only settles once every channel has reported in.
        if not self._audio_startup_settled.wait(self.startup_timeout_s):
            self.server.on_audio_startup_timeout(self)

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

    def on_channel_transcript(self, channel: str, transcript: str) -> None:
        if not transcript or self.stop_event.is_set():
            return
        orphans = self._orphan_translations.get(channel)
        if orphans:
            text = orphans.pop(0)
            sequence = self._emit_source_final(channel, transcript)
            if sequence is not None:
                self._emit_translation(channel, sequence, transcript, text)
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
        if self.stop_event.is_set():
            return
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
        if not self.server.emit_session_event(
            self,
            "source.final",
            {"source_seq": sequence, "text": transcript, "channel": channel},
        ):
            return None
        return sequence

    def _emit_translation(self, channel: str, sequence: int, source_text: str, text: str) -> None:
        self.server.emit_session_event(
            self,
            "translation",
            {
                "source_seq": sequence,
                "source_text": source_text,
                "text": text,
                "channel": channel,
            },
        )
