"""Runtime channel control contract tests (docs/runtime-channel-control.md).

Every case drives a real ``RealtimeSession`` through a real ``BridgeServer`` over
the JSONL surface, so responses, events and error codes are asserted exactly as
Rust receives them.

Run with:
    .venv/Scripts/python.exe scripts/test_runtime_channels.py
"""

from __future__ import annotations

import io
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import livetranslate  # noqa: E402
import tauri_bridge as bridge  # noqa: E402


SESSION_ID = "b7d2e6c4-0f3a-4f7e-9b1d-2c3a4b5c6d7e"
OTHER_SESSION_ID = "11111111-2222-4333-8444-555555555555"
BOTH_CHANNELS = {"listen": {"enabled": True}, "speak": {"enabled": True}}
LISTEN_ONLY = {"listen": {"enabled": True}, "speak": {"enabled": False}}


def start_params(channels: dict) -> dict:
    return {
        "engine": "realtime",
        "realtime": {"model": "qwen3.8-livetranslate-flash-realtime"},
        "audio": channels,
        "secrets": {"realtimeApiKey": "realtime-secret"},
    }


class RuntimeCommandHarness(unittest.TestCase):
    """A real session behind a real bridge, driven one JSONL line at a time."""

    channels: dict = BOTH_CHANNELS

    def setUp(self) -> None:
        self.stdout = io.StringIO()
        self.server = bridge.BridgeServer(io.StringIO(), self.stdout)
        self._install(self.channels)

    def _install(self, channels: dict, session_id: str = SESSION_ID) -> None:
        self.config = bridge.RuntimeConfig.from_start_params(start_params(channels))
        self.session = bridge.create_session(self.server, session_id, self.config)
        with self.server._session_lock:
            self.server._current_session = self.session

    # ------------------------------------------------------------ JSONL helpers
    def send(self, command: str, params: object = None, request_id: str = "req-1") -> dict:
        self.server.handle_request(
            {"id": request_id, "command": command, "params": {} if params is None else params}
        )
        return self.responses()[-1]

    def lines(self) -> list[dict]:
        return [json.loads(line) for line in self.stdout.getvalue().splitlines()]

    def responses(self) -> list[dict]:
        return [line for line in self.lines() if line["type"] == "response"]

    def events(self, name: str | None = None) -> list[dict]:
        found = [line for line in self.lines() if line["type"] == "event"]
        return [line for line in found if name is None or line["event"] == name]

    def channel_request(self, **overrides: object) -> dict:
        params: dict = {"session_id": SESSION_ID, "channel": "listen", "enabled": False}
        params.update(overrides)
        return params

    def mute_request(self, **overrides: object) -> dict:
        params: dict = {"session_id": SESSION_ID, "muted": True}
        params.update(overrides)
        return params


