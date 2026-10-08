"""Offline tests for the local audio-device test helpers and probes."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import livetranslate


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


if __name__ == "__main__":
    unittest.main()
