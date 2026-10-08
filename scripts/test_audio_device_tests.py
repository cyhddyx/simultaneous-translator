"""Offline tests for the local audio-device test helpers and probes."""

from __future__ import annotations

import sys
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import livetranslate
import tauri_bridge as bridge


class FakePlayer:
    def __init__(self) -> None:
        self.samples: list[np.ndarray] = []

    def __enter__(self) -> "FakePlayer":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def play(self, samples: np.ndarray) -> None:
        self.samples.append(np.asarray(samples))


class FakeRecorder:
    def __init__(self, samples: np.ndarray) -> None:
        self.samples = samples
        self.frame_counts: list[int] = []

    def __enter__(self) -> "FakeRecorder":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def record(self, numframes: int) -> np.ndarray:
        self.frame_counts.append(numframes)
        return self.samples


class FakeSpeaker:
    def __init__(self, device_id: str = "speaker-1", name: str = "Test speakers") -> None:
        self.id = device_id
        self.name = name
        self.player_instance = FakePlayer()

    def player(self, *, samplerate: int, channels: int) -> FakePlayer:
        self.player_args = (samplerate, channels)
        return self.player_instance


class FakeMicrophone:
    def __init__(self, device_id: str = "microphone-1", name: str = "Test microphone") -> None:
        self.id = device_id
        self.name = name
        self.channels = 1
        self.recorder_instance = FakeRecorder(np.full((160, 1), 0.25, dtype=np.float32))
        self.recorder_args: tuple[int, int] | None = None

    def recorder(self, *, samplerate: int, channels: int) -> FakeRecorder:
        self.recorder_args = (samplerate, channels)
        return self.recorder_instance


class AudioTestHelperTests(unittest.TestCase):
    def test_accepts_the_three_supported_kinds_and_rejects_unknown_values(self) -> None:
        for kind in ("playback", "microphone", "loopback"):
            self.assertEqual(livetranslate.validate_audio_test_request(kind, "device"), (kind, "device"))

        with self.assertRaises(livetranslate.ProtocolError):
            livetranslate.validate_audio_test_request("unknown", "device")
        with self.assertRaises(livetranslate.ProtocolError):
            livetranslate.validate_audio_test_request("playback", 123)  # type: ignore[arg-type]

    def test_test_tone_has_expected_length_and_safe_amplitude(self) -> None:
        tone = livetranslate.build_test_tone(duration_seconds=0.25, sample_rate=8_000)

        self.assertEqual(tone.shape, (2_000,))
        self.assertEqual(tone.dtype, np.dtype("float32"))
        self.assertLessEqual(float(np.max(np.abs(tone))), 0.35)
        self.assertGreater(float(np.max(np.abs(tone))), 0.1)

    def test_metrics_and_threshold_distinguish_silence_from_signal(self) -> None:
        silence = np.zeros(1_600, dtype=np.float32)
        signal = np.full(1_600, 0.25, dtype=np.float32)

        self.assertEqual(livetranslate.audio_metrics(silence), (0.0, 0.0))
        peak, rms = livetranslate.audio_metrics(signal)
        self.assertAlmostEqual(peak, 0.25, places=3)
        self.assertAlmostEqual(rms, 0.25, places=3)
        self.assertFalse(livetranslate.signal_detected(0.0))
        self.assertTrue(livetranslate.signal_detected(peak))

    def test_metrics_mix_multichannel_capture_to_mono_before_measuring(self) -> None:
        stereo = np.column_stack(
            [np.full(100, 0.4, dtype=np.float32), np.full(100, -0.4, dtype=np.float32)]
        )

        self.assertEqual(livetranslate.audio_metrics(stereo), (0.0, 0.0))


