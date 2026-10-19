"""PulseAudio / PipeWire capture for the "系统声音（排除本软件）" listener.

The Windows engine captures a WASAPI process loopback.  Linux has no equivalent
exclusion API, so the same guarantee is built from PulseAudio routing
(``docs/linux-audio-routing.md``):

1. remember the user's default sink, then load a private ``translator_mix``
   null sink and a loopback that plays it back to that user sink;
2. make ``translator_mix`` the default sink and move the already playing
   streams into it, so other applications are captured while the user still
   hears them through the loopback;
3. capture ``translator_mix.monitor`` with ``parec``: 16 kHz mono s16le,
   100 ms (3200 byte) frames, exposed as ``(1600, 1) float32`` just like the
   Windows reader.

The translated voice never follows the default sink (``livetranslate`` binds it
to the user's playback device explicitly), which is what keeps it out of the
model input.  The module ids are journaled to ``audio-session.json`` so a crash
can be cleaned up on the next start.

``device=`` switches the reader to the plain "指定播放设备回环" mode: it captures
an existing ``<sink>.monitor`` directly and loads no modules at all.
"""

from __future__ import annotations

import collections
import contextlib
import json
import logging
import os
from pathlib import Path
import queue
import subprocess
import threading
from typing import Any

import numpy as np

import pulse_audio


logger = logging.getLogger(__name__)

# ---- Capture format -------------------------------------------------------
# The model protocol is 16 kHz mono PCM16 and the capture loop consumes 100 ms
# frames, so one parec read and one ``record(1600)`` are exactly 3200 bytes.
SAMPLE_RATE = 16_000
FRAME_SECONDS = 0.1
FRAME_SAMPLES = 1_600
FRAME_BYTES = FRAME_SAMPLES * 2
QUEUE_DEPTH = 3  # newest three frames only; the oldest is dropped when behind
STARTUP_TIMEOUT_S = 8.0

# ---- PulseAudio object names ---------------------------------------------
DEFAULT_PREFIX = "translator"
MIX_DESCRIPTION = "TranslatorSystemMix"
LOOPBACK_LATENCY_MSEC = 20

# ---- Crash-recovery state file -------------------------------------------
APP_STATE_DIRECTORY = "simultaneous-translator"
STATE_FILE_NAME = "audio-session.json"


def mix_sink_name(prefix: str = DEFAULT_PREFIX) -> str:
    return f"{prefix}_mix"


def mix_monitor_name(prefix: str = DEFAULT_PREFIX) -> str:
    return f"{mix_sink_name(prefix)}.monitor"


def build_parec_command(device: str) -> list[str]:
    """The exact capture command; kept importable for the unit tests."""

    return pulse_audio.build_parec_command(
        device,
        rate=SAMPLE_RATE,
        channels=1,
        latency_msec=int(FRAME_SECONDS * 1000),
    )


def decode_frame(data: bytes) -> np.ndarray:
    """Convert one little-endian PCM16 frame into ``(1600, 1) float32``."""

    samples = np.frombuffer(data, dtype="<i2").astype("float32") / 32768.0
    return samples.reshape(-1, 1)


# ---------------------------------------------------------------------------
# State file (``$XDG_STATE_HOME/simultaneous-translator/audio-session.json``)
# ---------------------------------------------------------------------------


def state_file_path(override: str | Path | None = None) -> Path:
    if override is not None:
        return Path(override)
    xdg_state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg_state_home).expanduser() if xdg_state_home else Path.home() / ".local" / "state"
    return base / APP_STATE_DIRECTORY / STATE_FILE_NAME


def read_state(path: str | Path | None = None) -> dict[str, Any] | None:
    """Return the journaled session, or ``None`` when it is absent/broken."""

    state_path = state_file_path(path)
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def write_state(
    default_sink: str,
    modules: dict[str, int],
    path: str | Path | None = None,
    *,
    pid: int | None = None,
) -> Path:
    state_path = state_file_path(path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "default_sink": default_sink,
        "modules": dict(modules),
        # Journaling the owner lets a later engine start tell a *crashed*
        # session from one that is still capturing in another process.
        "pid": os.getpid() if pid is None else int(pid),
    }
    state_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return state_path


def clear_state(path: str | Path | None = None) -> None:
    with contextlib.suppress(OSError):
        state_file_path(path).unlink()