class RuntimeChannelCommandTests(RuntimeCommandHarness):
    def test_disabling_a_channel_reports_the_effective_state(self) -> None:
        response = self.send("set_runtime_channel", self.channel_request())

        self.assertTrue(response["ok"])
        self.assertEqual(
            response["result"],
            {
                "session_id": SESSION_ID,
                "channel": "listen",
                "enabled": False,
                "changed": True,
            },
        )
        announced = self.events("runtime.channel")
        self.assertEqual(len(announced), 1)
        self.assertEqual(announced[0]["session_id"], SESSION_ID)
        self.assertEqual(
            announced[0]["data"], {"channel": "listen", "enabled": False, "configured": True}
        )
        self.assertFalse(self.session.runtime.effective_enabled("listen"))

    def test_repeating_the_same_value_is_an_idempotent_success(self) -> None:
        first = self.send("set_runtime_channel", self.channel_request(), "req-1")
        second = self.send("set_runtime_channel", self.channel_request(), "req-2")

        self.assertTrue(first["ok"])
        self.assertTrue(first["result"]["changed"])
        self.assertTrue(second["ok"])
        self.assertFalse(second["result"]["changed"])
        self.assertFalse(second["result"]["enabled"])
        self.assertEqual(len(self.events("runtime.channel")), 1)

    def test_re_enabling_reports_a_change_again(self) -> None:
        self.send("set_runtime_channel", self.channel_request(), "req-1")
        response = self.send(
            "set_runtime_channel", self.channel_request(enabled=True), "req-2"
        )

        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["changed"])
        self.assertTrue(response["result"]["enabled"])
        self.assertEqual(
            [event["data"]["enabled"] for event in self.events("runtime.channel")],
            [False, True],
        )

    def test_speak_channel_can_be_switched_independently(self) -> None:
        self.send("set_runtime_channel", self.channel_request(channel="speak"))

        self.assertFalse(self.session.runtime.effective_enabled("speak"))
        self.assertTrue(self.session.runtime.effective_enabled("listen"))
        self.assertEqual(self.events("runtime.channel")[-1]["data"]["channel"], "speak")

    def test_every_response_echoes_the_request_id(self) -> None:
        self.assertEqual(
            self.send("set_runtime_channel", self.channel_request(), "abc-1")["id"], "abc-1"
        )
        self.assertEqual(
            self.send("set_runtime_channel", self.channel_request(channel="both"), "abc-2")["id"],
            "abc-2",
        )

    def test_unknown_channel_is_invalid_channel(self) -> None:
        # Only a value that is present but outside the allowed set is
        # invalid_channel; a missing value is a parameter problem (contract 3.2).
        for channel in ["Listen", "SPEAK", "both", "", 1, ["listen"]]:
            with self.subTest(channel=channel):
                response = self.send("set_runtime_channel", self.channel_request(channel=channel))
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_channel")
                self.assertIn("message", response["error"])
        self.assertTrue(self.session.runtime.effective_enabled("listen"))

    def test_missing_channel_is_invalid_params(self) -> None:
        for params in [
            {},
            {"session_id": SESSION_ID},
            {"session_id": SESSION_ID, "channel": None},
            {"session_id": SESSION_ID, "enabled": False},
        ]:
            with self.subTest(params=params):
                response = self.send("set_runtime_channel", params)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_params")
        self.assertTrue(self.session.runtime.effective_enabled("listen"))

    def test_missing_session_id_is_invalid_params(self) -> None:
        for session_id in [None, "", "   ", 42, {"id": SESSION_ID}]:
            with self.subTest(session_id=session_id):
                params = self.channel_request()
                params["session_id"] = session_id
                response = self.send("set_runtime_channel", params)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_params")

        without_key = self.channel_request()
        del without_key["session_id"]
        response = self.send("set_runtime_channel", without_key)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_params")

    def test_missing_session_id_outranks_a_bad_channel(self) -> None:
        # Shape errors are resolved before session state, and a missing
        # session_id is the more fundamental one.
        response = self.send("set_runtime_channel", {"channel": "nonsense", "enabled": False})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_params")

    def test_non_boolean_enabled_is_invalid_params(self) -> None:
        # JSON booleans only: 1/0 are numbers, and "false" is a string.
        for enabled in ["false", "true", 1, 0, None, [], {}]:
            with self.subTest(enabled=enabled):
                response = self.send(
                    "set_runtime_channel", self.channel_request(enabled=enabled)
                )
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_params")
        self.assertTrue(self.session.runtime.effective_enabled("listen"))

    def test_no_active_session_is_reported(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        server.handle_request(
            {
                "id": "req-1",
                "command": "set_runtime_channel",
                "params": self.channel_request(),
            }
        )

        response = json.loads(stdout.getvalue().splitlines()[-1])
        self.assertEqual(response["id"], "req-1")
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "no_active_session")

    def test_session_mismatch_fails_and_changes_nothing(self) -> None:
        response = self.send(
            "set_runtime_channel", self.channel_request(session_id=OTHER_SESSION_ID)
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "session_mismatch")
        self.assertTrue(self.session.runtime.effective_enabled("listen"))
        self.assertFalse(self.session.runtime.speak_muted())
        self.assertEqual(self.events("runtime.channel"), [])
        self.assertEqual(self.events("runtime.mute"), [])

    def test_a_finished_session_mismatches_instead_of_mutating_a_new_one(self) -> None:
        old_id = self.session.session_id
        self._install(BOTH_CHANNELS, session_id=OTHER_SESSION_ID)
        self.session.runtime.set_channel("listen", False)

        response = self.send(
            "set_runtime_channel", self.channel_request(session_id=old_id, enabled=True)
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "session_mismatch")
        self.assertFalse(self.session.runtime.effective_enabled("listen"))
        self.assertEqual(self.events("runtime.channel"), [])

    def test_unconfigured_channel_cannot_be_enabled_at_runtime(self) -> None:
        self._install(LISTEN_ONLY)

        for command, params in [
            ("set_runtime_channel", self.channel_request(channel="speak", enabled=True)),
            ("set_speak_muted", self.mute_request(muted=True)),
        ]:
            with self.subTest(command=command):
                response = self.send(command, params)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "channel_not_configured")

    def test_runtime_state_never_rewrites_the_configuration(self) -> None:
        before = [(spec.channel, spec.enabled) for spec in self.config.channels]

        self.send("set_runtime_channel", self.channel_request(enabled=False), "req-1")
        self.send("set_runtime_channel", self.channel_request(channel="speak", enabled=False), "req-2")

        after = [(spec.channel, spec.enabled) for spec in self.config.channels]
        self.assertEqual(before, after)
        self.assertTrue(all(spec.enabled for spec in self.config.channels))

    def test_runtime_switches_are_memory_only_and_reset_with_the_session(self) -> None:
        self.send("set_runtime_channel", self.channel_request(enabled=False), "req-1")
        self.send("set_speak_muted", self.mute_request(muted=True), "req-2")
        self.assertFalse(self.session.runtime.effective_enabled("listen"))
        self.assertTrue(self.session.runtime.speak_muted())

        self._install(BOTH_CHANNELS)

        self.assertTrue(self.session.runtime.effective_enabled("listen"))
        self.assertTrue(self.session.runtime.effective_enabled("speak"))
        self.assertFalse(self.session.runtime.speak_muted())

    def test_a_stopped_session_rejects_commands_and_stays_silent(self) -> None:
        self.server.handle_request({"id": "stop-1", "command": "stop", "params": {}})
        emitted = len(self.lines())

        response = self.send("set_runtime_channel", self.channel_request(), "req-2")

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "no_active_session")
        self.assertEqual(len(self.lines()), emitted + 1)
        self.assertFalse(
            self.server.emit_session_event(
                self.session, "runtime.channel", {"channel": "listen", "enabled": False}
            )
        )
        self.assertEqual(len(self.events("runtime.channel")), 0)

    def test_malformed_params_never_reach_the_runtime_state(self) -> None:
        # A non-object params payload never reaches the handler at all.
        for params in [[], "listen", 7]:
            with self.subTest(params=params):
                response = self.send("set_runtime_channel", params)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_request")
        # Nothing recognisable in params at all: both session_id and channel are
        # missing, which the contract calls a parameter problem.
        for params in [{}, {"enabled": False}, {"channel": "listen"}]:
            with self.subTest(params=params):
                response = self.send("set_runtime_channel", params)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_params")
        self.assertTrue(self.session.runtime.effective_enabled("listen"))

    def test_switching_channels_never_rebuilds_the_session(self) -> None:
        channels = tuple(self.session.channels)
        specs = tuple(self.session.specs)

        self.send("set_runtime_channel", self.channel_request(enabled=False), "req-1")
        self.send("set_runtime_channel", self.channel_request(enabled=True), "req-2")

        self.assertEqual(tuple(self.session.channels), channels)
        self.assertEqual(tuple(self.session.specs), specs)
        self.assertFalse(any(channel.is_alive() for channel in self.session.channels))

    def test_concurrent_switches_do_not_deadlock(self) -> None:
        failures: list[BaseException] = []

        def toggle(channel: str) -> None:
            try:
                for index in range(25):
                    self.server.handle_request(
                        {
                            "id": f"{channel}-{index}",
                            "command": "set_runtime_channel",
                            "params": self.channel_request(channel=channel, enabled=index % 2 == 0),
                        }
                    )
            except BaseException as exc:  # noqa: BLE001 - reported below
                failures.append(exc)

        workers = [threading.Thread(target=toggle, args=(name,)) for name in ("listen", "speak")]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(10)

        self.assertEqual(failures, [])
        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(len([line for line in self.lines() if line["type"] == "response"]), 50)


