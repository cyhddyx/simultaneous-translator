"""PulseAudio / PipeWire (``pipewire-pulse``) command helpers.

Linux has no WASAPI process-loopback API, so the engine routes audio through
PulseAudio objects instead:

* ``pactl`` inspects devices and loads/unloads the temporary routing modules;
* ``parec`` streams the raw 16 kHz mono capture used by ``system_capture``.

Everything here is either command construction or text parsing, so the unit
tests never need a live sound server.  ``docs/linux-audio-routing.md`` is the
authoritative design for the names and ordering used by the callers.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

# The design document pins these two user-facing messages.
TOOLS_MISSING_MESSAGE = (
    "未找到 PulseAudio 工具（pactl/parec），请安装 pulseaudio-utils 或 pipewire-pulse"
)
DEFAULT_SINK_MISSING_MESSAGE = "未找到系统默认播放设备"
DEFAULT_SOURCE_MISSING_MESSAGE = "未找到系统默认录音设备"

# ``pactl`` is a local socket round-trip; a stuck server must not hang a worker.
COMMAND_TIMEOUT_S = 10.0
_ERROR_DETAIL_LIMIT = 300

# A ``Runner`` mirrors ``run_pactl(*arguments)``; tests inject a fake one so the
# command construction is verified without touching the audio server.
Runner = Callable[..., str]


class PulseAudioError(RuntimeError):
    """A ``pactl`` invocation failed; the message is user facing."""


@dataclass(frozen=True)
class Device:
    """One PulseAudio sink or source as reported by ``pactl list``."""

    index: int
    name: str
    description: str
    channels: int
    sample_spec: str = ""
    is_monitor: bool = False


@dataclass(frozen=True)
class Module:
    """One loaded PulseAudio module from ``pactl list short modules``."""

    index: int
    name: str
    arguments: str


@dataclass(frozen=True)
class SinkInput:
    """One playback stream from ``pactl list sink-inputs``."""

    index: int
    process_id: int | None = None
    application: str = ""


def _tail(text: str, limit: int = _ERROR_DETAIL_LIMIT) -> str:
    text = " ".join(str(text or "").split())
    return text[-limit:]


def pactl_argv(*arguments: str) -> list[str]:
    return ["pactl", *arguments]


def build_parec_command(
    device: str,
    *,
    rate: int = 16_000,
    channels: int = 1,
    latency_msec: int = 100,
    client_name: str = "simultaneous-translator",
) -> list[str]:
    """Raw capture command: 16 kHz mono little-endian PCM, 100 ms latency."""

    return [
        "parec",
        f"--device={device}",
        "--format=s16le",
        f"--rate={rate}",
        f"--channels={channels}",
        "--raw",
        f"--latency-msec={latency_msec}",
        f"--client-name={client_name}",
    ]


def monitor_source(sink_name: str) -> str:
    """Map a sink name to its monitor source name (``<sink>.monitor``)."""

    return sink_name if sink_name.endswith(".monitor") else f"{sink_name}.monitor"


def require_tools() -> None:
    """Fail early with the documented message when ``pactl``/``parec`` is absent."""

    if any(shutil.which(tool) is None for tool in ("pactl", "parec")):
        raise PulseAudioError(TOOLS_MISSING_MESSAGE)


def run_pactl(*arguments: str, check: bool = True) -> str:
    """Run one ``pactl`` command and return its stdout (stripped).

    ``check`` keeps the callers that intentionally tolerate a failure (moving a
    stream that just disappeared) from raising on a race.
    """

    argv = pactl_argv(*arguments)
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PulseAudioError(TOOLS_MISSING_MESSAGE) from exc
    except subprocess.TimeoutExpired as exc:
        raise PulseAudioError(f"PulseAudio 命令超时：{' '.join(argv)}") from exc
    if check and completed.returncode != 0:
        detail = _tail(completed.stderr) or _tail(completed.stdout) or "未知错误"
        raise PulseAudioError(f"PulseAudio 命令失败（{' '.join(argv)}）：{detail}")
    return completed.stdout.strip()


def get_default_sink() -> str:
    sink = run_pactl("get-default-sink")
    if not sink:
        raise PulseAudioError(DEFAULT_SINK_MISSING_MESSAGE)
    return sink


def get_default_source() -> str:
    source = run_pactl("get-default-source")
    if not source:
        raise PulseAudioError(DEFAULT_SOURCE_MISSING_MESSAGE)
    return source


def set_default_sink(name: str) -> None:
    run_pactl("set-default-sink", name)


def parse_devices(text: str) -> list[Device]:
    """Parse the verbose ``pactl list sinks`` / ``pactl list sources`` output."""

    devices: list[Device] = []
    current: dict[str, object] | None = None

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        try:
            index = int(current.get("index", -1))
        except (TypeError, ValueError):
            index = -1
        name = str(current.get("name", "") or "")
        if index >= 0 and name:
            sample_spec = str(current.get("sample_spec", "") or "")
            devices.append(
                Device(
                    index=index,
                    name=name,
                    description=str(current.get("description", "") or name),
                    channels=_channel_count(sample_spec),
                    sample_spec=sample_spec,
                    is_monitor=name.endswith(".monitor"),
                )
            )
        current = None

    for line in text.splitlines():
        header = re.match(r"^(?:Sink|Source)\s+#(\d+)\s*$", line)
        if header:
            flush()
            current = {"index": int(header.group(1))}
            continue
        if current is None or not line[:1].isspace():
            continue
        key, separator, value = line.strip().partition(":")
        if not separator:
            continue
        key = key.strip().lower()
        if key == "name":
            current.setdefault("name", value.strip())
        elif key == "description":
            current.setdefault("description", value.strip())
        elif key == "sample specification":
            current.setdefault("sample_spec", value.strip())
    flush()
    return devices


def _channel_count(sample_spec: str) -> int:
    match = re.search(r"(\d+)\s*ch", sample_spec)
    if match:
        try:
            return max(1, int(match.group(1)))
        except ValueError:
            return 1
    return 1


def list_sinks(*, runner: Runner | None = None) -> list[Device]:
    return parse_devices((runner or run_pactl)("list", "sinks"))


def list_sources(*, runner: Runner | None = None) -> list[Device]:
    return parse_devices((runner or run_pactl)("list", "sources"))


def sink_description(name: str, *, runner: Runner | None = None) -> str:
    """Friendly name for one sink, falling back to its PulseAudio name."""

    try:
        for sink in list_sinks(runner=runner):
            if sink.name == name:
                return sink.description or name
    except PulseAudioError:
        pass
    return name


def parse_short_modules(text: str) -> list[Module]:
    """Parse tab-separated ``pactl list short modules`` output."""

    modules: list[Module] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        try:
            index = int(parts[0].strip())
        except ValueError:
            continue
        name = parts[1].strip()
        if not name:
            continue
        arguments = " ".join(part.strip() for part in parts[2:] if part.strip())
        modules.append(Module(index=index, name=name, arguments=arguments))
    return modules


def list_modules(*, runner: Runner | None = None) -> list[Module]:
    return parse_short_modules((runner or run_pactl)("list", "short", "modules"))


def load_module(
    name: str,
    arguments: Sequence[str] = (),
    *,
    runner: Runner | None = None,
) -> int:
    """Load one module and return its numeric module index."""

    output = (runner or run_pactl)("load-module", name, *arguments).strip()
    tokens = [token for token in output.split() if token]
    try:
        return int(tokens[-1])
    except (IndexError, ValueError) as exc:
        raise PulseAudioError(
            f"加载 PulseAudio 模块 {name} 失败：{_tail(output) or '没有返回模块编号'}"
        ) from exc


def unload_module(module_id: int, *, runner: Runner | None = None) -> None:
    (runner or run_pactl)("unload-module", str(module_id))


def parse_sink_inputs(text: str) -> list[SinkInput]:
    """Parse the verbose ``pactl list sink-inputs`` output.

    Only the stream index and the owning process are needed: the isolated
    capture moves other applications' streams into the mix sink, but never its
    own translated voice (which must stay on the user's playback device).
    """

    applications: list[dict[str, int | str]] = []
    current: dict[str, int | str] | None = None
    for line in text.splitlines():
        header = re.match(r"^Sink Input\s+#(\d+)\s*$", line)
        if header:
            if current is not None:
                applications.append(current)
            current = {"index": int(header.group(1))}
            continue
        if current is None or not line[:1].isspace():
            continue
        key, separator, value = line.strip().partition("=")
        if not separator:
            continue
        key = key.strip()
        claim = value.strip().strip('"')
        if key in ("application.process.id", "application.name"):
            current.setdefault(key, claim)
    if current is not None:
        applications.append(current)

    inputs: list[SinkInput] = []
    for item in applications:
        process_id: int | None = None
        raw_pid = item.get("application.process.id")
        if raw_pid not in (None, ""):
            try:
                process_id = int(str(raw_pid))
            except ValueError:
                process_id = None
        inputs.append(
            SinkInput(
                index=int(item["index"]),
                process_id=process_id,
                application=str(item.get("application.name", "") or ""),
            )
        )
    return inputs


def move_sink_inputs_to(
    sink: str,
    *,
    skip_process_ids: Iterable[int] = (),
    runner: Runner | None = None,
) -> list[int]:
    """Move existing playback streams onto ``sink``.

    Streams owned by the listed processes are skipped: those are this engine's
    translated voices, which must keep playing on the user's device and must
    never be captured back into the model.
    """

    command = runner or run_pactl
    skipped = {int(pid) for pid in skip_process_ids}
    moved: list[int] = []
    for stream in parse_sink_inputs(command("list", "sink-inputs")):
        if stream.process_id is not None and stream.process_id in skipped:
            continue
        try:
            command("move-sink-input", str(stream.index), sink)
        except PulseAudioError:
            # The stream may have ended between list and move; that is fine.
            continue
        moved.append(stream.index)
    return moved
