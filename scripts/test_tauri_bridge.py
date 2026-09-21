"""Offline tests for the headless Tauri bridge.

Run with:
    .venv/Scripts/python.exe scripts/test_tauri_bridge.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np


sys.path.insert(0, str(Path(__file__).parent))
import livetranslate  # noqa: E402
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

    def test_a_closed_keepalive_connection_is_retried_on_a_new_one(self) -> None:
        """The reported failure: a relay drops an idle connection between sentences."""

        attempts: list[int] = []

        def handler(_request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) == 1:
                raise httpx.ReadError(
                    "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation "
                    "of protocol (_ssl.c:1081)"
                )
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
            with patch.object(bridge, "TRANSLATION_RETRY_BACKOFF_S", 0):
                self.assertEqual(client.translate("hello"), "译文")
        finally:
            client.close()
        self.assertEqual(len(attempts), 2)

    def test_a_permanently_broken_connection_reports_a_readable_failure(self) -> None:
        attempts: list[int] = []

        def handler(_request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred")

        client = self._client(
            bridge.OpenAICompatibleClient,
            _spec("openai", "https://api.example", "gpt-test", "k"),
            handler,
        )
        try:
            with patch.object(bridge, "TRANSLATION_RETRY_BACKOFF_S", 0):
                with self.assertRaises(RuntimeError) as caught:
                    client.translate("hello")
        finally:
            client.close()
        self.assertEqual(len(attempts), bridge.TRANSLATION_NETWORK_ATTEMPTS)
        message = str(caught.exception)
        self.assertIn("网络连接中断", message)
        self.assertIn("已重试 2 次", message)
        # The underlying cause stays visible for troubleshooting.
        self.assertIn("UNEXPECTED_EOF_WHILE_READING", message)

    def test_service_errors_and_silence_are_never_retried(self) -> None:
        """Retrying a rejected request or a quiet model only wastes the queue."""

        attempts: list[str] = []

        def rejecting(_request: httpx.Request) -> httpx.Response:
            attempts.append("http")
            return httpx.Response(401, json={"error": {"message": "invalid api key"}})

        def silent(_request: httpx.Request) -> httpx.Response:
            attempts.append("timeout")
            raise httpx.ReadTimeout("The read operation timed out")

        for handler, expected in ((rejecting, "http"), (silent, "timeout")):
            attempts.clear()
            client = self._client(
                bridge.OpenAICompatibleClient,
                _spec("openai", "https://api.example", "gpt-test", "k"),
                handler,
            )
            try:
                with self.assertRaises(Exception):
                    client.translate("hello")
            finally:
                client.close()
            self.assertEqual(attempts, [expected])

    def test_the_probe_reports_the_first_attempt_instead_of_retrying(self) -> None:
        """The 检测 button is a diagnostic, and Tauri only waits 20 seconds."""

        attempts: list[int] = []

        def handler(_request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred")

        client = bridge.OpenAICompatibleClient(
            _spec("openai", "https://api.example", "gpt-test", "k"),
            total_timeout_s=bridge.PROBE_TIMEOUT_S,
            network_attempts=1,
            transport=httpx.MockTransport(handler),
        )
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.translate("hello")
        finally:
            client.close()
        self.assertEqual(len(attempts), 1)
        self.assertIn("网络连接中断", str(caught.exception))
        self.assertNotIn("已重试", str(caught.exception))


class RedactionTests(unittest.TestCase):
    def test_both_provider_keys_are_removed(self) -> None:
        config = _runtime_config()
        message = bridge.BridgeServer._redact(
            "failed with gemini-secret and dashscope-secret", config
        )
        self.assertNotIn("gemini-secret", message)
        self.assertNotIn("dashscope-secret", message)
        self.assertEqual(message.count("***"), 2)

    def test_sdk_error_message_does_not_depend_on_a_working_string_conversion(self) -> None:
        class BrokenResult:
            message = "authentication failed"

            def __str__(self) -> str:
                raise AttributeError("SDK response is incomplete")

        self.assertEqual(bridge.sdk_result_message(BrokenResult()), "authentication failed")

        class EmptyBrokenResult:
            def __str__(self) -> str:
                raise AttributeError("SDK response is incomplete")

        self.assertEqual(bridge.sdk_result_message(EmptyBrokenResult()), "EmptyBrokenResult")


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


class RealtimeEngineTests(unittest.TestCase):
    """The realtime engine replaces ASR + translation with one model session."""

    def _start_params(self, **overrides: object) -> dict[str, object]:
        config: dict[str, object] = {
            "engine": "realtime",
            "sourceLanguage": "自动检测",
            "targetLanguage": "简体中文",
            "realtime": {
                "protocol": "livetranslate",
                "baseUrl": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
                "model": "qwen3.5-livetranslate-flash-realtime",
                "voice": "Tina",
            },
            "audio": {
                "listen": {
                    "enabled": True,
                    "input": "loopback",
                    "inputDevice": "",
                    "targetLanguage": "简体中文",
                    "outputDevice": "",
                    "playAudio": True,
                },
                "speak": {
                    "enabled": True,
                    "input": "microphone",
                    "inputDevice": "mic-1",
                    "targetLanguage": "English",
                    "outputDevice": "speaker-2",
                    "playAudio": False,
                },
            },
        }
        config.update(overrides)
        return {"config": config, "secrets": {"realtimeApiKey": "dashscope-key"}}

    def test_realtime_engine_needs_only_the_dashscope_key(self) -> None:
        config = bridge.RuntimeConfig.from_start_params(self._start_params())

        self.assertEqual(config.engine, "realtime")
        self.assertIsNotNone(config.realtime)
        self.assertEqual(config.realtime.base_url, "wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
        self.assertEqual(config.realtime.model, "qwen3.5-livetranslate-flash-realtime")
        self.assertEqual(config.realtime.api_key, "dashscope-key")
        self.assertEqual(config.realtime_options.voice, "Tina")
        # The pipeline credentials are irrelevant here and must not leak.
        self.assertEqual(config.translation.api_key, "")
        self.assertEqual(config.recognition.api_key, "")
        self.assertIn("dashscope-key", config.secrets)

    def test_realtime_channels_follow_the_audio_settings(self) -> None:
        config = bridge.RuntimeConfig.from_start_params(self._start_params())
        channels = {spec.channel: spec for spec in config.channels}

        self.assertEqual(channels["listen"].input_kind, "loopback")
        self.assertEqual(channels["listen"].target_language, "简体中文")
        self.assertTrue(channels["listen"].play_audio)
        self.assertEqual(channels["speak"].input_kind, "microphone")
        self.assertEqual(channels["speak"].input_device, "mic-1")
        self.assertEqual(channels["speak"].output_device, "speaker-2")
        self.assertEqual(channels["speak"].target_language, "English")
        self.assertFalse(channels["speak"].play_audio)

    def test_realtime_engine_rejects_a_session_without_channels(self) -> None:
        with self.assertRaises(bridge.ProtocolError):
            bridge.RuntimeConfig.from_start_params(
                self._start_params(
                    audio={
                        "listen": {"enabled": False},
                        "speak": {"enabled": False},
                    }
                )
            )

    def test_realtime_engine_requires_its_own_api_key(self) -> None:
        params = self._start_params()
        params["secrets"] = {}
        with patch.dict("os.environ", {"DASHSCOPE_API_KEY": ""}, clear=False):
            with self.assertRaises(bridge.ProtocolError):
                bridge.RuntimeConfig.from_start_params(params)

    def test_pipeline_engine_is_still_the_default(self) -> None:
        config = bridge.RuntimeConfig.from_start_params(
            {
                "translation": {"protocol": "gemini", "base_url": "https://relay.example"},
                "recognition": {"base_url": "wss://asr.example/ws", "model": "asr"},
                "translation_api_key": "translation-key",
                "recognition_api_key": "recognition-key",
            }
        )

        self.assertEqual(config.engine, "pipeline")
        self.assertIsNone(config.realtime)
        self.assertEqual(config.channels, ())
        self.assertEqual(config.secrets, ("translation-key", "recognition-key"))

    def test_start_selects_the_realtime_session_implementation(self) -> None:
        captured: dict[str, object] = {}

        class CapturingRealtimeSession:
            def __init__(self, _server: object, session_id: str, config: object, **kwargs: object) -> None:
                self.session_id = session_id
                self.config = config
                self.state = "starting"
                self.stop_event = threading.Event()
                captured["kwargs"] = kwargs

            def start(self) -> None:
                captured["started"] = True

            def cancel_pending_translations(self) -> None:
                pass

        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        session_id = "0f1d2c3b-4a59-4e6f-8a9b-0c1d2e3f4a5b"
        params = self._start_params()
        params["session_id"] = session_id

        with patch.object(bridge.livetranslate, "RealtimeSession", CapturingRealtimeSession):
            server.handle_request({"id": "start-realtime", "command": "start", "params": params})

        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertTrue(messages[0]["ok"], messages[0])
        self.assertTrue(captured["started"])
        kwargs = captured["kwargs"]
        self.assertEqual(kwargs["base_url"], "wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
        self.assertEqual(kwargs["api_key"], "dashscope-key")
        self.assertEqual([spec.channel for spec in kwargs["specs"]], ["listen", "speak"])

    def test_devices_command_lists_endpoints(self) -> None:
        stdout = io.StringIO()
        server = bridge.BridgeServer(io.StringIO(), stdout)
        payload = {"speakers": [{"id": "spk", "name": "扬声器", "channels": 2}], "microphones": []}

        with patch.object(bridge.livetranslate, "list_audio_devices", return_value=payload):
            server.handle_request({"id": "d", "command": "devices", "params": {}})

        response = json.loads(stdout.getvalue().splitlines()[0])
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["speakers"][0]["id"], "spk")


class RealtimeCaptionPairingTests(unittest.TestCase):
    """Transcript and translation arrive as two independent server event series."""

    class _Server:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, object]]] = []

        def emit_session_event(self, _session: object, event: str, data: dict[str, object]) -> bool:
            self.events.append((event, data))
            return True

    def _session(self) -> "livetranslate.RealtimeSession":
        config = bridge.RuntimeConfig.from_start_params(
            {
                "engine": "realtime",
                "targetLanguage": "简体中文",
                "realtime": {"model": "qwen3.5-livetranslate-flash-realtime"},
                "secrets": {"realtimeApiKey": "k"},
            }
        )
        self.server = self._Server()
        return livetranslate.RealtimeSession(
            self.server,
            "session-1",
            config,
            base_url=config.realtime.base_url,
            model=config.realtime.model,
            api_key="k",
            options=livetranslate.RealtimeOptions(),
            specs=livetranslate.enabled_channels(config.channels),
            startup_timeout_s=1.0,
        )

    def test_transcript_then_translation_completes_one_caption(self) -> None:
        session = self._session()
        session.on_channel_transcript("listen", "Hello there")
        session.on_channel_translation_done("listen", "resp-1", "你好")

        kinds = [event for event, _ in self.server.events]
        self.assertEqual(kinds, ["source.final", "translation"])
        self.assertEqual(self.server.events[0][1]["source_seq"], self.server.events[1][1]["source_seq"])
        self.assertEqual(self.server.events[1][1]["source_text"], "Hello there")
        self.assertEqual(self.server.events[1][1]["text"], "你好")

    def test_translation_arriving_first_still_merges_into_one_caption(self) -> None:
        session = self._session()
        session.on_channel_translation_done("listen", "resp-1", "你好")
        self.assertEqual(self.server.events, [])

        session.on_channel_transcript("listen", "Hello there")
        kinds = [event for event, _ in self.server.events]
        self.assertEqual(kinds, ["source.final", "translation"])
        self.assertEqual(self.server.events[1][1]["source_text"], "Hello there")
        self.assertEqual(self.server.events[1][1]["text"], "你好")

    def test_channels_keep_independent_sequences(self) -> None:
        session = self._session()
        session.on_channel_transcript("listen", "Hello")
        session.on_channel_transcript("speak", "你好")
        session.on_channel_translation_done("speak", "resp-b", "Hello")
        session.on_channel_translation_done("listen", "resp-a", "你好")

        translations = [data for event, data in self.server.events if event == "translation"]
        self.assertEqual(translations[0]["channel"], "speak")
        self.assertEqual(translations[0]["source_text"], "你好")
        self.assertEqual(translations[1]["channel"], "listen")
        self.assertEqual(translations[1]["source_text"], "Hello")

    def test_language_labels_map_to_model_codes(self) -> None:
        self.assertEqual(livetranslate.language_code("简体中文"), "zh")
        self.assertEqual(livetranslate.language_code("English"), "en")
        self.assertEqual(livetranslate.language_code("en"), "en")
        self.assertEqual(livetranslate.language_code("自动检测"), "auto")
        self.assertEqual(livetranslate.language_code("未配置的语言"), "en")


class RealtimeChannelRetirementTests(unittest.TestCase):
    """A session must be retired exactly when its last channel stops."""

    class _Server:
        def __init__(self) -> None:
            self.retired = 0

        def emit_session_event(self, *_args: object, **_kwargs: object) -> bool:
            return True

        def on_realtime_all_channels_closed(self, _session: object) -> None:
            self.retired += 1

    def _session(self, channels: dict[str, bool]) -> tuple["RealtimeChannelRetirementTests._Server", object]:
        config = bridge.RuntimeConfig.from_start_params(
            {
                "engine": "realtime",
                "realtime": {"model": "qwen3.5-livetranslate-flash-realtime"},
                "audio": channels,
                "secrets": {"realtimeApiKey": "k"},
            }
        )
        server = self._Server()
        session = livetranslate.RealtimeSession(
            server,
            "session-1",
            config,
            base_url=config.realtime.base_url,
            model=config.realtime.model,
            api_key="k",
            options=livetranslate.RealtimeOptions(),
            specs=livetranslate.enabled_channels(config.channels),
            startup_timeout_s=1.0,
        )
        return server, session

    def test_the_calling_channel_does_not_keep_the_session_alive(self) -> None:
        server, session = self._session({"listen": {"enabled": True}, "speak": {"enabled": False}})
        exited = threading.Event()

        class Runner(threading.Thread):
            def run(self) -> None:
                # Mirrors the production call: the session is told a channel is
                # gone from inside that channel's own thread.
                session.on_channel_exit("listen")
                exited.set()

        runner = Runner(daemon=True)
        session.channels[0] = runner  # type: ignore[assignment]
        runner.start()
        self.assertTrue(exited.wait(5))
        runner.join(5)

        self.assertEqual(server.retired, 1)

    def test_a_live_sibling_defers_retirement(self) -> None:
        server, session = self._session(
            {"listen": {"enabled": True}, "speak": {"enabled": True}}
        )
        self.assertEqual(len(session.channels), 2)
        holder = threading.Thread(target=lambda: threading.Event().wait(5), daemon=True)
        holder.start()
        # The second channel is still running, so the session must survive.
        session.channels[1] = holder  # type: ignore[assignment]

        session.on_channel_exit("listen")
        self.assertEqual(server.retired, 0)

        session.channels[1] = session.channels[0]  # type: ignore[assignment]

        class Runner(threading.Thread):
            def run(self) -> None:
                session.on_channel_exit("speak")

        second = Runner(daemon=True)
        session.channels[0] = second  # type: ignore[assignment]
        second.start()
        second.join(5)

        self.assertEqual(server.retired, 1)


class RealtimeChannelEventTests(unittest.TestCase):
    """DashScope server events become bridge events without a live socket."""

    class _Server:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, object]]] = []
            self.errors: list[str] = []
            self.channels: list[tuple[str, str]] = []

        def emit_session_event(self, _session: object, event: str, data: dict[str, object]) -> bool:
            self.events.append((event, data))
            return True

        def emit_session_error(
            self, _session: object, *, scope: str, code: str, message: str, recoverable: bool
        ) -> None:
            self.errors.append(code)

        def on_realtime_channel(
            self,
            _session: object,
            channel: str,
            status: str,
            *,
            device: object = None,
            detail: str = "",
        ) -> None:
            self.channels.append((channel, status))

    class _Player:
        def __init__(self) -> None:
            self.pushes: list[list[float]] = []

        def push(self, samples: object) -> None:
            self.pushes.append(list(samples))

    def _channel(self) -> tuple["RealtimeChannelEventTests._Server", object, object]:
        config = bridge.RuntimeConfig.from_start_params(
            {
                "engine": "realtime",
                "targetLanguage": "简体中文",
                "realtime": {"model": "qwen3.5-livetranslate-flash-realtime"},
                "audio": {"listen": {"enabled": True, "playAudio": True}},
                "secrets": {"realtimeApiKey": "k"},
            }
        )
        server = self._Server()
        session = livetranslate.RealtimeSession(
            server,
            "session-1",
            config,
            base_url=config.realtime.base_url,
            model=config.realtime.model,
            api_key="k",
            options=livetranslate.RealtimeOptions(),
            specs=livetranslate.enabled_channels(config.channels),
            startup_timeout_s=1.0,
        )
        channel = session.channels[0]
        channel._player = self._Player()
        return server, session, channel

    def _dispatch(self, channel: object, event: dict[str, object]) -> None:
        channel._handle_event(event, None)

    def test_a_full_turn_produces_one_paired_caption(self) -> None:
        server, _session, channel = self._channel()

        self._dispatch(channel, {"type": "session.updated"})
        self._dispatch(
            channel,
            {
                "type": "conversation.item.input_audio_transcription.text",
                "text": "Hello",
                "stash": " the",
            },
        )
        self._dispatch(
            channel,
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "Hello there",
            },
        )
        self._dispatch(
            channel,
            {"type": "response.text.text", "response_id": "resp-1", "text": "你好", "stash": "世界"},
        )
        self._dispatch(
            channel,
            {"type": "response.text.done", "response_id": "resp-1", "text": "你好，世界"},
        )

        kinds = [event for event, _ in server.events]
        self.assertEqual(
            kinds, ["source.partial", "source.final", "translation.partial", "translation"]
        )
        # `stash` holds the not-yet-finalised tail, so the live line shows both.
        self.assertEqual(server.events[0][1]["text"], "Hello the")
        self.assertEqual(server.events[0][1]["channel"], "listen")
        self.assertEqual(server.events[1][1]["text"], "Hello there")
        final = server.events[3][1]
        self.assertEqual(final["source_seq"], server.events[1][1]["source_seq"])
        self.assertEqual(final["source_text"], "Hello there")
        self.assertEqual(final["text"], "你好，世界")

    def test_audio_delta_is_decoded_for_playback(self) -> None:
        _server, _session, channel = self._channel()
        samples = np.array([0, 16384, -16384, 32767], dtype="<i2")
        encoded = base64.b64encode(samples.tobytes()).decode("ascii")

        self._dispatch(channel, {"type": "response.audio.delta", "delta": encoded})

        self.assertEqual(len(channel._player.pushes), 1)
        decoded = channel._player.pushes[0]
        self.assertEqual(len(decoded), 4)
        self.assertAlmostEqual(decoded[1], 0.5, places=3)

    def test_session_finish_is_acknowledged(self) -> None:
        _server, _session, channel = self._channel()
        self.assertFalse(channel._finished.is_set())

        self._dispatch(channel, {"type": "session.finished"})

        self.assertTrue(channel._finished.is_set())

    def test_audio_transcript_spelling_is_accepted_too(self) -> None:
        server, _session, channel = self._channel()
        self._dispatch(channel, {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Hi"})
        self._dispatch(
            channel,
            {"type": "response.audio_transcript.done", "response_id": "resp-2", "transcript": "你好"},
        )

        self.assertEqual([event for event, _ in server.events], ["source.final", "translation"])
        self.assertEqual(server.events[1][1]["text"], "你好")


if __name__ == "__main__":
    unittest.main(verbosity=2)