class RuntimeMuteCommandTests(RuntimeCommandHarness):
    def test_muting_is_idempotent(self) -> None:
        first = self.send("set_speak_muted", self.mute_request(), "req-1")
        second = self.send("set_speak_muted", self.mute_request(), "req-2")

        self.assertEqual(
            first["result"],
            {"session_id": SESSION_ID, "muted": True, "changed": True},
        )
        self.assertTrue(second["ok"])
        self.assertFalse(second["result"]["changed"])
        self.assertTrue(second["result"]["muted"])
        announced = self.events("runtime.mute")
        self.assertEqual(len(announced), 1)
        self.assertEqual(announced[0]["data"], {"muted": True})

    def test_unmuting_keeps_the_speak_channel_alive(self) -> None:
        self.send("set_speak_muted", self.mute_request(), "req-1")
        response = self.send("set_speak_muted", self.mute_request(muted=False), "req-2")

        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["changed"])
        self.assertFalse(response["result"]["muted"])
        self.assertFalse(self.session.runtime.speak_muted())
        # The channel still exists and is still enabled: mute never disables it.
        self.assertTrue(self.session.runtime.effective_enabled("speak"))
        self.assertTrue(self.session.runtime.configured("speak"))
        self.assertEqual(
            [event["data"]["muted"] for event in self.events("runtime.mute")], [True, False]
        )

    def test_muted_requires_a_boolean(self) -> None:
        for muted in ["true", "yes", 1, 0, None, []]:
            with self.subTest(muted=muted):
                response = self.send("set_speak_muted", self.mute_request(muted=muted))
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_params")
        self.assertFalse(self.session.runtime.speak_muted())

    def test_missing_session_id_is_invalid_params(self) -> None:
        params = {"muted": True}
        response = self.send("set_speak_muted", params)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_params")

    def test_session_mismatch_leaves_the_mute_flag_alone(self) -> None:
        self.send("set_speak_muted", self.mute_request(muted=True), "req-1")

        response = self.send(
            "set_speak_muted", self.mute_request(session_id=OTHER_SESSION_ID, muted=False), "req-2"
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "session_mismatch")
        self.assertTrue(self.session.runtime.speak_muted())

    def test_mute_while_the_speak_channel_is_switched_off_is_still_allowed(self) -> None:
        # Disabling a channel at runtime does not remove it from the session, so
        # the speak mute stays meaningful (contract section 1, rules 4 and 5).
        self.send("set_runtime_channel", self.channel_request(channel="speak", enabled=False), "req-1")
        response = self.send("set_speak_muted", self.mute_request(muted=True), "req-2")

        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["changed"])
        self.assertTrue(self.session.runtime.speak_muted())

    def test_mute_does_not_touch_the_listen_channel(self) -> None:
        self.send("set_speak_muted", self.mute_request(muted=True))

        self.assertTrue(self.session.runtime.effective_enabled("listen"))
        self.assertEqual(self.events("runtime.channel"), [])