def _pid_alive(pid: int) -> bool:
    """Whether ``pid`` is a live process (used to skip cleanup of a live app)."""

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# ---------------------------------------------------------------------------
# Crash recovery
# ---------------------------------------------------------------------------


def _module_indexes(modules: list[pulse_audio.Module], name: str, needle: str) -> list[int]:
    return [
        module.index
        for module in modules
        if module.name == name and needle in module.arguments
    ]


def cleanup_stale_session(
    prefix: str = DEFAULT_PREFIX,
    *,
    path: str | Path | None = None,
) -> list[int]:
    """Remove modules left behind by a crash and restore the default sink.

    Only ``<prefix>_mix`` belongs to the isolated capture; the virtual
    microphone modules (``translator_mic``) are owned by the native shell and
    are deliberately never touched here.
    """

    mix_sink = mix_sink_name(prefix)
    mix_monitor = mix_monitor_name(prefix)
    state = read_state(path)
    # A live engine in another process keeps its capture running: the journal
    # is not stale, it simply belongs to that process (probe sidecars start a
    # second engine while the user is translating).  Never tear it down.
    if isinstance(state, dict):
        journaled_pid = state.get("pid")
        if (
            isinstance(journaled_pid, int)
            and journaled_pid != os.getpid()
            and _pid_alive(journaled_pid)
        ):
            logger.warning(
                "另一个进程（pid=%s）正在进行系统声音采集，跳过残留清理", journaled_pid
            )
            return []
    modules = pulse_audio.list_modules()

    loopback_ids = set(_module_indexes(modules, "module-loopback", f"source={mix_monitor}"))
    sink_ids = set(_module_indexes(modules, "module-null-sink", f"sink_name={mix_sink}"))
    journaled = (state or {}).get("modules") if isinstance(state, dict) else None
    if isinstance(journaled, dict):
        for key, target in (("loopback", loopback_ids), ("mix", sink_ids)):
            try:
                target.add(int(journaled[key]))
            except (KeyError, TypeError, ValueError):
                pass
    existing = {module.index for module in modules}
    loopback_ids &= existing
    sink_ids &= existing

    original_default = ""
    if isinstance(state, dict):
        original_default = str(state.get("default_sink", "") or "")
    if original_default:
        current_default = ""
        with contextlib.suppress(pulse_audio.PulseAudioError):
            current_default = pulse_audio.get_default_sink()
        if current_default == mix_sink:
            sinks = {sink.name for sink in pulse_audio.list_sinks()}
            if original_default in sinks:
                try:
                    pulse_audio.set_default_sink(original_default)
                except pulse_audio.PulseAudioError as error:  # pragma: no cover - best effort
                    logger.warning("恢复默认播放设备失败：%s", error)

    removed: list[int] = []
    # Unload the loopback before the null sink; unloading the sink first would
    # leave the loopback pointing at a disappeared source for a moment.
    for module_id in sorted(loopback_ids) + sorted(sink_ids):
        try:
            pulse_audio.unload_module(module_id)
        except pulse_audio.PulseAudioError as error:
            logger.warning("卸载残留 PulseAudio 模块 %s 失败：%s", module_id, error)
            continue
        removed.append(module_id)
    clear_state(path)
    return removed


# ---------------------------------------------------------------------------
# One isolated-capture session
# ---------------------------------------------------------------------------

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_CAPTURE: "SystemCapture | None" = None
_START_LOCK = threading.Lock()


def active_original_default_sink() -> str:
    """The user's playback sink a live isolated capture plays back to.

    ``livetranslate`` uses this to bind the translated voice explicitly instead
    of letting it follow the temporarily switched default sink.
    """

    with _ACTIVE_LOCK:
        capture = _ACTIVE_CAPTURE
        return capture.original_default_sink if capture is not None else ""


def _set_active_capture(capture: "SystemCapture | None") -> None:
    global _ACTIVE_CAPTURE
    with _ACTIVE_LOCK:
        _ACTIVE_CAPTURE = capture


