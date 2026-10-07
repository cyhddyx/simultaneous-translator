"""Channel voice policies and device-loopback feedback protection."""
import asyncio
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch, MagicMock, AsyncMock

import numpy as np

import livetranslate as live
from system_capture import SystemCapture


class AudioIsolationTests(unittest.TestCase):
    def channel(self, channel="listen", voice_mode="", input_kind="system"):
        spec = live.ChannelSpec(channel, True, input_kind, "", "English", "", True, voice_mode)
        session = SimpleNamespace(specs=(spec,), startup_timeout_s=1)
        return live.LiveTranslateChannel(MagicMock(), session, spec, base_url="wss://test", model="test", api_key="test", options=live.RealtimeOptions())

    def test_legacy_clone_applies_only_to_outgoing_speech(self):
        incoming = self.channel()._session_variants()[0]
        outgoing = self.channel(channel="speak")._session_variants()[0]
        self.assertFalse(incoming["enable_voice_clone"])
        self.assertNotIn("voice", incoming)
        self.assertEqual(outgoing["voice_clone_options"], {"frequency": "once"})

    def test_voice_choices_are_independent_and_incoming_refreshes(self):
        incoming = self.channel(voice_mode="clone")
        outgoing = self.channel(channel="speak", voice_mode="system")
        self.assertEqual(incoming._session_variants()[0]["voice_clone_options"], {"frequency": "always"})
        self.assertFalse(outgoing._session_variants()[0]["enable_voice_clone"])
        incoming._spec = replace(incoming._spec, play_audio=False)
        self.assertNotIn("enable_voice_clone", incoming._session_variants()[0])

    def test_system_input_uses_isolated_recorder(self):
        recorder, info = self.channel()._open_input()
        self.assertIsInstance(recorder, SystemCapture)
        self.assertEqual(info["kind"], "system")

    def test_device_loopback_rejects_either_translation_output(self):
        channel = self.channel(input_kind="loopback")
        speaker = SimpleNamespace(id="headset", name="Headset")
        with patch.object(live, "_ensure_com_initialized"), patch("soundcard.default_speaker", return_value=speaker), patch("soundcard.get_microphone", return_value=MagicMock()):
            with self.assertRaisesRegex(RuntimeError, "再次采集译文"):
                channel._open_input()
            channel._session.specs = (replace(channel._spec, play_audio=False), replace(channel._spec, channel="speak"))
            with self.assertRaisesRegex(RuntimeError, "再次采集译文"):
                channel._open_input()

    def test_parser_retains_per_direction_choices(self):
        specs = live.parse_channel_specs({"listen": {"voiceMode": "system"}, "speak": {"voiceMode": "clone"}}, default_target_language="English")
        self.assertEqual([(s.input_kind, s.voice_mode) for s in specs], [("system", "system"), ("microphone", "clone")])

    def test_missing_outgoing_language_never_inherits_incoming_target(self):
        specs = live.parse_channel_specs({"speak": {"targetLanguage": "  "}}, default_target_language="简体中文")
        self.assertEqual([s.target_language for s in specs], ["简体中文", "English"])

    def test_each_direction_sends_its_own_translation_language(self):
        incoming = self.channel()
        incoming._spec = replace(incoming._spec, target_language="简体中文")
        outgoing = self.channel(channel="speak", input_kind="microphone")
        self.assertEqual(incoming._session_variants()[0]["translation"], {"language": "zh"})
        self.assertEqual(outgoing._session_variants()[0]["translation"], {"language": "en"})
        outgoing._spec = replace(outgoing._spec, target_language="日本語")
        self.assertEqual(outgoing._session_variants()[0]["translation"], {"language": "ja"})
        self.assertEqual(incoming._session_variants()[0]["translation"], {"language": "zh"})

    def test_stopping_releases_a_waiting_record(self):
        capture = SystemCapture()
        recorded = []
        worker = threading.Thread(target=lambda: recorded.append(capture.record(1600)))
        worker.start()
        capture.close()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(recorded[0].shape, (1600, 1))

    def test_all_catalog_targets_use_their_actual_code_and_output_mode(self):
        channel = self.channel()
        self.assertEqual(len(live._LANGUAGES), 60)
        self.assertEqual(sum(language["audio"] for language in live._LANGUAGES), 29)
        for language in live._LANGUAGES:
            for value in [language["code"], language["label"], *language["aliases"]]:
                with self.subTest(value=value):
                    channel._spec = replace(channel._spec, target_language=value, play_audio=False)
                    payload = channel._session_variants()[0]
                    self.assertEqual(payload["translation"]["language"], language["code"])
                    self.assertEqual(payload["output_modalities"], ["text"])
                    channel._spec = replace(channel._spec, play_audio=True)
                    if language["audio"]:
                        payload = channel._session_variants()[0]
                        self.assertEqual(payload["translation"]["language"], language["code"])
                        self.assertEqual(payload["output_modalities"], ["text", "audio"])
                    else:
                        with self.assertRaisesRegex(ValueError, "仅支持文字"):
                            channel._session_variants()

    def test_failed_capture_does_not_return_old_frames(self):
        capture = SystemCapture()
        capture._frames.put("stale")
        capture._error = "capture failed"
        with self.assertRaisesRegex(RuntimeError, "capture failed"):
            capture.record(1600)

    def test_system_voice_rejects_a_server_that_keeps_cloning(self):
        channel = self.channel(voice_mode="system")
        channel._handle_event({"type": "session.updated", "session": {"enable_voice_clone": True}}, None)
        self.assertTrue(channel._failed)