class SpeakMuteReleaseTests(RuntimeCommandHarness):
    """Contract 1.5: closing the speak channel releases the mute in one call."""

    def close_speak(self, request_id: str = "close-1") -> dict:
        return self.send(
            "set_runtime_channel",
            self.channel_request(channel="speak", enabled=False),
            request_id,
        )

    def open_speak(self, request_id: str = "open-1") -> dict:
        return self.send(
            "set_runtime_channel",
            self.channel_request(channel="speak", enabled=True),
            request_id,
        )

    @staticmethod
    def _muted_flags(events: list[dict]) -> list[object]:
        return [event["data"]["muted"] for event in events]

    def test_closing_a_muted_speak_channel_releases_the_mute(self) -> None:
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")
        self.assertTrue(self.session.runtime.speak_muted())
        self.assertFalse(self.session.runtime.should_capture("speak"))

        response = self.close_speak()

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["channel"], "speak")
        self.assertFalse(response["result"]["enabled"])
        self.assertTrue(response["result"]["changed"])
        self.assertFalse(self.session.runtime.speak_muted())
        # The release is announced, so Rust never renders "channel off + mute on".
        self.assertEqual(self._muted_flags(self.events("runtime.mute")), [True, False])
        self.assertEqual(
            [event["data"]["enabled"] for event in self.events("runtime.channel")], [False]
        )

    def test_reopening_the_speak_channel_does_not_write_the_mute_back(self) -> None:
        # The reverse direction of 1.5 stays a no-op: enabling a channel never
        # re-mutes it, not even one muted while the channel was switched off.
        self.close_speak()
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")
        self.assertTrue(self.session.runtime.speak_muted())

        response = self.open_speak()

        self.assertTrue(response["result"]["changed"])
        self.assertTrue(response["result"]["enabled"])
        self.assertTrue(self.session.runtime.speak_muted())
        self.assertEqual(self._muted_flags(self.events("runtime.mute")), [True])

    def test_closing_an_unmuted_speak_channel_sends_no_mute_event(self) -> None:
        self.assertFalse(self.session.runtime.speak_muted())

        response = self.close_speak()

        self.assertTrue(response["result"]["changed"])
        self.assertEqual(self.events("runtime.mute"), [])

    def test_repeating_the_close_stays_idempotent(self) -> None:
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")
        first = self.close_speak("close-1")
        second = self.close_speak("close-2")

        self.assertTrue(first["result"]["changed"])
        self.assertTrue(second["ok"])
        self.assertFalse(second["result"]["changed"])
        self.assertFalse(second["result"]["enabled"])
        self.assertEqual(len(self.events("runtime.channel")), 1)
        self.assertEqual(self._muted_flags(self.events("runtime.mute")), [True, False])
        self.assertFalse(self.session.runtime.speak_muted())

    def test_closing_the_listen_channel_leaves_the_mute_alone(self) -> None:
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")

        response = self.send("set_runtime_channel", self.channel_request(enabled=False), "close-1")

        self.assertTrue(response["result"]["changed"])
        self.assertTrue(self.session.runtime.speak_muted())
        self.assertEqual(self._muted_flags(self.events("runtime.mute")), [True])

    def test_reopening_after_a_close_restores_microphone_audio(self) -> None:
        # The user-visible failure this rule prevents: Ctrl+Shift+S reopens the
        # microphone and a ghost mute silently keeps it dead.
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")
        self.close_speak()
        self.open_speak()

        self.assertFalse(self.session.runtime.speak_muted())
        self.assertTrue(self.session.runtime.effective_enabled("speak"))
        self.assertTrue(self.session.runtime.should_capture("speak"))

    def test_a_rejected_close_never_releases_the_mute(self) -> None:
        # A failed command must not touch any state (contract 3.2).
        self.send("set_speak_muted", self.mute_request(muted=True), "mute-1")

        response = self.send(
            "set_runtime_channel",
            self.channel_request(channel="speak", enabled=False, session_id=OTHER_SESSION_ID),
            "close-1",
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "session_mismatch")
        self.assertTrue(self.session.runtime.speak_muted())
        self.assertEqual(self._muted_flags(self.events("runtime.mute")), [True])


