"""Exercise reconnects over real local WebSockets, without a model or microphone.

Run: .venv/bin/python scripts/test_realtime_reconnect.py
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import livetranslate as live
import tauri_bridge as bridge


class Recorder:
    def record(self, frames: int) -> object:
        time.sleep(0.003)
        return np.zeros((frames, 1), dtype="float32")

    def __exit__(self, *_args: object) -> None:
        pass


# The real server announces its session before any client event is valid, and
# the client may not configure the session before that announcement arrives.
SESSION_CREATED = '{"type":"session.created","session":{"id":"test-session"}}'


class ToneRecorder(Recorder):
    """Non-silent capture so keepalive silence stays distinguishable from audio."""

    def record(self, frames: int) -> object:
        time.sleep(0.003)
        return np.full((frames, 1), 0.25, dtype="float32")


class ReconnectTests(unittest.IsolatedAsyncioTestCase):
    def session(self, *, two_channels: bool = False):
        self.stdout = io.StringIO()
        self.server = bridge.BridgeServer(io.StringIO(), self.stdout)
        config = bridge.RuntimeConfig.from_start_params({
            "engine": "realtime",
            "audio": {
                "listen": {"enabled": True, "inputKind": "microphone", "playAudio": False,
                           "targetLanguage": "简体中文"},
                "speak": {"enabled": two_channels, "inputKind": "microphone", "playAudio": False,
                          "targetLanguage": "English"},
            },
            "secrets": {"realtimeApiKey": "offline-test-key"},
        })
        session = bridge.create_session(self.server, "reconnect-session", config)
        self.server._current_session = session
        return session

    def events(self, name: str) -> list[dict]:
        return [payload for payload in map(json.loads, self.stdout.getvalue().splitlines())
                if payload.get("event") == name]

    async def wait_until(self, predicate) -> None:
        async def wait():
            while not predicate():
                await asyncio.sleep(0.005)
        await asyncio.wait_for(wait(), timeout=5)

    async def stop(self, session, tasks: list[asyncio.Task]) -> None:
        for channel in session.channels:
            channel.request_stop()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=3)

    async def test_remote_close_recovers_subtitles_on_the_same_session(self):
        await self.check_remote_recovery(finished_event=False)

    async def test_server_session_finished_recovers_without_waiting_for_socket_close(self):
        await self.check_remote_recovery(finished_event=True)

    async def check_remote_recovery(self, *, finished_event: bool):
        session = self.session()
        channel = session.channels[0]
        attempts = []

        async def handler(socket):
            attempts.append(socket)
            number = len(attempts)
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append":
                        if number == 1:
                            await socket.send(json.dumps({
                                "type": "conversation.item.input_audio_transcription.completed",
                                "transcript": "interrupted source",
                            }))
                            if finished_event:
                                await socket.send('{"type":"session.finished"}')
                                await socket.wait_closed()
                            else:
                                await socket.close(code=1001, reason="simulated session expiry")
                            return
                        if number == 2:
                            number = 0
                            # The new translation arrives first. It must never
                            # attach to the previous connection's pending source.
                            await socket.send(json.dumps({
                                "type": "response.text.done", "response_id": "response-1", "text": "恢复后的译文",
                            }))
                            await socket.send(json.dumps({
                                "type": "conversation.item.input_audio_transcription.completed",
                                "transcript": "new source",
                            }))
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "RECONNECT_INITIAL_DELAY_S", 0.01):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: bool(self.events("translation")))
                    self.assertEqual(len(attempts), 2)
                    translated = self.events("translation")[-1]
                    self.assertEqual(translated["session_id"], session.session_id)
                    self.assertEqual(translated["data"]["source_text"], "new source")
                    self.assertEqual(translated["data"]["text"], "恢复后的译文")
                    self.assertEqual(len(self.events("translation.failed")), 1)
                    self.assertFalse(self.events("error"))
                    self.assertFalse(session.stop_event.is_set())
                    self.assertNotIn("stopped", [e["data"].get("state") for e in self.events("state")])
                    self.assertEqual(self.events("network.status")[-1]["data"]["status"], "ready")
                finally:
                    await self.stop(session, [task])
        self.assertEqual(len(attempts), 2)

    async def test_a_retry_keeps_the_sibling_connection_and_runtime_switches(self):
        session = self.session(two_channels=True)
        runtime = session.runtime
        runtime.set_speak_muted(True)
        connections = {"zh": 0, "en": 0}

        async def handler(socket):
            language = ""
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        language = event["session"]["translation"]["language"]
                        connections[language] += 1
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                        if language == "zh" and connections[language] == 1:
                            # A transport failure before streaming also recovers.
                            socket.transport.abort()
                            return
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            patches = [patch.object(ch, "_prepare_input", side_effect=lambda: (Recorder(), {}))
                       for ch in session.channels]
            for ch, mock in zip(session.channels, patches):
                ch._base_url = url
                mock.start()
            with patch.object(live, "RECONNECT_INITIAL_DELAY_S", 0.01):
                tasks = [asyncio.create_task(ch._run_with_reconnect()) for ch in session.channels]
                try:
                    await self.wait_until(lambda: connections["zh"] == 2
                                          and self.events("network.status")[-1]["data"]["status"] == "ready")
                    self.assertEqual(connections, {"zh": 2, "en": 1})
                    self.assertIs(session.runtime, runtime)
                    self.assertTrue(runtime.speak_muted())
                    self.assertTrue(runtime.effective_enabled("listen"))
                    self.assertTrue(runtime.effective_enabled("speak"))
                    self.assertFalse(self.events("error"))
                finally:
                    await self.stop(session, tasks)
                    for mock in patches:
                        mock.stop()

    async def test_stop_interrupts_a_long_retry_delay_without_another_connection(self):
        session = self.session()
        channel = session.channels[0]

        async def fail():
            channel._report_failure("realtime_receive_failed", "simulated disconnect")

        with patch.object(channel, "_main", side_effect=fail) as attempt, \
                patch.object(live, "RECONNECT_INITIAL_DELAY_S", 60):
            task = asyncio.create_task(channel._run_with_reconnect())
            await self.wait_until(lambda: bool(self.events("channel.status")))
            channel.request_stop()
            await asyncio.wait_for(task, timeout=0.5)
            self.assertEqual(attempt.await_count, 1)

    async def test_idle_channel_keeps_sending_silence_instead_of_timing_out(self):
        session = self.session()
        channel = session.channels[0]
        appends: list[dict] = []
        finish_requests: list[dict] = []
        connection_closed = asyncio.Event()
        # A runtime-disabled channel still opens and drains its device but never
        # forwards a frame, which is exactly the muted/quiet case the keepalive
        # exists for.  The real capture loop runs here; only its sends are gated.
        session.runtime.set_channel("listen", False)

        async def handler(socket):
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append":
                        appends.append(event)
                    elif event["type"] == "session.finish":
                        finish_requests.append(event)
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass
            finally:
                connection_closed.set()

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "KEEPALIVE_IDLE_GAP_S", 0.05), \
                    patch.object(live, "KEEPALIVE_CHECK_INTERVAL_S", 0.02):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: bool(appends))
                    self.assertFalse(task.done())
                    self.assertFalse(connection_closed.is_set())
                    self.assertFalse(session.stop_event.is_set())
                    self.assertFalse(self.events("error"))
                    silence = base64.b64decode(appends[0]["audio"])
                    self.assertEqual(silence, bytes(live.FRAME_SAMPLES * 2))
                    self.assertEqual(len(silence), 3200)
                finally:
                    await self.stop(session, [task])
        # The clean stop still performs the one session.finish handshake.
        self.assertEqual(len(finish_requests), 1)

    async def test_flowing_capture_frames_keep_the_keepalive_idle(self):
        session = self.session()
        channel = session.channels[0]
        appends: list[dict] = []

        async def handler(socket):
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append":
                        appends.append(event)
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            silence = bytes(live.FRAME_SAMPLES * 2)
            # A gap far larger than the test window: only capture frames may appear.
            with patch.object(channel, "_prepare_input", side_effect=lambda: (ToneRecorder(), {})), \
                    patch.object(live, "KEEPALIVE_IDLE_GAP_S", 60.0), \
                    patch.object(live, "KEEPALIVE_CHECK_INTERVAL_S", 0.01):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: len(appends) >= 3)
                    # Let the keepalive loop run many check cycles while audio flows.
                    await asyncio.sleep(0.1)
                    payloads = [base64.b64decode(event["audio"]) for event in appends]
                    self.assertGreaterEqual(len(payloads), 3)
                    self.assertTrue(all(payload and payload != silence for payload in payloads))
                    self.assertFalse(session.stop_event.is_set())
                    self.assertFalse(self.events("error"))
                finally:
                    await self.stop(session, [task])

    async def test_request_stop_cancels_the_keepalive_before_finishing(self):
        session = self.session()
        channel = session.channels[0]
        appends: list[dict] = []
        finish_requests: list[dict] = []
        session.runtime.set_channel("listen", False)

        async def handler(socket):
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append":
                        appends.append(event)
                    elif event["type"] == "session.finish":
                        finish_requests.append(event)
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "KEEPALIVE_IDLE_GAP_S", 0.0), \
                    patch.object(live, "KEEPALIVE_CHECK_INTERVAL_S", 0.05):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: bool(appends))
                    channel.request_stop()
                    # The keepalive is parked in an interval sleep; only the
                    # explicit cancel lets the channel finish this promptly.
                    await asyncio.wait_for(task, timeout=1.0)
                finally:
                    if not task.done():
                        await self.stop(session, [task])
            sent_at_stop = len(appends)
            await asyncio.sleep(0.2)
            self.assertEqual(len(appends), sent_at_stop)
        self.assertEqual(len(finish_requests), 1)
        self.assertFalse(channel._failed)

    def test_keepalive_constants_stay_inside_the_server_idle_budget(self):
        # The server terminates a session after ~300 s without client audio.
        # The longest possible gap between appends on a quiet channel is one
        # idle gap plus one check interval, which must stay far below that.
        self.assertLess(live.KEEPALIVE_IDLE_GAP_S + live.KEEPALIVE_CHECK_INTERVAL_S, 300.0)
        self.assertGreater(live.KEEPALIVE_CHECK_INTERVAL_S, 0.0)
        self.assertLess(live.KEEPALIVE_CHECK_INTERVAL_S, live.KEEPALIVE_IDLE_GAP_S)
        self.assertEqual(live.KEEPALIVE_FRAME_SECONDS, live.FRAME_SECONDS)
        self.assertEqual(int(live.INPUT_SAMPLE_RATE * live.KEEPALIVE_FRAME_SECONDS), live.FRAME_SAMPLES)
        self.assertEqual(len(bytes(live.FRAME_SAMPLES * 2)), 3200)

    async def test_retry_backoff_is_capped_and_resets_after_a_stable_connection(self):
        session = self.session()
        channel = session.channels[0]
        delays = []

        async def fail():
            if len(delays) == 6:
                channel._stream_started_at = time.monotonic() - 31
            channel._report_failure("realtime_connection_closed", "simulated disconnect")

        async def wait(delay):
            delays.append(delay)
            if len(delays) == 7:
                channel.request_stop()

        with patch.object(channel, "_main", side_effect=fail), \
                patch.object(channel, "_wait_to_retry", side_effect=wait):
            await channel._run_with_reconnect()
        self.assertEqual(delays, [1, 2, 4, 8, 15, 15, 1])

    async def test_permanent_handshake_rejections_do_not_loop(self):
        for status, expected_code in [(401, "auth_failed"), (403, "auth_failed"),
                                      (400, "websocket_connect_failed"), (404, "websocket_connect_failed")]:
            with self.subTest(status=status):
                session = self.session()
                channel = session.channels[0]
                rejection = RuntimeError(f"HTTP {status}")
                rejection.response = SimpleNamespace(status_code=status)
                connector = MagicMock()
                connector.__aenter__ = AsyncMock(side_effect=rejection)
                connector.__aexit__ = AsyncMock(return_value=False)
                with patch.object(channel, "_prepare_input", return_value=(Recorder(), {})), \
                        patch.object(live, "_build_connector", return_value=connector) as connect:
                    await asyncio.wait_for(channel._run_with_reconnect(), timeout=2)
                self.assertEqual(connect.call_count, 1)
                error = self.events("error")[-1]["data"]
                self.assertEqual(error["code"], expected_code)
                self.assertFalse(error["recoverable"])

    async def test_transient_http_rejections_wait_for_recovery_instead_of_stopping(self):
        for status in (408, 429, 503):
            with self.subTest(status=status):
                session = self.session()
                channel = session.channels[0]
                rejection = RuntimeError(f"HTTP {status}")
                rejection.response = SimpleNamespace(status_code=status)
                connector = MagicMock()
                connector.__aenter__ = AsyncMock(side_effect=rejection)
                connector.__aexit__ = AsyncMock(return_value=False)
                with patch.object(channel, "_prepare_input", return_value=(Recorder(), {})), \
                        patch.object(live, "_build_connector", return_value=connector), \
                        patch.object(live, "RECONNECT_INITIAL_DELAY_S", 60):
                    task = asyncio.create_task(channel._run_with_reconnect())
                    try:
                        await self.wait_until(lambda: channel._retry_pending)
                        self.assertFalse(task.done())
                        self.assertFalse(self.events("error"))
                        self.assertFalse(session.stop_event.is_set())
                    finally:
                        await self.stop(session, [task])

    async def test_device_and_configuration_faults_do_not_loop(self):
        for code in ["audio_device_lost", "realtime_output_mismatch", "realtime_voice_clone_unsupported",
                     "realtime_protocol_error", "realtime_channel_failed"]:
            with self.subTest(code=code):
                session = self.session()
                channel = session.channels[0]

                async def fail():
                    channel._report_failure(code, "simulated permanent fault")

                with patch.object(channel, "_main", side_effect=fail) as attempt:
                    await asyncio.wait_for(channel._run_with_reconnect(), timeout=1)
                self.assertEqual(attempt.await_count, 1)
                self.assertEqual(self.events("error")[-1]["data"]["code"], code)

    async def test_the_configuration_waits_for_the_server_session(self):
        session = self.session()
        channel = session.channels[0]
        order: list[str] = []

        async def handler(socket):
            try:
                # The server announces the session only once it initialized the
                # connection's resources, which is exactly why an update sent
                # straight after the handshake can be answered with
                # "session does not exist".
                await asyncio.sleep(0.2)
                order.append("session.created")
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        order.append("session.update")
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: channel._stream_started_at is not None)
                    self.assertEqual(order, ["session.created", "session.update"])
                    self.assertFalse(self.events("error"))
                finally:
                    await self.stop(session, [task])

    async def test_a_silent_server_still_gets_configured_after_the_grace_window(self):
        session = self.session()
        channel = session.channels[0]
        updates: list[dict] = []

        async def handler(socket):
            try:
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        updates.append(event)
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            # A server that never announces its session must not hang the
            # channel: the update follows after the bounded grace window.
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "SESSION_CREATED_GRACE_S", 0.05):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: channel._stream_started_at is not None)
                    self.assertEqual(len(updates), 1)
                    self.assertFalse(self.events("error"))
                finally:
                    await self.stop(session, [task])

    async def test_a_rejected_session_recovers_by_reconnecting(self):
        session = self.session()
        channel = session.channels[0]
        attempts: list[object] = []

        async def handler(socket):
            attempts.append(socket)
            number = len(attempts)
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append" and number == 1:
                        # The server rejects an event of a session it no longer
                        # has; the socket itself stays open.
                        await socket.send(json.dumps({
                            "type": "error",
                            "error": {"code": "invalid_request_error", "message": "session does not exist"},
                        }))
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "RECONNECT_INITIAL_DELAY_S", 0.01):
                task = asyncio.create_task(channel._run_with_reconnect())
                try:
                    await self.wait_until(lambda: len(attempts) == 2
                                          and self.events("network.status")[-1]["data"]["status"] == "ready")
                    # A stale session is a connection interruption, not a dead
                    # channel: it recovers inside the same session.
                    self.assertFalse(self.events("error"))
                    self.assertFalse(session.stop_event.is_set())
                    self.assertFalse(task.done())
                    self.assertNotIn("stopped", [e["data"].get("state") for e in self.events("state")])
                finally:
                    await self.stop(session, [task])
        self.assertEqual(len(attempts), 2)

    async def test_repeated_session_rejections_stop_after_the_bounded_retries(self):
        session = self.session()
        channel = session.channels[0]
        attempts: list[object] = []

        async def handler(socket):
            attempts.append(socket)
            try:
                await socket.send(SESSION_CREATED)
                async for raw in socket:
                    event = json.loads(raw)
                    if event["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated", "session": event["session"]}))
                    elif event["type"] == "input_audio_buffer.append":
                        await socket.send(json.dumps({
                            "type": "error",
                            "error": {"code": "invalid_request_error", "message": "session does not exist"},
                        }))
                    elif event["type"] == "session.finish":
                        await socket.send('{"type":"session.finished"}')
            except ConnectionClosed:
                pass

        async with serve(handler, "127.0.0.1", 0) as websocket_server:
            channel._base_url = f"ws://127.0.0.1:{websocket_server.sockets[0].getsockname()[1]}"
            with patch.object(channel, "_prepare_input", side_effect=lambda: (Recorder(), {})), \
                    patch.object(live, "RECONNECT_INITIAL_DELAY_S", 0.01):
                await asyncio.wait_for(channel._run_with_reconnect(), timeout=10)
        # One attempt plus the bounded recoveries, then the rejection is reported
        # as a protocol error instead of reconnecting forever.
        self.assertEqual(len(attempts), live.SESSION_EXPIRED_RETRY_LIMIT + 1)
        error = self.events("error")[-1]["data"]
        self.assertEqual(error["code"], "realtime_protocol_error")
        self.assertIn("session does not exist", error["message"])

    def test_a_fast_exit_cannot_retire_a_sibling_that_has_not_started_yet(self):
        session = self.session(two_channels=True)
        with patch.object(self.server, "on_realtime_all_channels_closed") as closed:
            session.on_channel_exit("listen")
            closed.assert_not_called()
            session.on_channel_exit("speak")
            closed.assert_called_once_with(session)
            session.on_channel_exit("listen")
            closed.assert_called_once_with(session)


if __name__ == "__main__":
    unittest.main(verbosity=2)

