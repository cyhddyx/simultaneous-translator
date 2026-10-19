"""Offline tests for the PulseAudio command layer (no sound server needed).

Covers the command construction, the ``pactl``/``parec`` text parsers and the
Chinese error mapping described in ``docs/linux-audio-routing.md``.
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pulse_audio


SINK_LIST = """Sink #1
\tState: IDLE
\tName: RDPSink
\tDescription: RDP Sink
\tDriver: module-rdp-sink.c
\tSample Specification: s16le 2ch 44100Hz
\tChannel Map: front-left,front-right
\tMonitor Source: RDPSink.monitor

Sink #2
\tState: SUSPENDED
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo
\tDescription: 内置音频 模拟立体声
\tDriver: module-alsa-card.c
\tSample Specification: s32le 2ch 48000Hz
\tChannel Map: front-left,front-right
\tMonitor Source: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
"""

SOURCE_LIST = """Source #1
\tState: IDLE
\tName: RDPSink.monitor
\tDescription: Monitor of RDP Sink
\tDriver: module-rdp-sink.c
\tSample Specification: s16le 2ch 44100Hz
\tMonitor of Sink: RDPSink

Source #2
\tState: IDLE
\tName: alsa_input.pci-0000_00_1f.3.analog-stereo
\tDescription: 内置音频 模拟立体声
\tDriver: module-alsa-card.c
\tSample Specification: s16le 1ch 48000Hz
\tMonitor of Sink: n/a
"""

MODULE_LIST = (
    "18\tmodule-x11-bell\tsample=x11-bell\n"
    "22\tmodule-null-sink\tsink_name=translator_mix sink_properties=device.description=TranslatorSystemMix\n"
    "23\tmodule-loopback\tsource=translator_mix.monitor sink=RDPSink latency_msec=20 "
    "source_dont_move=true sink_dont_move=true\n"
    "24\tmodule-null-sink\tsink_name=translator_mic\n"
    "25\tmodule-remap-source\tmaster=translator_mic.monitor source_name=translator_mic_source\n"
)

SINK_INPUT_LIST = """Sink Input #12
\tDriver: protocol-native.c
\tOwner Module: 21
\tClient: 9
\tSink: 1
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "4242"
\t\tapplication.process.binary = "firefox"

Sink Input #13
\tDriver: protocol-native.c
\tOwner Module: 21
\tClient: 11
\tSink: 1
\tProperties:
\t\tapplication.name = "simultaneous-translator"
\t\tapplication.process.id = "100"

