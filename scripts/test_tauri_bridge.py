"""Offline tests for the headless Tauri bridge.

Run with:
    .venv/Scripts/python.exe scripts/test_tauri_bridge.py
"""

from __future__ import annotations

import io
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx


sys.path.insert(0, str(Path(__file__).parent))
import tauri_bridge as bridge  # noqa: E402


def _spec(protocol: str, base_url: str, model: str, api_key: str) -> "bridge.ProviderSpec":
    return bridge.ProviderSpec(protocol=protocol, base_url=base_url, model=model, api_key=api_key)


def _runtime_config() -> "bridge.RuntimeConfig":
    return bridge.RuntimeConfig(
        translation=_spec("gemini", "https://relay.example", "test-model", "gemini-secret"),
        recognition=_spec("dashscope", "wss://asr.example/ws", "asr-model", "dashscope-secret"),
        source_language="English",
        target_language="Chinese",
    )


class UrlValidationTests(unittest.TestCase):
    def test_secure_urls_and_version_suffix_normalization(self) -> None:
        self.assertEqual(
            bridge.normalize_gemini_base_url("https://relay.example/v1beta/"),
            "https://relay.example",
        )
        self.assertEqual(
            bridge.normalize_gemini_base_url("https://relay.example/gemini/v1beta"),
            "https://relay.example/gemini",
        )
        self.assertEqual(
            bridge.normalize_openai_base_url("https://api.example/v1/"),
            "https://api.example",
        )
        # Only a terminal version component is stripped, never a relay prefix.
        self.assertEqual(
            bridge.normalize_openai_base_url("https://api.example/v1/proxy"),
            "https://api.example/v1/proxy",
        )
        self.assertEqual(
            bridge.normalize_dashscope_ws_url("wss://asr.example/ws/"),
            "wss://asr.example/ws",
        )
        with self.assertRaises(bridge.ProtocolError):
            bridge.normalize_dashscope_ws_url("ws://asr.example/ws")
        with self.assertRaises(bridge.ProtocolError):
            bridge.normalize_gemini_base_url("http://relay.example")
        with self.assertRaises(bridge.ProtocolError):
            bridge.normalize_openai_base_url("http://api.example")

    def test_provider_dispatch_rejects_unknown_protocols(self) -> None:
        self.assertEqual(
            bridge.normalize_provider_base_url("openai", "https://api.example/v1"),
            "https://api.example",
        )
        with self.assertRaises(bridge.ProtocolError):
            bridge.normalize_provider_base_url("anthropic", "https://api.example")


