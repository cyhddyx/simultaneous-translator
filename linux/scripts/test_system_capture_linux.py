"""Offline unit tests for the Linux ``system_capture`` module.

The parec process and every ``pactl`` call are faked, so these tests exercise
the frame decoder, the crash-recovery journal, the shutdown ordering and the
Chinese error mapping without a running sound server.  The real PulseAudio
round-trip lives in ``test_pulse_integration.py``.
"""

from __future__ import annotations

import json
import os
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import pulse_audio
import system_capture
from system_capture import SystemCapture


class BlockingStdout:
    """Feeds one chunk, then blocks like a live parec pipe until terminated."""

    def __init__(self, first: bytes, stopping: threading.Event) -> None:
        self._first = first
        self._read_once = False
        self._stopping = stopping

    def read(self, _size: int) -> bytes:
        if not self._read_once:
            self._read_once = True
            return self._first
        self._stopping.wait()
        return b""

    def close(self) -> None:
        self._stopping.set()


class FakeProcess:
    def __init__(self, stdout_bytes: bytes = b"", stderr_bytes: bytes = b"") -> None:
        self._stopping = threading.Event()
        self.stdout = BlockingStdout(stdout_bytes, self._stopping)
        self.stderr = BlockingStdout(stderr_bytes, self._stopping)
        self.stdin = None
        self._returncode: int | None = 0 if stdout_bytes == b"" else None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self._returncode

    def terminate(self) -> None:
        self.terminated = True
        self._returncode = -15
        self._stopping.set()

    def kill(self) -> None:
        self.killed = True
        self._returncode = -9
        self._stopping.set()

    def wait(self, timeout: float | None = None) -> int:
        self._stopping.set()
        if self._returncode is None:
            self._returncode = 0
        return self._returncode


def _frame_bytes(value: int = 0x4000) -> bytes:
    return np.full(1600, value, dtype="<i2").tobytes()