Sink Input #14
\tDriver: protocol-native.c
\tOwner Module: 21
\tClient: 12
\tSink: 1
\tProperties:
\t\tapplication.name = "unknown"
"""


class CommandConstructionTests(unittest.TestCase):
    def test_parec_command_is_raw_16k_mono_s16le_100ms(self) -> None:
        command = pulse_audio.build_parec_command("translator_mix.monitor")
        self.assertEqual(
            command,
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

    def test_parec_command_accepts_capture_overrides(self) -> None:
        command = pulse_audio.build_parec_command(
            "RDPSink.monitor",
            rate=48_000,
            channels=2,
            latency_msec=20,
            client_name="qa",
        )
        self.assertIn("--rate=48000", command)
        self.assertIn("--channels=2", command)
        self.assertIn("--latency-msec=20", command)
        self.assertIn("--client-name=qa", command)

    def test_monitor_source_maps_sink_names_once(self) -> None:
        self.assertEqual(pulse_audio.monitor_source("RDPSink"), "RDPSink.monitor")
        self.assertEqual(pulse_audio.monitor_source("RDPSink.monitor"), "RDPSink.monitor")
        self.assertEqual(
            pulse_audio.monitor_source("translator_mix"), "translator_mix.monitor"
        )

    def test_pactl_argv_prefixes_the_binary(self) -> None:
        self.assertEqual(
            pulse_audio.pactl_argv("get-default-sink"), ["pactl", "get-default-sink"]
        )


class ParserTests(unittest.TestCase):
    def test_sink_list_parses_names_descriptions_and_channels(self) -> None:
        sinks = pulse_audio.parse_devices(SINK_LIST)
        self.assertEqual(
            [(sink.index, sink.name, sink.description, sink.channels) for sink in sinks],
            [
                (1, "RDPSink", "RDP Sink", 2),
                (2, "alsa_output.pci-0000_00_1f.3.analog-stereo", "内置音频 模拟立体声", 2),
            ],
        )
        self.assertFalse(any(sink.is_monitor for sink in sinks))

    def test_source_list_marks_and_strips_monitor_sources(self) -> None:
        sources = pulse_audio.parse_devices(SOURCE_LIST)
        self.assertEqual(
            [(source.name, source.is_monitor, source.channels) for source in sources],
            [
                ("RDPSink.monitor", True, 2),
                ("alsa_input.pci-0000_00_1f.3.analog-stereo", False, 1),
            ],
        )

    def test_empty_or_garbage_output_yields_no_devices(self) -> None:
        self.assertEqual(pulse_audio.parse_devices(""), [])
        self.assertEqual(pulse_audio.parse_devices("not a device listing\n"), [])

    def test_short_module_list_parses_ids_and_arguments(self) -> None:
        modules = pulse_audio.parse_short_modules(MODULE_LIST)
        self.assertEqual([module.index for module in modules], [18, 22, 23, 24, 25])
        self.assertEqual(modules[1].name, "module-null-sink")
        self.assertEqual(modules[1].arguments, "sink_name=translator_mix "
                         "sink_properties=device.description=TranslatorSystemMix")
        self.assertIn("source=translator_mix.monitor", modules[2].arguments)

    def test_sink_input_list_parses_process_ownership(self) -> None:
        streams = pulse_audio.parse_sink_inputs(SINK_INPUT_LIST)
        self.assertEqual(
            [(stream.index, stream.process_id, stream.application) for stream in streams],
            [(12, 4242, "Firefox"), (13, 100, "simultaneous-translator"), (14, None, "unknown")],
        )


class CommandExecutionTests(unittest.TestCase):
    def test_load_module_returns_the_numeric_id_and_forwards_arguments(self) -> None:
        calls: list[tuple[str, ...]] = []

        def runner(*arguments: str) -> str:
            calls.append(arguments)
            return "42\n"

        module_id = pulse_audio.load_module(
            "module-null-sink",
            ["sink_name=translator_mix", "sink_properties=device.description=Mix"],
            runner=runner,
        )
        self.assertEqual(module_id, 42)
        self.assertEqual(
            calls,
            [
                (
                    "load-module",
                    "module-null-sink",
                    "sink_name=translator_mix",
                    "sink_properties=device.description=Mix",
                )
            ],
        )

    def test_load_module_rejects_a_non_numeric_reply_after_rollback(self) -> None:
        with self.assertRaises(pulse_audio.PulseAudioError) as raised:
            pulse_audio.load_module("module-loopback", [], runner=lambda *_: "not-a-number")
        self.assertIn("加载 PulseAudio 模块 module-loopback 失败", str(raised.exception))

    def test_unload_module_sends_the_numeric_id(self) -> None:
        calls: list[tuple[str, ...]] = []
        pulse_audio.unload_module(23, runner=lambda *args: calls.append(args) or "")
        self.assertEqual(calls, [("unload-module", "23")])

    def test_move_sink_inputs_skips_the_engines_own_streams(self) -> None:
        commands: list[tuple[str, ...]] = []

        def runner(*arguments: str) -> str:
            commands.append(arguments)
            if arguments[:2] == ("list", "sink-inputs"):
                return SINK_INPUT_LIST
            return ""

        moved = pulse_audio.move_sink_inputs_to(
            "translator_mix", skip_process_ids=(100,), runner=runner
        )
        self.assertEqual(moved, [12, 14])
        self.assertEqual(
            [command for command in commands if command[0] == "move-sink-input"],
            [("move-sink-input", "12", "translator_mix"), ("move-sink-input", "14", "translator_mix")],
        )

    def test_default_sink_query_rejects_an_empty_reply(self) -> None:
        with patch.object(pulse_audio, "run_pactl", return_value=""):
            with self.assertRaises(pulse_audio.PulseAudioError) as raised:
                pulse_audio.get_default_sink()
        self.assertEqual(
            str(raised.exception), pulse_audio.DEFAULT_SINK_MISSING_MESSAGE
        )

    def test_pactl_failure_maps_stderr_into_a_readable_error(self) -> None:
        completed = SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="Connection failure: Connection refused\n",
        )
        with patch.object(pulse_audio.subprocess, "run", return_value=completed):
            with self.assertRaises(pulse_audio.PulseAudioError) as raised:
                pulse_audio.run_pactl("info")
        message = str(raised.exception)
        self.assertIn("pactl info", message)
        self.assertIn("Connection refused", message)

    def test_pactl_failure_can_be_tolerated_by_the_caller(self) -> None:
        completed = SimpleNamespace(returncode=1, stdout="partial", stderr="boom")
        with patch.object(pulse_audio.subprocess, "run", return_value=completed):
            self.assertEqual(pulse_audio.run_pactl("info", check=False), "partial")

    def test_missing_tools_use_the_documented_message(self) -> None:
        with patch.object(pulse_audio.shutil, "which", return_value=None):
            with self.assertRaises(pulse_audio.PulseAudioError) as raised:
                pulse_audio.require_tools()
        self.assertEqual(
            str(raised.exception),
            "未找到 PulseAudio 工具（pactl/parec），请安装 pulseaudio-utils 或 pipewire-pulse",
        )

    def test_pactl_binary_disappearing_is_reported_as_missing_tools(self) -> None:
        with patch.object(pulse_audio.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaises(pulse_audio.PulseAudioError) as raised:
                pulse_audio.get_default_sink()
        self.assertEqual(
            str(raised.exception), pulse_audio.TOOLS_MISSING_MESSAGE
        )


if __name__ == "__main__":
    unittest.main()