class RuntimeContractSurfaceTests(RuntimeCommandHarness):
    def test_the_ready_event_advertises_the_runtime_commands(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        server.writer.event("ready", None, {"commands": list(bridge.RUNTIME_COMMANDS)})

        ready = json.loads(stdout.getvalue().splitlines()[0])
        self.assertEqual(ready["data"]["commands"], ["set_runtime_channel", "set_speak_muted"])

    def test_protocol_literals_match_the_contract(self) -> None:
        self.assertEqual(bridge.RUNTIME_CHANNELS, livetranslate.CHANNEL_IDS)
        self.assertEqual(
            bridge.RUNTIME_EVENTS,
            ("runtime.channel", "runtime.mute", "network.status", "audio.status"),
        )
        self.assertEqual(
            bridge.RUNTIME_COMMAND_ERROR_CODES,
            (
                "invalid_params",
                "invalid_channel",
                "no_active_session",
                "session_mismatch",
                "channel_not_configured",
                "internal_error",
            ),
        )
        self.assertEqual(
            bridge.ERROR_SERVICES, ("audio", "network", "configuration", "system")
        )
        # The engine duplicates three of the new codes because it cannot import
        # this module; drift would silently break the Rust error mapping.
        for code in livetranslate.ENGINE_CONTRACT_ERROR_CODES:
            with self.subTest(code=code):
                self.assertIn(code, bridge.CONTRACT_ERROR_CODES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