class RuntimeConfigTests(unittest.TestCase):
    def test_tauri_camel_case_settings_reach_the_engine(self) -> None:
        config = bridge.RuntimeConfig.from_start_params(
            {
                "config": {
                    "sourceLanguage": "Japanese",
                    "targetLanguage": "English",
                    "translation": {
                        "protocol": "openai",
                        "baseUrl": "https://relay.example/custom/v1",
                        "model": "model-from-settings",
                    },
                    "recognition": {
                        "protocol": "dashscope",
                        "baseUrl": "wss://asr.example/custom",
                        "model": "asr-from-settings",
                    },
                },
                "secrets": {
                    "translationApiKey": "translation-key",
                    "recognitionApiKey": "recognition-key",
                },
            }
        )

        self.assertEqual(config.translation.protocol, "openai")
        self.assertEqual(config.translation.base_url, "https://relay.example/custom")
        self.assertEqual(config.translation.model, "model-from-settings")
        self.assertEqual(config.translation.api_key, "translation-key")
        self.assertEqual(config.recognition.protocol, "dashscope")
        self.assertEqual(config.recognition.base_url, "wss://asr.example/custom")
        self.assertEqual(config.recognition.model, "asr-from-settings")
        self.assertEqual(config.recognition.api_key, "recognition-key")
        self.assertEqual(config.source_language, "Japanese")
        self.assertEqual(config.target_language, "English")

    def test_snake_case_payload_is_equally_accepted(self) -> None:
        config = bridge.RuntimeConfig.from_start_params(
            {
                "translation": {
                    "protocol": "gemini",
                    "base_url": "https://relay.example/v1beta",
                    "model": "gemini-model",
                },
                "recognition": {"base_url": "wss://asr.example/ws", "model": "asr-model"},
                "translation_api_key": "translation-key",
                "recognition_api_key": "recognition-key",
            }
        )

        self.assertEqual(config.translation.base_url, "https://relay.example")
        self.assertEqual(config.recognition.protocol, "dashscope")
        self.assertEqual(config.recognition.model, "asr-model")

    def test_unsupported_protocol_is_rejected(self) -> None:
        with self.assertRaises(bridge.ProtocolError):
            bridge.RuntimeConfig.from_start_params(
                {
                    "translation": {"protocol": "anthropic", "base_url": "https://api.example"},
                    "translation_api_key": "k",
                    "recognition_api_key": "k",
                }
            )

    def test_start_uses_the_selected_openai_provider_contract(self) -> None:
        captured: dict[str, object] = {}

        class CapturingSession:
            def __init__(
                self,
                _server: "bridge.BridgeServer",
                session_id: str,
                config: "bridge.RuntimeConfig",
            ) -> None:
                self.session_id = session_id
                self.config = config
                self.state = "starting"
                self.stop_event = threading.Event()
                captured["config"] = config

            def start(self) -> None:
                captured["started"] = True

            def cancel_pending_translations(self) -> None:
                pass

        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        session_id = "6f4db13f-626c-4e4e-9147-c8f065b7ba8a"

        with patch.object(bridge, "TranslationSession", CapturingSession):
            server.handle_request(
                {
                    "id": "start-openai",
                    "command": "start",
                    "params": {
                        "session_id": session_id,
                        "config": {
                            "sourceLanguage": "English",
                            "targetLanguage": "简体中文",
                            "translation": {
                                "protocol": "openai",
                                "baseUrl": "https://openai-relay.example/v1",
                                "model": "custom-chat-model",
                            },
                            "recognition": {
                                "protocol": "dashscope",
                                "baseUrl": "wss://asr.example/ws",
                                "model": "asr-model",
                            },
                        },
                        "secrets": {
                            "translationApiKey": "openai-key",
                            "recognitionApiKey": "recognition-key",
                        },
                    },
                }
            )

        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        response = messages[0]
        config = captured["config"]
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["session_id"], session_id)
        self.assertTrue(captured["started"])
        self.assertIsInstance(config, bridge.RuntimeConfig)
        self.assertEqual(config.translation.protocol, "openai")
        self.assertEqual(config.translation.base_url, "https://openai-relay.example")
        self.assertEqual(config.translation.model, "custom-chat-model")
        self.assertEqual(config.translation.api_key, "openai-key")


class AudioLifecycleTests(unittest.TestCase):
    def test_session_preloads_native_audio_stack_on_constructing_thread(self) -> None:
        calls: list[int] = []

        class StubTranslationService:
            def __init__(self, _config: "bridge.RuntimeConfig") -> None:
                pass

        class StubAudioWorker:
            def __init__(self, _server: "bridge.BridgeServer", _session: object) -> None:
                pass

        server = bridge.BridgeServer(io.StringIO(), io.StringIO())
        with (
            patch.object(
                bridge,
                "preload_audio_dependencies",
                side_effect=lambda: calls.append(threading.get_ident()),
            ),
            patch.object(bridge, "TranslationService", StubTranslationService),
            patch.object(bridge, "AudioWorker", StubAudioWorker),
        ):
            bridge.TranslationSession(server, "session-preload", _runtime_config())

        self.assertEqual(calls, [threading.get_ident()])

    def test_audio_startup_timeout_is_visible_and_stops_the_session(self) -> None:
        class TimedOutSession:
            def __init__(self) -> None:
                self.session_id = "session-timeout"
                self.config = _runtime_config()
                self.stop_event = threading.Event()
                self.state = "starting"
                self.audio_ready = False
                self.cancelled = False

            def begin_stop(self) -> None:
                self.stop_event.set()

            def cancel_pending_translations(self) -> None:
                self.cancelled = True

        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        session = TimedOutSession()
        with server._session_lock:
            server._current_session = session

        server.on_audio_startup_timeout(session)

        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events], ["error", "state", "stopped"])
        self.assertEqual(events[0]["data"]["code"], "audio_startup_timeout")
        self.assertTrue(session.stop_event.is_set())
        self.assertTrue(session.cancelled)
        self.assertIsNone(server._current_session)

    def test_unexpected_asr_completion_stops_instead_of_silently_hanging(self) -> None:
        class ActiveSession:
            def __init__(self) -> None:
                self.session_id = "session-asr"
                self.config = _runtime_config()
                self.stop_event = threading.Event()

            def begin_stop(self) -> None:
                self.stop_event.set()

        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        session = ActiveSession()
        with server._session_lock:
            server._current_session = session

        server.on_asr_ended(session, "complete")

        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events], ["asr.status", "error"])
        self.assertEqual(events[1]["data"]["code"], "asr_complete")
        self.assertTrue(session.stop_event.is_set())