class AudioDeviceProbeTests(unittest.TestCase):
    def test_playback_probe_plays_a_bounded_tone_on_selected_speaker(self) -> None:
        speaker = FakeSpeaker()
        with patch.object(livetranslate, "_ensure_com_initialized"), patch(
            "soundcard.get_speaker", return_value=speaker
        ):
            result = livetranslate.run_audio_test("playback", "speaker-1")

        self.assertTrue(result["ok"])
        self.assertEqual(result["kind"], "playback")
        self.assertEqual(result["device_id"], "speaker-1")
        self.assertEqual(result["device_name"], "Test speakers")
        self.assertTrue(result["detected"])
        self.assertEqual(speaker.player_args, (livetranslate.AUDIO_TEST_SAMPLE_RATE, 1))
        self.assertEqual(len(speaker.player_instance.samples), 1)
        self.assertGreater(len(speaker.player_instance.samples[0]), 1)

    def test_microphone_probe_records_and_reports_signal_metrics(self) -> None:
        microphone = FakeMicrophone()
        with patch.object(livetranslate, "_ensure_com_initialized"), patch(
            "soundcard.get_microphone", return_value=microphone
        ):
            result = livetranslate.run_audio_test("microphone", "microphone-1")

        self.assertTrue(result["ok"])
        self.assertEqual(result["kind"], "microphone")
        self.assertEqual(result["device_id"], "microphone-1")
        self.assertTrue(result["detected"])
        self.assertAlmostEqual(result["peak"], 0.25, places=3)
        self.assertAlmostEqual(result["rms"], 0.25, places=3)
        self.assertEqual(microphone.recorder_args, (livetranslate.AUDIO_TEST_SAMPLE_RATE, 1))
        self.assertEqual(microphone.recorder_instance.frame_counts, [livetranslate.AUDIO_TEST_SAMPLE_RATE * 3])

    def test_loopback_probe_plays_and_records_the_selected_speaker_loopback(self) -> None:
        speaker = FakeSpeaker()
        microphone = FakeMicrophone(device_id="speaker-1", name="Test speakers loopback")
        with patch.object(livetranslate, "_ensure_com_initialized"), patch(
            "soundcard.get_speaker", return_value=speaker
        ), patch("soundcard.get_microphone", return_value=microphone) as get_microphone:
            result = livetranslate.run_audio_test("loopback", "speaker-1")

        self.assertTrue(result["ok"])
        self.assertEqual(result["kind"], "loopback")
        self.assertTrue(result["detected"])
        get_microphone.assert_called_once_with(id="speaker-1", include_loopback=True)
        self.assertEqual(len(speaker.player_instance.samples), 1)
        self.assertEqual(microphone.recorder_instance.frame_counts, [livetranslate.AUDIO_TEST_SAMPLE_RATE])


class AudioTestBridgeTests(unittest.TestCase):
    def test_audio_test_command_returns_probe_result(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        result = {
            "ok": True,
            "kind": "playback",
            "device_id": "speaker-1",
            "device_name": "Test speakers",
            "duration_ms": 10,
            "peak": 0.25,
            "rms": 0.12,
            "detected": True,
            "detail": "播放测试音成功",
        }
        with patch.object(bridge.livetranslate, "run_audio_test", return_value=result) as probe:
            server.handle_request(
                {
                    "id": "audio-test",
                    "command": "audio_test",
                    "params": {"kind": "playback", "device_id": "speaker-1"},
                }
            )

        response = json.loads(stdout.getvalue().splitlines()[0])
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["kind"], "playback")
        probe.assert_called_once_with("playback", "speaker-1")

    def test_audio_test_command_rejects_unknown_kind_before_opening_devices(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        with patch.object(bridge.livetranslate, "run_audio_test") as probe:
            server.handle_request(
                {
                    "id": "invalid-audio-test",
                    "command": "audio_test",
                    "params": {"kind": "system", "device_id": "speaker-1"},
                }
            )

        response = json.loads(stdout.getvalue().splitlines()[0])
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_audio_test_request")
        probe.assert_not_called()

    def test_audio_test_command_returns_a_stable_error_for_device_failures(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        with patch.object(
            bridge.livetranslate,
            "run_audio_test",
            side_effect=RuntimeError("设备已断开"),
        ):
            server.handle_request(
                {
                    "id": "failed-audio-test",
                    "command": "audio_test",
                    "params": {"kind": "playback", "device_id": "speaker-1"},
                }
            )

        response = json.loads(stdout.getvalue().splitlines()[0])
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "audio_test_failed")
        self.assertEqual(response["error"]["message"], "设备已断开")


if __name__ == "__main__":
    unittest.main()