class StateFileTests(unittest.TestCase):
    def test_state_path_uses_xdg_state_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"XDG_STATE_HOME": temporary}):
                path = system_capture.state_file_path()
        self.assertEqual(
            path,
            Path(temporary) / "simultaneous-translator" / "audio-session.json",
        )

    def test_state_roundtrip_and_clear(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            written = system_capture.write_state(
                "alsa_output.pci", {"mix": 22, "loopback": 23}, state_path, pid=1234
            )
            self.assertEqual(written, state_path)
            self.assertEqual(
                json.loads(state_path.read_text(encoding="utf-8")),
                {
                    "default_sink": "alsa_output.pci",
                    "modules": {"mix": 22, "loopback": 23},
                    "pid": 1234,
                },
            )
            self.assertEqual(
                system_capture.read_state(state_path)["default_sink"], "alsa_output.pci"
            )
            system_capture.clear_state(state_path)
            self.assertFalse(state_path.exists())
            # Clearing an absent journal is a no-op, never an error.
            system_capture.clear_state(state_path)

    def test_broken_state_file_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            state_path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(system_capture.read_state(state_path))


class FrameTests(unittest.TestCase):
    def test_parec_command_captures_the_mix_monitor_at_100ms(self) -> None:
        self.assertEqual(
            system_capture.build_parec_command("translator_mix.monitor"),
            [
                "parec",
                "--device=translator_mix.monitor",
                "--format=s16le",
                "--rate=16000",
                "--channels=1",
                "--raw",
                "--latency-msec=100",
                "--client-name=simultaneous-translator",
            ],
        )

    def test_decode_frame_returns_float32_1600_points_mono(self) -> None:
        frame = system_capture.decode_frame(_frame_bytes(0x4000))
        self.assertEqual(frame.shape, (1600, 1))
        self.assertEqual(frame.dtype, np.float32)
        self.assertAlmostEqual(float(frame[0, 0]), 0.5, places=4)
        self.assertAlmostEqual(float(np.max(np.abs(frame))), 0.5, places=4)

    def test_decode_frame_maps_the_full_negative_range(self) -> None:
        frame = system_capture.decode_frame(_frame_bytes(-0x8000))
        self.assertAlmostEqual(float(frame[0, 0]), -1.0, places=4)

    def test_record_only_accepts_the_100ms_frame_length(self) -> None:
        capture = SystemCapture()
        with self.assertRaises(ValueError):
            capture.record(800)

    def test_record_after_close_returns_digital_silence(self) -> None:
        capture = SystemCapture()
        capture.close()
        frame = capture.record(1600)
        self.assertEqual(frame.shape, (1600, 1))
        self.assertEqual(frame.dtype, np.float32)
        self.assertFalse(np.any(frame))

    def test_a_blocked_record_wakes_up_on_close(self) -> None:
        capture = SystemCapture()
        recorded: list[np.ndarray] = []
        worker = threading.Thread(target=lambda: recorded.append(capture.record(1600)))
        worker.start()
        capture.close()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(recorded[0].shape, (1600, 1))


class IsolatedLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state_path = Path(self.temporary.name) / "audio-session.json"
        self.calls: list[tuple] = []
        self._patchers: list[object] = []

    def tearDown(self) -> None:
        for patcher in reversed(self._patchers):
            patcher.stop()

    def _patch(self, target, attribute: str, *args, **kwargs) -> object:
        patcher = patch.object(target, attribute, *args, **kwargs)
        self._patchers.append(patcher)
        return patcher.start()

    def _record(self, name: str):
        def recorder(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return None

        return recorder

    def test_a_second_isolated_capture_is_rejected_instead_of_corrupting_the_mix(self) -> None:
        capture, _process = self._start()
        try:
            second = SystemCapture(
                startup_timeout=1.0,
                state_path=self.state_path.parent / "second-audio-session.json",
            )
            with self.assertRaisesRegex(RuntimeError, "已在另一通道运行"):
                second.__enter__()
        finally:
            capture.close()
        self.assertEqual(system_capture.active_original_default_sink(), "")

    def _start(self) -> tuple[SystemCapture, FakeProcess]:
        process = FakeProcess(stdout_bytes=_frame_bytes())
        modules = iter([22, 23])
        defaults = iter(["alsa_output.pci", "translator_mix"])

        def load_module(name, arguments=(), **_kwargs):
            self.calls.append(("load_module", (name, tuple(arguments)), {}))
            return next(modules)

        def unload_module(module_id, **_kwargs):
            self.calls.append(("unload_module", (module_id,), {}))

        self._patch(system_capture, "cleanup_stale_session", self._record("cleanup"))
        self._patch(system_capture, "write_state", self._record("write_state"))
        self._patch(system_capture, "clear_state", self._record("clear_state"))
        subprocess_module = self._patch(system_capture, "subprocess")
        self._patch(
            pulse_audio, "get_default_sink", side_effect=lambda: next(defaults)
        )
        self._patch(pulse_audio, "set_default_sink", self._record("set_default_sink"))
        self._patch(pulse_audio, "load_module", side_effect=load_module)
        self._patch(pulse_audio, "unload_module", side_effect=unload_module)
        self._patch(pulse_audio, "move_sink_inputs_to", self._record("move_sink_inputs"))
        subprocess_module.Popen.return_value = process
        capture = SystemCapture(startup_timeout=1.0, state_path=self.state_path)
        capture.__enter__()
        return capture, process

    def test_startup_then_shutdown_runs_the_documented_sequence(self) -> None:
        capture, process = self._start()
        self.assertEqual(
            [call[0] for call in self.calls],
            [
                "cleanup",
                "load_module",  # module-null-sink translator_mix
                "load_module",  # module-loopback translator_mix.monitor -> user sink
                "set_default_sink",  # translator_mix
                "write_state",
                "move_sink_inputs",
            ],
        )
        self.assertEqual(self.calls[1][1][0], "module-null-sink")
        self.assertIn("sink_name=translator_mix", self.calls[1][1][1])
        self.assertEqual(self.calls[2][1][0], "module-loopback")
        self.assertIn("source=translator_mix.monitor", self.calls[2][1][1])
        self.assertIn("sink=alsa_output.pci", self.calls[2][1][1])
        self.assertEqual(self.calls[3][1], ("translator_mix",))
        self.assertEqual(self.calls[5][1], ("translator_mix",))
        self.assertEqual(self.calls[5][2]["skip_process_ids"], (os.getpid(),))
        # The first frame was delivered; the reader thread is alive.
        self.assertEqual(capture.record(1600).shape, (1600, 1))
        self.assertEqual(system_capture.active_original_default_sink(), "alsa_output.pci")

        capture.close()

        names = [call[0] for call in self.calls]
        restore_call = self.calls[names.index("set_default_sink", names.index("move_sink_inputs") + 1)]
        self.assertEqual(restore_call[1], ("alsa_output.pci",))
        unloads = [call[1][0] for call in self.calls if call[0] == "unload_module"]
        self.assertEqual(unloads, [23, 22])  # loopback before the null sink
        self.assertTrue(any(call[0] == "clear_state" for call in self.calls))
        self.assertFalse(self.state_path.exists())
        self.assertEqual(system_capture.active_original_default_sink(), "")
        self.assertTrue(process.terminated)

    def test_close_is_idempotent(self) -> None:
        capture, _process = self._start()
        capture.close()
        capture.close()
        unloads = [call[1][0] for call in self.calls if call[0] == "unload_module"]
        self.assertEqual(unloads, [23, 22])

    def test_restore_failure_is_only_warned_about(self) -> None:
        capture, _process = self._start()
        with patch.object(
            pulse_audio,
            "set_default_sink",
            side_effect=pulse_audio.PulseAudioError("设备已拔出"),
        ):
            with self.assertLogs(system_capture.logger, level="WARNING"):
                capture.close()
        self.assertFalse(self.state_path.exists())

    def test_load_failure_rolls_back_the_loaded_modules(self) -> None:
        unloaded: list[int] = []
        with (
            patch.object(system_capture, "cleanup_stale_session"),
            patch.object(system_capture, "clear_state") as clear_state,
            patch.object(pulse_audio, "get_default_sink", return_value="alsa_output.pci"),
            patch.object(pulse_audio, "set_default_sink"),
            patch.object(pulse_audio, "unload_module", side_effect=unloaded.append),
            patch.object(
                pulse_audio,
                "load_module",
                side_effect=[11, pulse_audio.PulseAudioError("模块加载失败")],
            ),
        ):
            capture = SystemCapture(startup_timeout=1.0, state_path=self.state_path)
            with self.assertRaises(pulse_audio.PulseAudioError):
                capture.__enter__()
        self.assertEqual(unloaded, [11])
        clear_state.assert_called()

    def test_short_parec_stream_reports_an_interruption(self) -> None:
        process = FakeProcess(stdout_bytes=_frame_bytes()[:1600])
        with (
            patch.object(system_capture, "cleanup_stale_session"),
            patch.object(system_capture, "write_state"),
            patch.object(system_capture, "clear_state"),
            patch.object(system_capture, "subprocess") as subprocess_module,
            patch.object(pulse_audio, "get_default_sink", side_effect=["orig", "orig"]),
            patch.object(pulse_audio, "set_default_sink"),
            patch.object(pulse_audio, "load_module", side_effect=[22, 23]),
            patch.object(pulse_audio, "unload_module"),
            patch.object(pulse_audio, "move_sink_inputs_to"),
        ):
            subprocess_module.Popen.return_value = process
            capture = SystemCapture(startup_timeout=2.0, state_path=self.state_path)
            with self.assertRaisesRegex(RuntimeError, "系统声音采集已中断"):
                capture.__enter__()
        self.assertFalse(self.state_path.exists())

    def test_direct_loopback_mode_loads_no_modules_and_keeps_the_default_sink(self) -> None:
        process = FakeProcess(stdout_bytes=_frame_bytes())
        with (
            patch.object(system_capture, "cleanup_stale_session") as cleanup,
            patch.object(system_capture, "write_state") as write_state,
            patch.object(system_capture, "subprocess") as subprocess_module,
            patch.object(pulse_audio, "get_default_sink") as get_default_sink,
            patch.object(pulse_audio, "set_default_sink") as set_default_sink,
            patch.object(pulse_audio, "load_module") as load_module,
            patch.object(pulse_audio, "unload_module") as unload_module,
        ):
            subprocess_module.Popen.return_value = process
            capture = SystemCapture(
                startup_timeout=1.0,
                device="RDPSink.monitor",
                state_path=self.state_path,
            )
            capture.__enter__()
            self.assertEqual(capture.record(1600).shape, (1600, 1))
            capture.close()
        cleanup.assert_not_called()
        write_state.assert_not_called()
        get_default_sink.assert_not_called()
        set_default_sink.assert_not_called()
        load_module.assert_not_called()
        unload_module.assert_not_called()
        command = subprocess_module.Popen.call_args.args[0]
        self.assertIn("--device=RDPSink.monitor", command)
        self.assertFalse(self.state_path.exists())


class StaleSessionCleanupTests(unittest.TestCase):
    def _modules(self) -> list[pulse_audio.Module]:
        return pulse_audio.parse_short_modules(
            "22\tmodule-null-sink\tsink_name=translator_mix\n"
            "23\tmodule-loopback\tsource=translator_mix.monitor sink=RDPSink\n"
            "24\tmodule-null-sink\tsink_name=translator_mic\n"
            "25\tmodule-remap-source\tmaster=translator_mic.monitor "
            "source_name=translator_mic_source\n"
        )

    def test_cleanup_restores_the_default_sink_and_never_touches_the_virtual_mic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            system_capture.write_state(
                "alsa_output.pci", {"mix": 22, "loopback": 23}, state_path, pid=os.getpid()
            )
            unloaded: list[int] = []
            restored: list[str] = []
            with (
                patch.object(pulse_audio, "list_modules", return_value=self._modules()),
                patch.object(pulse_audio, "get_default_sink", return_value="translator_mix"),
                patch.object(
                    pulse_audio,
                    "list_sinks",
                    return_value=[pulse_audio.Device(1, "alsa_output.pci", "扬声器", 2)],
                ),
                patch.object(pulse_audio, "set_default_sink", side_effect=restored.append),
                patch.object(pulse_audio, "unload_module", side_effect=unloaded.append),
            ):
                removed = system_capture.cleanup_stale_session(path=state_path)
        self.assertEqual(restored, ["alsa_output.pci"])
        self.assertEqual(unloaded, [23, 22])
        self.assertEqual(removed, [23, 22])
        self.assertFalse(state_path.exists())

    def test_cleanup_scans_modules_when_the_journal_is_missing(self) -> None:
        unloaded: list[int] = []
        with tempfile.TemporaryDirectory() as temporary:
            missing_state = Path(temporary) / "absent.json"
            with (
                patch.object(pulse_audio, "list_modules", return_value=self._modules()),
                patch.object(pulse_audio, "unload_module", side_effect=unloaded.append),
            ):
                removed = system_capture.cleanup_stale_session(path=missing_state)
        self.assertEqual(removed, [23, 22])
        self.assertEqual(unloaded, [23, 22])

    def test_cleanup_is_a_noop_when_nothing_is_left_behind(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            with (
                patch.object(pulse_audio, "list_modules", return_value=[]),
                patch.object(pulse_audio, "unload_module") as unload_module,
            ):
                removed = system_capture.cleanup_stale_session(path=state_path)
        self.assertEqual(removed, [])
        unload_module.assert_not_called()

    def test_cleanup_defers_to_a_live_session_in_another_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            system_capture.write_state(
                "alsa_output.pci", {"mix": 22, "loopback": 23}, state_path, pid=4242
            )
            with (
                patch.object(system_capture, "_pid_alive", return_value=True),
                patch.object(pulse_audio, "list_modules") as list_modules,
                patch.object(pulse_audio, "unload_module") as unload_module,
                patch.object(pulse_audio, "set_default_sink") as set_default_sink,
            ):
                with self.assertLogs(system_capture.logger, level="WARNING"):
                    removed = system_capture.cleanup_stale_session(path=state_path)
            self.assertEqual(removed, [])
            self.assertTrue(state_path.exists(), "活动会话的 journal 不能被删除")
        list_modules.assert_not_called()
        unload_module.assert_not_called()
        set_default_sink.assert_not_called()

    def test_surviving_journal_ids_are_filtered_against_live_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "audio-session.json"
            system_capture.write_state(
                "alsa_output.pci", {"mix": 99, "loopback": 98}, state_path, pid=os.getpid()
            )
            unloaded: list[int] = []
            with (
                patch.object(pulse_audio, "list_modules", return_value=[]),
                patch.object(pulse_audio, "unload_module", side_effect=unloaded.append),
            ):
                removed = system_capture.cleanup_stale_session(path=state_path)
        self.assertEqual(removed, [])
        self.assertEqual(unloaded, [])


if __name__ == "__main__":
    unittest.main()