class ProviderClientTests(unittest.TestCase):
    """Exercise both wire protocols offline through httpx's mock transport."""

    def _client(self, cls, spec, handler):
        return cls(spec, transport=httpx.MockTransport(handler))

    def _sse(self, *events: str) -> bytes:
        return "".join(f"{event}\n\n" for event in events).encode()

    def test_gemini_streams_sse_deltas_from_the_streaming_endpoint(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["key"] = request.headers.get("x-goog-api-key")
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(
                200,
                content=self._sse(
                    'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}',
                    ": keepalive",
                    'data: {"candidates":[{"content":{"parts":[{"text":"世"},{"text":"界"}]}}]}',
                    'data: {"usageMetadata":{"totalTokenCount":9}}',
                ),
                headers={"content-type": "text/event-stream"},
            )

        client = self._client(
            bridge.GeminiClient,
            _spec("gemini", "https://relay.example", "test-model", "gemini-secret"),
            handler,
        )
        try:
            self.assertEqual(client.translate("hello"), "你好世界")
        finally:
            client.close()
        self.assertEqual(
            seen["url"],
            "https://relay.example/v1beta/models/test-model:streamGenerateContent?alt=sse",
        )
        self.assertEqual(seen["key"], "gemini-secret")
        # Thinking off, and the temperature it sits next to must survive.
        self.assertEqual(
            seen["body"]["generationConfig"],
            {"temperature": 0.1, "thinkingConfig": {"thinkingBudget": 0}},
        )

    def test_gemini_model_listing_filters_on_generate_content(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                        {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
                        {"name": "models/gemini-2.5-pro"},
                    ]
                },
            )

        client = self._client(
            bridge.GeminiClient,
            _spec("gemini", "https://relay.example", "test-model", "k"),
            handler,
        )
        try:
            self.assertEqual(client.list_models(), ["gemini-2.5-flash", "gemini-2.5-pro"])
        finally:
            client.close()

    def test_openai_streams_sse_deltas_and_asks_for_streaming(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(
                200,
                content=self._sse(
                    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
                    'data: {"choices":[{"delta":{"content":" 译"}}]}',
                    'data: {"choices":[{"delta":{"content":"文 "}}]}',
                    "data: [DONE]",
                ),
                headers={"content-type": "text/event-stream"},
            )

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "openai-secret"),
            handler,
        )
        try:
            self.assertEqual(client.translate("hello"), "译文")
        finally:
            client.close()
        self.assertEqual(seen["url"], "https://api.example/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer openai-secret")
        self.assertEqual(seen["body"]["model"], "gpt-test")
        self.assertIs(seen["body"]["stream"], True)
        self.assertEqual(seen["body"]["thinking"], {"type": "disabled"})

    def test_relay_that_rejects_the_thinking_switch_recovers_once(self) -> None:
        """A gateway that knows no ``thinking`` field must not fail every sentence."""

        bodies: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode())
            bodies.append(body)
            if "thinking" in body:
                return httpx.Response(400, json={"error": {"message": "unknown field: thinking"}})
            return httpx.Response(
                200,
                content=self._sse('data: {"choices":[{"delta":{"content":"译文"}}]}', "data: [DONE]"),
                headers={"content-type": "text/event-stream"},
            )

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            self.assertEqual(client.translate("hello"), "译文")
            # The downgrade sticks, so only the first sentence pays a round trip.
            self.assertEqual(client.translate("again"), "译文")
        finally:
            client.close()

        self.assertEqual([("thinking" in body) for body in bodies], [True, False, False])

    def test_openai_model_listing(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}]})

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            self.assertEqual(client.list_models(), ["a", "b"])
        finally:
            client.close()

    def test_http_error_surfaces_the_status_code(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "invalid api key"}})

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertIn("HTTP 401", str(caught.exception))
        self.assertIn("invalid api key", str(caught.exception))

    def test_relay_that_ignores_the_streaming_flag_still_translates(self) -> None:
        """Some relays accept ``stream: true`` and answer with one buffered body."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": " 译文 "}}]})

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            self.assertEqual(client.translate("hello"), "译文")
        finally:
            client.close()

    def test_error_delivered_inside_a_200_stream_is_surfaced(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=self._sse('data: {"error":{"message":"upstream overloaded"}}'),
                headers={"content-type": "text/event-stream"},
            )

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertIn("upstream overloaded", str(caught.exception))

    def test_gemini_block_reason_fails_the_stream(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=self._sse('data: {"promptFeedback":{"blockReason":"SAFETY"}}'),
                headers={"content-type": "text/event-stream"},
            )

        client = self._client(
            bridge.GeminiClient,
            _spec("gemini", "https://relay.example", "test-model", "k"),
            handler,
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertIn("SAFETY", str(caught.exception))

    def test_non_stream_body_that_is_not_json_reports_a_clear_failure(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>502 Bad Gateway</html>")

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertIn("没有返回可用的流式响应", str(caught.exception))

    def test_idle_gap_and_whole_response_have_separate_budgets(self) -> None:
        """The read timeout only measures silence; the total cap bounds the rest."""

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            lambda _request: httpx.Response(200),
        )
        try:
            self.assertEqual(client._client.timeout.read, bridge.TRANSLATION_IDLE_TIMEOUT_S)
            self.assertEqual(client._client.timeout.connect, bridge.TRANSLATION_CONNECT_TIMEOUT_S)
            self.assertEqual(client._total_timeout_s, bridge.TRANSLATION_TOTAL_TIMEOUT_S)
        finally:
            client.close()

    def test_a_stream_that_never_ends_is_cut_off_by_the_total_budget(self) -> None:
        def trickle():
            for _ in range(200):
                time.sleep(0.01)
                yield b'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, content=trickle(), headers={"content-type": "text/event-stream"}
            )

        client = bridge.OpenAICompatibleClient(
            _spec("openai", "https://api.example", "gpt-test", "k"),
            total_timeout_s=0.1,
            transport=httpx.MockTransport(handler),
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertIn("没有结束", str(caught.exception))


class RedactionTests(unittest.TestCase):
    def test_both_provider_keys_are_removed(self) -> None:
        config = _runtime_config()
        message = bridge.BridgeServer._redact(
            "failed with gemini-secret and dashscope-secret", config
        )
        self.assertNotIn("gemini-secret", message)
        self.assertNotIn("dashscope-secret", message)
        self.assertEqual(message.count("***"), 2)


class ProbeCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stdout = io.StringIO()
        self.server = bridge.BridgeServer(io.StringIO(), self.stdout)
        self._original_clients = dict(bridge.TRANSLATION_CLIENTS)

    def tearDown(self) -> None:
        bridge.TRANSLATION_CLIENTS.clear()
        bridge.TRANSLATION_CLIENTS.update(self._original_clients)

    def _responses(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.stdout.getvalue().splitlines()]

    def _install_stub(self, *, models: list[str] | None = None, error: Exception | None = None) -> None:
        class StubClient:
            def __init__(self, _spec, **_kwargs) -> None:
                pass

            def close(self) -> None:
                pass

            def list_models(self) -> list[str]:
                if error is not None:
                    raise error
                return list(models or [])

            def translate(self, _prompt: str) -> str:
                if error is not None:
                    raise error
                return "ok"

        bridge.TRANSLATION_CLIENTS["gemini"] = StubClient

    def test_translation_model_listing(self) -> None:
        self._install_stub(models=["gemini-2.5-flash"])
        self.server.handle_request(
            {
                "id": "m",
                "command": "probe.models",
                "params": {
                    "kind": "translation",
                    "provider": {"protocol": "gemini", "base_url": "https://relay.example"},
                    "secrets": {"api_key": "secret"},
                },
            }
        )
        response = self._responses()[0]
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["models"], ["gemini-2.5-flash"])

    def test_recognition_model_listing_is_reported_unsupported(self) -> None:
        self.server.handle_request(
            {
                "id": "m",
                "command": "probe.models",
                "params": {
                    "kind": "recognition",
                    "provider": {"protocol": "dashscope", "base_url": "wss://asr.example/ws"},
                    "secrets": {"api_key": "secret"},
                },
            }
        )
        response = self._responses()[0]
        self.assertTrue(response["ok"])
        self.assertFalse(response["result"]["supported"])
        self.assertEqual(response["result"]["models"], [])

    def test_unknown_protocol_is_an_invalid_probe_request(self) -> None:
        self.server.handle_request(
            {
                "id": "m",
                "command": "probe.models",
                "params": {
                    "kind": "translation",
                    "provider": {"protocol": "anthropic", "base_url": "https://api.example"},
                    "secrets": {"api_key": "secret"},
                },
            }
        )
        self.assertEqual(self._responses()[0]["error"]["code"], "invalid_probe_request")

    def test_connect_reports_latency_and_redacts_failures(self) -> None:
        self._install_stub(models=[])
        self.server.handle_request(
            {
                "id": "c",
                "command": "probe.connect",
                "params": {
                    "kind": "translation",
                    "provider": {
                        "protocol": "gemini",
                        "base_url": "https://relay.example",
                        "model": "test-model",
                    },
                    "secrets": {"api_key": "secret"},
                },
            }
        )
        response = self._responses()[0]
        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["ok"])
        self.assertIsInstance(response["result"]["latency_ms"], int)

        self.stdout.truncate(0)
        self.stdout.seek(0)
        self._install_stub(error=RuntimeError("HTTP 401: bad key super-secret-value"))
        self.server.handle_request(
            {
                "id": "c2",
                "command": "probe.connect",
                "params": {
                    "kind": "translation",
                    "provider": {
                        "protocol": "gemini",
                        "base_url": "https://relay.example",
                        "model": "test-model",
                    },
                    "secrets": {"api_key": "super-secret-value"},
                },
            }
        )
        failure = self._responses()[0]
        self.assertEqual(failure["error"]["code"], "probe_failed")
        self.assertNotIn("super-secret-value", failure["error"]["message"])


class SessionIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        # These tests build a real session to exercise queue admission and
        # callback isolation; the native audio stack it preloads on construction
        # is irrelevant here and absent from an offline test environment.
        preload_patch = patch.object(bridge, "preload_audio_dependencies")
        preload_patch.start()
        self.addCleanup(preload_patch.stop)
        self._original_service = bridge.TranslationService
        self.release = threading.Event()
        self.started = threading.Event()

        started = self.started
        release = self.release

        class BlockingService:
            def __init__(self, _config: bridge.RuntimeConfig) -> None:
                pass

            def translate(self, text: str) -> str:
                started.set()
                release.wait(timeout=2)
                return f"translated:{text}"

        bridge.TranslationService = BlockingService
        self.stdout = io.StringIO()
        self.server = bridge.BridgeServer(io.StringIO(), self.stdout)
        self.config = _runtime_config()

    def tearDown(self) -> None:
        self.release.set()
        bridge.TranslationService = self._original_service

    def _events(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.stdout.getvalue().splitlines()]

    def test_queue_is_bounded_and_stop_discards_stale_completion(self) -> None:
        session = bridge.TranslationSession(self.server, "session-a", self.config)
        with self.server._session_lock:
            self.server._current_session = session

        # One worker is intentionally blocked. Seven more jobs fit behind it;
        # the ninth submission must produce a visible queue-full event.
        for source_seq in range(1, bridge.MAX_TRANSLATION_QUEUE + 1):
            session.submit_translation(source_seq, f"text-{source_seq}")
        self.assertTrue(self.started.wait(timeout=1))
        session.submit_translation(bridge.MAX_TRANSLATION_QUEUE + 1, "overflow")
        self.assertIn(
            "translation.dropped",
            [event["event"] for event in self._events() if event["type"] == "event"],
        )

        session.begin_stop()
        session.cancel_pending_translations()
        self.release.set()
        time.sleep(0.05)

        # The in-flight future may finish after stop, but callback isolation means
        # it cannot emit a translation for the now-stale session.
        self.assertNotIn(
            "translation",
            [event["event"] for event in self._events() if event["type"] == "event"],
        )

    def test_failed_translation_identifies_the_source_segment(self) -> None:
        class FailingService:
            def __init__(self, _config: bridge.RuntimeConfig) -> None:
                pass

            def translate(self, _text: str) -> str:
                raise RuntimeError("upstream rejected request")

        bridge.TranslationService = FailingService
        session = bridge.TranslationSession(self.server, "session-failure", self.config)
        with self.server._session_lock:
            self.server._current_session = session

        session.submit_translation(7, "broken segment")
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            events = [event for event in self._events() if event.get("type") == "event"]
            failed = [event for event in events if event.get("event") == "translation.failed"]
            if failed:
                break
            time.sleep(0.01)
        else:
            self.fail("translation.failed event was not emitted")

        self.assertEqual(failed[0]["data"]["source_seq"], 7)
        self.assertEqual(failed[0]["data"]["source_text"], "broken segment")
        self.assertIn("error", [event["event"] for event in events])


class ProtocolTests(unittest.TestCase):
    def test_ping_and_unknown_command_are_jsonl_responses(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        self.assertTrue(server.handle_request({"id": "p", "command": "ping", "params": {}}))
        self.assertTrue(server.handle_request({"id": "x", "command": "other", "params": {}}))
        responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(responses[0]["id"], "p")
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[1]["error"]["code"], "unknown_command")


if __name__ == "__main__":
    unittest.main(verbosity=2)