class SystemCapture:
    """Reader compatible with the Windows engine's ``record(1600)`` contract.

    ``record`` yields one 100 ms ``(1600, 1) float32`` frame from a bounded
    queue (depth 3, the oldest frame is dropped), ``close`` is idempotent and
    always runs the shutdown sequence, and the object is a context manager.
    """

    def __init__(
        self,
        startup_timeout: float = STARTUP_TIMEOUT_S,
        *,
        device: str | None = None,
        prefix: str = DEFAULT_PREFIX,
        state_path: str | Path | None = None,
    ) -> None:
        self._timeout = startup_timeout
        # ``None`` means isolated capture (load the mix modules); a monitor
        # source name means direct "指定播放设备回环" capture.
        self._direct_device = device
        self._prefix = prefix
        self._state_path = state_path
        self._mix_sink = mix_sink_name(prefix)
        self._mix_monitor = mix_monitor_name(prefix)
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._stderr_lock = threading.Lock()
        self._stderr_chunks: collections.deque[bytes] = collections.deque(maxlen=8)
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._frames: queue.Queue[Any] = queue.Queue(maxsize=QUEUE_DEPTH)
        self._error: str | None = None
        self._close_lock = threading.Lock()
        self._default_sink = ""
        self._modules: dict[str, int] = {}
        self._active = False

    # ------------------------------------------------------------- properties

    @property
    def is_isolated(self) -> bool:
        return self._direct_device is None

    @property
    def original_default_sink(self) -> str:
        return self._default_sink

    @property
    def mix_sink(self) -> str:
        return self._mix_sink

    # ------------------------------------------------------------- lifecycle

    def __enter__(self) -> "SystemCapture":
        try:
            pulse_audio.require_tools()
            if self.is_isolated:
                self._start_isolated()
            self._start_capture_process()
            if not self._ready.wait(self._timeout):
                self.close()
                raise RuntimeError(self._startup_timeout_message())
            if self._error:
                error = self._error
                self.close()
                raise RuntimeError(error)
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def _startup_timeout_message(self) -> str:
        if self.is_isolated:
            return "隔离采集启动超时，请检查音频服务"
        return "回环采集启动超时，请检查音频服务"

    def _start_isolated(self) -> None:
        # The mix sink is process-wide routing, so two channels cannot own it at
        # the same time.  Serialize the whole startup and report the conflict
        # instead of loading a second module with the same sink name.
        with _START_LOCK:
            if active_original_default_sink():
                raise RuntimeError(
                    "系统声音采集已在另一通道运行，请勿同时启用两个系统声音通道"
                )
            cleanup_stale_session(self._prefix, path=self._state_path)
            self._default_sink = pulse_audio.get_default_sink()
            mix_id = pulse_audio.load_module(
                "module-null-sink",
                [
                    f"sink_name={self._mix_sink}",
                    f"sink_properties=device.description={MIX_DESCRIPTION}",
                ],
            )
            self._modules["mix"] = mix_id
            loopback_id = pulse_audio.load_module(
                "module-loopback",
                [
                    f"source={self._mix_monitor}",
                    f"sink={self._default_sink}",
                    f"latency_msec={LOOPBACK_LATENCY_MSEC}",
                    "source_dont_move=true",
                    "sink_dont_move=true",
                ],
            )
            self._modules["loopback"] = loopback_id
            pulse_audio.set_default_sink(self._mix_sink)
            write_state(self._default_sink, self._modules, self._state_path)
            # Best effort: streams that vanish between list and move are ignored.
            pulse_audio.move_sink_inputs_to(
                self._mix_sink,
                skip_process_ids=(os.getpid(),),
            )
            self._active = True
            _set_active_capture(self)

    def _start_capture_process(self) -> None:
        device = self._direct_device if self._direct_device is not None else self._mix_monitor
        try:
            self._process = subprocess.Popen(
                build_parec_command(device),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(pulse_audio.TOOLS_MISSING_MESSAGE) from exc
        except OSError as exc:
            raise RuntimeError(f"无法启动系统声音采集：{exc}") from exc
        self._reader = threading.Thread(
            target=self._read,
            name="system-audio-reader",
            daemon=True,
        )
        self._reader.start()
        self._stderr_reader = threading.Thread(
            target=self._drain_stderr,
            name="system-audio-stderr",
            daemon=True,
        )
        self._stderr_reader.start()

    # ---------------------------------------------------------------- reader

    def _read(self) -> None:
        try:
            stdout = self._process.stdout if self._process is not None else None
            if stdout is None:
                raise RuntimeError("系统声音采集没有可读的输出管道")
            while not self._closed.is_set():
                data = stdout.read(FRAME_BYTES)
                if len(data) != FRAME_BYTES:
                    raise RuntimeError(self._interrupted_message())
                frame = decode_frame(data)
                if self._frames.full():
                    with contextlib.suppress(queue.Empty):
                        self._frames.get_nowait()
                with contextlib.suppress(queue.Full):
                    self._frames.put_nowait(frame)
                self._ready.set()
        except Exception as error:  # noqa: BLE001 - surfaced through record()
            if not self._closed.is_set():
                self._error = str(error)
        finally:
            self._ready.set()

    def _drain_stderr(self) -> None:
        stderr = self._process.stderr if self._process is not None else None
        if stderr is None:
            return
        try:
            while True:
                chunk = stderr.read(512)
                if not chunk:
                    return
                with self._stderr_lock:
                    self._stderr_chunks.append(chunk)
        except (OSError, ValueError):
            return

    def _stderr_detail(self) -> str:
        with self._stderr_lock:
            data = b"".join(self._stderr_chunks)
        return data.decode("utf-8", errors="replace").strip()

    def _interrupted_message(self) -> str:
        base = (
            "系统声音采集已中断，请重新开始同传"
            if self.is_isolated
            else "回环音频采集已中断，请重新开始同传"
        )
        detail = self._stderr_detail()
        return f"{base}：{detail}" if detail else base

    def record(self, numframes: int) -> np.ndarray:
        """Return the next 100 ms frame, or zeros after ``close``."""

        if numframes != FRAME_SAMPLES:
            raise ValueError("System capture uses 100 ms frames at 16 kHz")
        while not self._closed.is_set():
            if self._error:
                raise RuntimeError(self._error)
            try:
                return self._frames.get(timeout=0.2)
            except queue.Empty:
                continue
        return np.zeros((numframes, 1), dtype="float32")

    # --------------------------------------------------------------- shutdown

    def close(self) -> None:
        with self._close_lock:
            self._close()

    def _close(self) -> None:
        self._closed.set()
        self._stop_capture_process()
        if self.is_isolated:
            self._restore_audio()
        self._ready.set()

    def _stop_capture_process(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            if self._reader is not None:
                self._reader.join(timeout=2)
            self._reader = None
            return
        if process.stdin is not None:
            with contextlib.suppress(OSError, ValueError):
                process.stdin.close()
        if process.poll() is None:
            with contextlib.suppress(OSError):
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(OSError):
                    process.kill()
                with contextlib.suppress(subprocess.TimeoutExpired, OSError):
                    process.wait(timeout=2)
        if self._reader is not None:
            self._reader.join(timeout=2)
            self._reader = None
        if self._stderr_reader is not None:
            self._stderr_reader.join(timeout=1)
            self._stderr_reader = None
        for stream in (process.stdout, process.stderr):
            with contextlib.suppress(OSError, ValueError):
                if stream is not None:
                    stream.close()

    def _restore_audio(self) -> None:
        self._active = False
        _set_active_capture(None)
        original = self._default_sink
        if original:
            current = ""
            with contextlib.suppress(Exception):
                current = pulse_audio.get_default_sink()
            if current != original:
                try:
                    pulse_audio.set_default_sink(original)
                except pulse_audio.PulseAudioError as error:
                    # The original device may have been unplugged meanwhile.
                    logger.warning("恢复默认播放设备 %s 失败：%s", original, error)
        modules = dict(self._modules)
        # Loopback first, then the null sink: unloading the sink first would
        # leave the loopback pointing at a source that no longer exists.
        for key in ("loopback", "mix"):
            module_id = modules.get(key)
            if module_id is None:
                continue
            try:
                pulse_audio.unload_module(module_id)
            except pulse_audio.PulseAudioError as error:
                logger.warning("卸载 PulseAudio 模块 %s 失败：%s", module_id, error)
        self._modules.clear()
        self._default_sink = ""
        clear_state(self._state_path)


def cleanup_from_environment() -> list[int]:
    """Best-effort stale-session cleanup used by the bridge while it starts."""

    try:
        return cleanup_stale_session()
    except Exception:  # noqa: BLE001 - never block the JSONL protocol on cleanup
        logger.warning("启动时清理残留音频模块失败", exc_info=True)
        return []