class RuntimeAudioGateTests(unittest.TestCase):
    """Contract section 6: a closed channel drops frames before the engine.

    ``_capture_loop`` sends one WebSocket frame per captured chunk, so counting
    ``websocket.send`` calls while driving the loop is the exact measurement of
    whether audio reached the engine.
    """

    FRAMES = 4  # the last record sets stop_event, so a fully open run sends 3.

    def session(self, channels=("listen", "speak")):
        specs = tuple(
            live.ChannelSpec(channel, True, "microphone", "", "English", "", True, "")
            for channel in channels
        )
        return SimpleNamespace(
            specs=specs,
            startup_timeout_s=1,
            stop_event=threading.Event(),
            runtime=live.RuntimeChannelState({spec.channel: True for spec in specs}),
            status_tracker=live.HealthStatusTracker(),
            set_channel_network=lambda *_args, **_kwargs: None,
        )

    def channel(self, session, name="listen"):
        spec = next(spec for spec in session.specs if spec.channel == name)
        return live.LiveTranslateChannel(
            MagicMock(), session, spec, base_url="wss://test", model="test",
            api_key="test", options=live.RealtimeOptions(),
        )

    def drive(self, channel, frames=None):
        """Run the real capture loop for a fixed number of captured chunks."""

        frames = frames or self.FRAMES
        produced = []
        recorder = MagicMock()

        def capture(numframes):
            produced.append(1)
            if len(produced) >= frames:
                channel._session.stop_event.set()
            return np.zeros((numframes, 1), dtype="float32")

        recorder.record = MagicMock(side_effect=capture)
        websocket = MagicMock()
        websocket.send = AsyncMock()

        async def run():
            pool = ThreadPoolExecutor(max_workers=1)
            try:
                await asyncio.wait_for(channel._capture_loop(websocket, pool, recorder), 10)
            finally:
                pool.shutdown(wait=False)

        asyncio.run(run())
        channel._session.stop_event.clear()
        return produced, websocket

    def test_a_closed_channel_drops_every_frame_before_the_engine(self):
        session = self.session(("listen",))
        channel = self.channel(session)
        session.runtime.set_channel("listen", False)

        produced, websocket = self.drive(channel)

        self.assertEqual(len(produced), self.FRAMES)
        websocket.send.assert_not_awaited()
        websocket.close.assert_not_called()
        self.assertEqual(channel._dropped_frames, self.FRAMES - 1)

    def test_an_open_channel_still_sends_every_frame(self):
        session = self.session(("listen",))
        channel = self.channel(session)

        produced, websocket = self.drive(channel)

        self.assertEqual(len(produced), self.FRAMES)
        self.assertEqual(websocket.send.await_count, self.FRAMES - 1)
        payload = websocket.send.await_args.args[0]
        self.assertIn('"type": "input_audio_buffer.append"', payload)

    def test_reenabling_resumes_on_the_same_channel_object(self):
        session = self.session(("listen",))
        channel = self.channel(session)
        session.runtime.set_channel("listen", False)

        _, closed = self.drive(channel)
        session.runtime.set_channel("listen", True)
        _, reopened = self.drive(channel)

        closed.send.assert_not_awaited()
        self.assertEqual(reopened.send.await_count, self.FRAMES - 1)
        # Resuming must not have rebuilt anything: same channel, same session.
        self.assertIs(channel._session, session)
        self.assertFalse(channel._failed)

    def test_muting_drops_only_the_microphone_frames(self):
        session = self.session(("listen", "speak"))
        speak = self.channel(session, "speak")
        listen = self.channel(session, "listen")
        session.runtime.set_speak_muted(True)

        _, muted = self.drive(speak)
        _, open_listen = self.drive(listen)

        muted.send.assert_not_awaited()
        self.assertEqual(open_listen.send.await_count, self.FRAMES - 1)
        # Muting is not the same as disabling: the channel is still enabled and
        # the session was never stopped.
        self.assertTrue(session.runtime.effective_enabled("speak"))
        self.assertFalse(session.stop_event.is_set())

    def test_unmuting_resumes_the_microphone_on_the_same_object(self):
        session = self.session(("speak",))
        channel = self.channel(session, "speak")
        session.runtime.set_speak_muted(True)

        _, muted = self.drive(channel)
        session.runtime.set_speak_muted(False)
        _, resumed = self.drive(channel)

        muted.send.assert_not_awaited()
        self.assertEqual(resumed.send.await_count, self.FRAMES - 1)
        self.assertIs(channel._session, session)

    def test_closing_one_channel_leaves_the_sibling_streaming(self):
        session = self.session(("listen", "speak"))
        listen = self.channel(session, "listen")
        speak = self.channel(session, "speak")
        session.runtime.set_channel("listen", False)

        _, closed = self.drive(listen)
        _, sibling = self.drive(speak)

        closed.send.assert_not_awaited()
        self.assertEqual(sibling.send.await_count, self.FRAMES - 1)
        self.assertTrue(session.runtime.effective_enabled("speak"))

    def test_a_session_without_runtime_state_keeps_streaming(self):
        # Lightweight duck-typed sessions must keep the pre-existing behaviour.
        spec = live.ChannelSpec("listen", True, "microphone", "", "English", "", True, "")
        session = SimpleNamespace(specs=(spec,), startup_timeout_s=1, stop_event=threading.Event())
        channel = live.LiveTranslateChannel(
            MagicMock(), session, spec, base_url="wss://test", model="test",
            api_key="test", options=live.RealtimeOptions(),
        )

        _, websocket = self.drive(channel)

        self.assertEqual(websocket.send.await_count, self.FRAMES - 1)


if __name__ == "__main__":
    unittest.main()
