"""Channel voice policies and device-loopback feedback protection."""
import unittest
import threading
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

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


if __name__ == "__main__":
    unittest.main()
