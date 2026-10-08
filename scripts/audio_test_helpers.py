"""Pure helpers shared by local audio-device diagnostics."""

from __future__ import annotations

import math
from typing import Any

import numpy as np


AUDIO_TEST_KINDS = ("playback", "microphone", "loopback")
AUDIO_TEST_SAMPLE_RATE = 16_000
AUDIO_TEST_TONE_HZ = 440.0
AUDIO_TEST_TONE_AMPLITUDE = 0.25
AUDIO_TEST_SIGNAL_THRESHOLD = 0.02


class ProtocolError(ValueError):
    """Raised when an audio-test request cannot be safely interpreted."""


def validate_audio_test_request(kind: Any, device_id: Any = "") -> tuple[str, str]:
    if not isinstance(kind, str) or kind.strip() not in AUDIO_TEST_KINDS:
        raise ProtocolError("kind must be playback, microphone or loopback")
    if not isinstance(device_id, str):
        raise ProtocolError("device_id must be a string")
    return kind.strip(), device_id.strip()


def build_test_tone(
    duration_seconds: float = 1.0,
    sample_rate: int = AUDIO_TEST_SAMPLE_RATE,
) -> np.ndarray:
    if duration_seconds <= 0 or sample_rate <= 0:
        raise ValueError("duration_seconds and sample_rate must be positive")
    sample_count = max(1, int(round(duration_seconds * sample_rate)))
    timeline = np.arange(sample_count, dtype=np.float32) / float(sample_rate)
    tone = AUDIO_TEST_TONE_AMPLITUDE * np.sin(2.0 * math.pi * AUDIO_TEST_TONE_HZ * timeline)
    return np.asarray(tone, dtype=np.float32)


def audio_metrics(samples: Any) -> tuple[float, float]:
    values = np.asarray(samples, dtype=np.float32)
    if values.size == 0:
        return 0.0, 0.0
    values = values.reshape(-1)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0.0, 0.0
    peak = float(np.max(np.abs(finite)))
    rms = float(np.sqrt(np.mean(np.square(finite))))
    return peak, rms


def signal_detected(peak: float, threshold: float = AUDIO_TEST_SIGNAL_THRESHOLD) -> bool:
    return math.isfinite(float(peak)) and float(peak) >= threshold
