"""PulseAudio 集成测试（真实 ``pactl`` / ``parec``，WSLg 或桌面 PulseAudio）。

运行条件：``pactl info`` 可成功连接服务器；否则整类测试 skip，不产生任何
副作用。所有测试创建的模块名都带 ``tt_test_`` 前缀，结束（包括异常）都会
卸载并断言没有残留、默认 sink 已恢复。

    PULSE_SERVER=unix:/mnt/wslg/PulseServer \\
        /home/cyh26/venvs/translation-linux/bin/python scripts/test_pulse_integration.py

设计依据：``docs/linux-audio-routing.md`` §7。
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import os
import time
import unittest
from pathlib import Path

import numpy as np

import pulse_audio
import system_capture
from system_capture import SystemCapture


# Every object this file creates is prefixed so the cleanup scans cannot touch
# a real user device and a failure is easy to spot in ``pactl list``.
USER_SINK = "tt_test_user_sink"
USER_SINK_DESCRIPTION = "TT_Test_User_Sink"
PREFIX = "tt_test_translator"
VIRTUAL_MIC_SINK = f"{PREFIX}_mic"
VIRTUAL_MIC_SOURCE = f"{PREFIX}_mic_source"
TEST_MARKER = "tt_test_"

SKIP_REASON = "需要可用的 PulseAudio/PipeWire 服务（pactl info 失败或无 PULSE_SERVER）"


def _pulse_available() -> bool:
    if shutil.which("pactl") is None or shutil.which("parec") is None:
        return False
    try:
        completed = subprocess.run(
            ["pactl", "info"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


PULSE_AVAILABLE = _pulse_available()


def _read_raw_bytes(device: str, size: int = 3200) -> bytes:
    """Read ``size`` raw capture bytes from one monitor and stop parec."""

    process = subprocess.Popen(
        system_capture.build_parec_command(device),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        return process.stdout.read(size)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()


@unittest.skipUnless(PULSE_AVAILABLE, SKIP_REASON)
class PulseIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state_path = Path(self.temporary.name) / "audio-session.json"
        self.original_default = pulse_audio.get_default_sink()
        # Remove anything an interrupted previous run left behind before the
        # sink name is reused (module creation fails on a duplicate name).
        for module in pulse_audio.list_modules():
            if TEST_MARKER not in module.arguments:
                continue
            try:
                pulse_audio.unload_module(module.index)
            except pulse_audio.PulseAudioError:
                pass
        self.user_sink_module = pulse_audio.load_module(
            "module-null-sink",
            [
                f"sink_name={USER_SINK}",
                f"sink_properties=device.description={USER_SINK_DESCRIPTION}",
            ],
        )
        self.addCleanup(self._cleanup_environment)
        # Make the test sink the "user device" so the capture has something
        # stable to restore and the developer's real default is never touched.
        pulse_audio.set_default_sink(USER_SINK)

    def tearDown(self) -> None:
        leftover = self._residual_modules()
        if leftover:
            self._cleanup_environment()
            self.fail(f"测试残留了 PulseAudio 模块：{leftover}")

    def _residual_modules(self) -> list[pulse_audio.Module]:
        """Modules created by the code under test (the user sink is a fixture)."""

        return [
            module
            for module in pulse_audio.list_modules()
            if TEST_MARKER in module.arguments and module.index != self.user_sink_module
        ]

    def _cleanup_environment(self) -> None:
        """Restore the default sink and unload every tt_test_ module."""

        try:
            current = pulse_audio.get_default_sink()
        except pulse_audio.PulseAudioError:
            current = ""
        if current != self.original_default:
            try:
                pulse_audio.set_default_sink(self.original_default)
            except pulse_audio.PulseAudioError:
                pass
        for module in pulse_audio.list_modules():
            if TEST_MARKER not in module.arguments:
                continue
            try:
                pulse_audio.unload_module(module.index)
            except pulse_audio.PulseAudioError:
                pass

    def _sink_names(self) -> set[str]:
        return {sink.name for sink in pulse_audio.list_sinks()}

    def _source_names(self) -> set[str]:
        return {source.name for source in pulse_audio.list_sources()}

    # ------------------------------------------------------------ isolated capture

    def test_isolated_capture_routes_records_and_restores_cleanly(self) -> None:
        mix_sink = system_capture.mix_sink_name(PREFIX)
        with SystemCapture(
            startup_timeout=10.0, prefix=PREFIX, state_path=self.state_path
        ) as capture:
            self.assertEqual(pulse_audio.get_default_sink(), mix_sink)
            self.assertIn(mix_sink, self._sink_names())
            self.assertIn(f"{mix_sink}.monitor", self._source_names())
            self.assertTrue(self.state_path.exists(), "采集期间应写入状态文件")
            journal = system_capture.read_state(self.state_path)
            self.assertEqual(journal["default_sink"], USER_SINK)
            self.assertEqual(journal["pid"], os.getpid())
            self.assertIn("mix", journal["modules"])
            self.assertIn("loopback", journal["modules"])

            frame = capture.record(1600)
            self.assertEqual(frame.shape, (1600, 1))
            self.assertEqual(frame.dtype, np.float32)

            # The monitor must still be readable by a second raw parec client.
            raw = _read_raw_bytes(f"{mix_sink}.monitor")
            self.assertEqual(len(raw), 3200)

        self.assertEqual(pulse_audio.get_default_sink(), USER_SINK, "默认 sink 必须恢复")
        self.assertNotIn(mix_sink, self._sink_names())
        self.assertEqual(
            self._residual_modules(), []
        )
        self.assertFalse(self.state_path.exists(), "关闭后状态文件必须清空")

    def test_a_broken_parec_stream_is_reported_and_close_still_cleans_up(self) -> None:
        mix_sink = system_capture.mix_sink_name(PREFIX)
        capture = SystemCapture(
            startup_timeout=10.0, prefix=PREFIX, state_path=self.state_path
        )
        capture.__enter__()
        try:
            assert capture._process is not None
            capture._process.kill()
            deadline = time.monotonic() + 5.0
            failure: RuntimeError | None = None
            while time.monotonic() < deadline:
                try:
                    capture.record(1600)
                except RuntimeError as error:
                    failure = error
                    break
            self.assertIsNotNone(failure, "parec 被杀掉后 record() 必须报错")
            self.assertIn("采集", str(failure))
        finally:
            capture.close()

        self.assertEqual(pulse_audio.get_default_sink(), USER_SINK)
        self.assertNotIn(mix_sink, self._sink_names())
        self.assertEqual(
            self._residual_modules(), []
        )

    def test_stale_modules_and_switched_default_are_repaired(self) -> None:
        mix_sink = system_capture.mix_sink_name(PREFIX)
        # Simulate a crash: the modules exist, the default sink is switched and
        # the journal survived, but no process is left to clean up.
        mix_id = pulse_audio.load_module(
            "module-null-sink", [f"sink_name={mix_sink}"]
        )
        loop_id = pulse_audio.load_module(
            "module-loopback",
            [
                f"source={mix_sink}.monitor",
                f"sink={USER_SINK}",
                "latency_msec=20",
                "source_dont_move=true",
                "sink_dont_move=true",
            ],
        )
        pulse_audio.set_default_sink(mix_sink)
        system_capture.write_state(
            USER_SINK, {"mix": mix_id, "loopback": loop_id}, self.state_path
        )

        removed = system_capture.cleanup_stale_session(PREFIX, path=self.state_path)

        self.assertEqual(sorted(removed), sorted([mix_id, loop_id]))
        self.assertEqual(pulse_audio.get_default_sink(), USER_SINK)
        self.assertNotIn(mix_sink, self._sink_names())
        self.assertFalse(self.state_path.exists())

    def test_virtual_microphone_modules_are_created_and_removed(self) -> None:
        sink_id = pulse_audio.load_module(
            "module-null-sink",
            [
                f"sink_name={VIRTUAL_MIC_SINK}",
                "sink_properties=device.description=TranslatorVirtualMicrophoneSink",
            ],
        )
        source_id: int | None = None
        try:
            source_id = pulse_audio.load_module(
                "module-remap-source",
                [
                    f"master={VIRTUAL_MIC_SINK}.monitor",
                    f"source_name={VIRTUAL_MIC_SOURCE}",
                    'source_properties=device.description=TranslatorVirtualMicrophone',
                ],
            )
            self.assertIn(VIRTUAL_MIC_SOURCE, self._source_names())
        finally:
            if source_id is not None:
                pulse_audio.unload_module(source_id)
            pulse_audio.unload_module(sink_id)
        self.assertNotIn(VIRTUAL_MIC_SOURCE, self._source_names())


if __name__ == "__main__":
    unittest.main()
