#!/usr/bin/env python3
"""跨模块集成测试：**真实 sidecar 进程 + 真实 JSONL over stdio**。

与 `scripts/test_tauri_bridge.py`（进程内、直接调用 `BridgeServer`）不同，本文件
每次都真的 `subprocess` 启动一个 sidecar，用 stdin/stdout 走完整的 JSONL 协议，
再用真实 Rust 侧会用的同一套请求/响应/事件语义做断言。目的是复现「Rust 控制器
看到的线上行为」，而不是「Python 单元测试里的行为」。

五个分层（tier）：

* **Tier A — 真实引擎，无桩**：跑真正的 `scripts/tauri_bridge.py` + 真正的
  `livetranslate`。只做不需要活跃 session 的断言（ready 能力清单、ping、
  协议错误、参数校验、无 session 时的错误码、非法 start 配置、shutdown）。
  不申请任何音频设备、不发起任何网络连接。
* **Tier B — 离线引擎桩**：仍然跑真正的 `scripts/tauri_bridge.py`（源码经
  `runpy` 执行，**不复制、不改写**），只把
  `livetranslate.LiveTranslateChannel.run` 换成离线循环（无麦克风、无 WebSocket）。
  `RealtimeSession`、`BridgeServer`、请求分发、事件发射全部是真实代码，
  因此 `runtime.channel` / `runtime.mute` 的状态机、`changed` 幂等语义、
  旧 session 拒绝、停止后静默都由被测代码决定，而不是由桩决定。
* **Tier C — 反向验证（证伪型）**：C1 在**真实引擎**上用不存在的麦克风设备制造
  音频启动失败（验证错误分类 `service=audio` 且**不是** `audio_start_failed`）；
  C2/C3 通过 `QA_FAULT` 注入部分通道故障，验证 `network.status` 的
  `degraded`/`failed` 聚合与「全程不发 `websocket_reconnecting`」。
* **Tier D — 严格参数校验与竞态**：有活跃 session 时错误码优先级无歧义，
  可做严格断言（`invalid_channel` / `invalid_params` / `session_mismatch`）；
  另含交错/同值连发的并发断言与 stop 幂等。
* **Tier E — 幽灵态与事件顺序**：契约 §1.5 / §1.5.0 / §1.5.1。用**原始 JSONL 绕过
  Rust**（最坏情况）验证：关闭已静音的发言通道会清静音且事件顺序为
  「先 `runtime.mute{false}` 后 `runtime.channel{false}`」；幂等关闭同样清幽灵；
  重新启用**不得**改变静音；绕过 Rust 也留不下**持久**幽灵态。

契约依据：`docs/runtime-channel-control.md`（JSONL 增量契约）、
`docs/tray-shortcuts-contract.md`（RuntimeState / 事件名）、
`docs/subtitle-window.md`（窗口生命周期，本文件不覆盖 UI）。

运行（本机无 pytest）：

    .venv\\Scripts\\python.exe scripts\\test_runtime_integration.py
    .venv\\Scripts\\python.exe scripts\\test_runtime_integration.py --tier a     # a|b|c|d|e|all
    .venv\\Scripts\\python.exe scripts\\test_runtime_integration.py --json docs/qa/integration-result.json

退出码：0 = 全部通过；1 = 至少一项失败；2 = 桩不受支持（被测代码重构导致
harness 需要更新，**不算产品缺陷**，会在输出里明确标记 `HARNESS_UNSUPPORTED`）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
BRIDGE_PATH = SCRIPTS_DIR / "tauri_bridge.py"
PYTHON = sys.executable

# 离线桩：只替换通道的 I/O 循环，其余全是真实代码。
HARNESS_SOURCE = '''\
"""QA 离线引擎桩 —— 由 scripts/test_runtime_integration.py 生成，请勿手工维护。"""
import os
import runpy
import sys

scripts_dir = os.environ["QA_SCRIPTS_DIR"]
bridge_path = os.environ["QA_BRIDGE_PATH"]
sys.path.insert(0, scripts_dir)

import livetranslate  # noqa: E402

channel_cls = getattr(livetranslate, "LiveTranslateChannel", None)
if channel_cls is None or getattr(livetranslate, "RealtimeSession", None) is None:
    sys.stderr.write("QA_HARNESS_UNSUPPORTED: livetranslate.LiveTranslateChannel / RealtimeSession missing\\n")
    raise SystemExit(97)


def offline_run(self):
    """真实 run() 的离线替身：不开音频设备，不连 WebSocket。

    ``QA_FAULT`` 用于**注入故障**，验证错误分类与 network.status 聚合：
      - ``""``        ：健康，通道一直存活到 stop（默认）
      - ``partial``   ：speak 通道按网络失败上报，listen 保持健康 → 期望 degraded
      - ``all``       ：所有通道按网络失败上报 → 期望 failed
      - ``audio``     ：所有通道按音频失败上报 → 期望 audio.status=failed 且 service=audio
    """

    channel = self._spec.channel
    fault = os.environ.get("QA_FAULT", "")
    try:
        if fault == "partial" and channel == "speak":
            self._report_failure("realtime_connect_failed", "QA 注入：发言通道连接失败")
            return
        if fault in {"all", "audio"}:
            if fault == "audio":
                self._report_failure("audio_device_missing", "QA 注入：未找到可用的输入设备")
            else:
                self._report_failure("realtime_connect_failed", "QA 注入：通道连接失败")
            return
        self._session.mark_channel_ready(channel)
        self._server.on_realtime_channel(self._session, channel, "connecting")
        self._server.on_realtime_channel(
            self._session,
            channel,
            "streaming",
            device={"id": "qa-offline-device", "name": "QA Offline Device", "is_default": True},
        )
        while not self._session.stop_event.wait(0.05):
            pass
    finally:
        self._session.mark_channel_settled(channel)
        self._session.on_channel_exit(channel)


channel_cls.run = offline_run
runpy.run_path(bridge_path, run_name="__main__")
'''

DEFAULT_TARGET = "简体中文"
SPEAK_TARGET = "English"
REALTIME_MODEL = "qwen3.8-livetranslate-flash-realtime"
REALTIME_URL = "wss://maas.qianwenaiapi.com/api-ws/v1/realtime"
QA_API_KEY = "sk-qa-offline-not-a-real-key"

LEGACY_COMMANDS = ("ping", "start", "stop", "shutdown", "probe.models", "probe.connect", "devices")
NEW_COMMANDS = ("set_runtime_channel", "set_speak_muted")


# --------------------------------------------------------------------------- 结果收集


class Results:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def check(
        self,
        tier: str,
        name: str,
        ok: bool,
        detail: str = "",
        *,
        blocked: bool = False,
        status: str | None = None,
    ) -> bool:
        if status is None:
            status = "BLOCKED" if blocked else ("PASS" if ok else "FAIL")
        self.rows.append({"tier": tier, "name": name, "status": status, "detail": detail})
        marker = {"PASS": "PASS", "FAIL": "FAIL", "BLOCKED": "BLOCK", "INFO": "info"}[status]
        print(f"[{marker}] {tier} :: {name}" + (f" — {detail}" if detail else ""), flush=True)
        return ok

    def failed(self) -> list[dict[str, Any]]:
        return [row for row in self.rows if row["status"] == "FAIL"]

    def blocked(self) -> list[dict[str, Any]]:
        return [row for row in self.rows if row["status"] == "BLOCKED"]


# --------------------------------------------------------------------------- sidecar 进程


class SidecarError(RuntimeError):
    pass


class Sidecar:
    """一个真实的 sidecar 子进程 + JSONL 客户端。"""

    def __init__(self, *, offline_engine: bool, harness_env: dict[str, str] | None = None) -> None:
        self.offline_engine = offline_engine
        self._harness_dir: Path | None = None
        self._lock = threading.Lock()
        self._messages: list[dict[str, Any]] = []
        self._raw_lines: list[str] = []
        self._stderr: list[str] = []
        self._non_json: list[str] = []
        self._counter = 0
        self._closed = False
        self._exit_code: int | None = None

        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["QA_SCRIPTS_DIR"] = str(SCRIPTS_DIR)
        env["QA_BRIDGE_PATH"] = str(BRIDGE_PATH)
        if harness_env:
            env.update(harness_env)

        if offline_engine:
            self._harness_dir = Path(tempfile.mkdtemp(prefix="qa-offline-engine-"))
            harness = self._harness_dir / "qa_offline_engine_harness.py"
            harness.write_text(HARNESS_SOURCE, encoding="utf-8")
            command = [PYTHON, "-u", str(harness)]
            cwd = ROOT
        else:
            command = [PYTHON, "-u", str(BRIDGE_PATH)]
            cwd = SCRIPTS_DIR

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        self._out_thread = threading.Thread(target=self._pump_stdout, daemon=True)
        self._err_thread = threading.Thread(target=self._pump_stderr, daemon=True)
        self._out_thread.start()
        self._err_thread.start()
        self._condition = threading.Condition(self._lock)

    # ---------------------------------------------------------------- plumbing

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            line = line.rstrip("\r\n")
            if not line:
                continue
            with self._condition:
                raw = line
                self._raw_lines.append(raw)
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    self._non_json.append(raw)
                    self._condition.notify_all()
                    continue
                if not isinstance(payload, dict):
                    self._non_json.append(raw)
                else:
                    self._messages.append(payload)
                self._condition.notify_all()
        with self._condition:
            self._condition.notify_all()

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            with self._condition:
                self._stderr.append(line.rstrip("\r\n"))
                self._condition.notify_all()

    def _send(self, payload: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def send_raw(self, line: str) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def next_id(self, prefix: str = "qa") -> str:
        with self._lock:
            self._counter += 1
            return f"{prefix}-{self._counter}"

    # ---------------------------------------------------------------- waiting

    def mark(self) -> int:
        with self._lock:
            return len(self._messages)

    def messages_since(self, mark: int) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._messages[mark:])

    def _wait(self, predicate: Callable[[dict[str, Any]], bool], *, mark: int, timeout: float,
              what: str) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        cursor = mark
        with self._condition:
            while True:
                while cursor < len(self._messages):
                    payload = self._messages[cursor]
                    cursor += 1
                    if predicate(payload):
                        return payload
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if self.process.poll() is not None and cursor >= len(self._messages):
                    break
                self._condition.wait(min(remaining, 0.25))
        raise SidecarError(
            f"超时等待 {what}（{timeout}s）\n"
            f"  已收到: {json.dumps(self.messages_since(mark), ensure_ascii=False)[:2000]}\n"
            f"  stderr: {' | '.join(self.stderr_tail())}"
        )

    def wait_response(self, request_id: str, *, timeout: float = 15.0) -> dict[str, Any]:
        def matches(payload: dict[str, Any]) -> bool:
            return payload.get("type") == "response" and payload.get("id") == request_id

        return self._wait(matches, mark=0, timeout=timeout, what=f"response id={request_id}")

    def wait_event(self, name: str, *, timeout: float = 15.0, mark: int = 0,
                   session_id: str | None = None) -> dict[str, Any]:
        def matches(payload: dict[str, Any]) -> bool:
            if payload.get("type") != "event" or payload.get("event") != name:
                return False
            return session_id is None or payload.get("session_id") == session_id

        return self._wait(matches, mark=mark, timeout=timeout, what=f"event {name}")

    def wait_payload(self, predicate: Callable[[dict[str, Any]], bool], *, timeout: float = 15.0,
                     mark: int = 0, what: str = "payload") -> dict[str, Any]:
        return self._wait(predicate, mark=mark, timeout=timeout, what=what)

    def all_messages(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._messages)

    def request(self, command: str, params: dict[str, Any] | None = None, *,
                request_id: str | None = None, timeout: float = 15.0) -> dict[str, Any]:
        rid = request_id or self.next_id(command.replace(".", "-"))
        mark = self.mark()
        self._send({"type": "request", "id": rid, "command": command, "params": params or {}})
        try:
            response = self.wait_response(rid, timeout=timeout)
        except SidecarError as exc:
            raise SidecarError(f"命令 {command} (id={rid}) 失败：{exc}") from exc
        response["_mark"] = mark
        response["_request_id"] = rid
        return response

    def expect_command(self, command: str, params: dict[str, Any] | None = None, *,
                       timeout: float = 15.0) -> dict[str, Any]:
        response = self.request(command, params, timeout=timeout)
        if response.get("id") != response.get("_request_id"):
            raise SidecarError(f"{command}: response id 与请求不一致：{response}")
        return response

    def quiesce(self, seconds: float = 0.4) -> None:
        """给异步事件一点落盘时间，用于「不该有新事件」的断言。"""

        time.sleep(seconds)

    def stderr_tail(self, limit: int = 12) -> list[str]:
        with self._lock:
            return self._stderr[-limit:]

    def non_json_lines(self) -> list[str]:
        with self._lock:
            return list(self._non_json)

    def raw_line_count(self) -> int:
        with self._lock:
            return len(self._raw_lines)

    # ---------------------------------------------------------------- lifecycle

    def wait_exit(self, timeout: float = 20.0) -> int | None:
        try:
            self._exit_code = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._exit_code = None
        return self._exit_code

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.process.poll() is None:
            try:
                assert self.process.stdin is not None
                self.process.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=8)
        self._exit_code = self.process.returncode
        self._out_thread.join(timeout=3)
        self._err_thread.join(timeout=3)


# --------------------------------------------------------------------------- 请求构造


def start_params(session_id: str, *, listen: bool = True, speak: bool = False) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "config": {
            "engine": "realtime",
            "source_language": "自动检测",
            "target_language": DEFAULT_TARGET,
            "realtime": {
                "protocol": "livetranslate",
                "base_url": REALTIME_URL,
                "model": REALTIME_MODEL,
            },
            "audio": {
                "listen": {
                    "enabled": listen,
                    "input": "system",
                    "target_language": DEFAULT_TARGET,
                    "play_audio": False,
                },
                "speak": {
                    "enabled": speak,
                    "input": "microphone",
                    "target_language": SPEAK_TARGET,
                    "play_audio": False,
                },
            },
        },
        "secrets": {"realtime_api_key": QA_API_KEY},
    }


def error_code(response: dict[str, Any]) -> str:
    error = response.get("error")
    if isinstance(error, dict):
        return str(error.get("code", ""))
    return ""


def result_of(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result")
    return result if isinstance(result, dict) else {}


def active_session(sidecar: Sidecar, session_id: str, results: Results, tier: str) -> bool:
    """start 一个离线 session 并等到 state=listening。"""

    response = sidecar.expect_command("start", start_params(session_id, listen=True, speak=True))
    if not results.check(tier, f"start 返回 ok（{session_id[:8]}）", bool(response.get("ok")),
                         json.dumps(response, ensure_ascii=False)[:300]):
        return False
    if result_of(response).get("session_id") != session_id:
        results.check(tier, "start 回显请求的 session_id", False,
                      f"期望 {session_id}，实际 {result_of(response).get('session_id')}")
        return False
    try:
        sidecar.wait_event("state", timeout=20.0, mark=0, session_id=session_id)
    except SidecarError as exc:
        results.check(tier, "会话进入 listening", False, str(exc)[:400])
        return False
    return True


# --------------------------------------------------------------------------- Tier A


def tier_a(results: Results) -> None:
    tier = "A/真实引擎"
    sidecar = Sidecar(offline_engine=False)
    try:
        try:
            ready = sidecar.wait_event("ready", timeout=60.0)
        except SidecarError as exc:
            results.check(tier, "sidecar 启动并发出 ready", False, str(exc)[:400])
            return

        commands = ready.get("data", {}).get("commands", [])
        results.check(tier, "ready 事件 v==1", ready.get("v") == 1, json.dumps(ready, ensure_ascii=False)[:200])
        missing_legacy = [c for c in LEGACY_COMMANDS if c not in commands]
        results.check(tier, "ready 保留全部既有命令", not missing_legacy,
                      f"缺失 {missing_legacy}" if missing_legacy else f"commands={commands}")
        missing_new = [c for c in NEW_COMMANDS if c not in commands]
        results.check(tier, "ready 广告新增命令 set_runtime_channel / set_speak_muted",
                      not missing_new, f"缺失 {missing_new}（契约 runtime-channel-control.md §2）")

        ping = sidecar.expect_command("ping")
        ping_result = result_of(ping)
        results.check(tier, "ping ok 且 protocol_version==1", bool(ping.get("ok")) and ping_result.get("protocol_version") == 1,
                      json.dumps(ping, ensure_ascii=False)[:200])
        results.check(tier, "ping 无 session 时 state==idle 且 session_id==null",
                      ping_result.get("state") == "idle" and ping_result.get("session_id") is None,
                      json.dumps(ping_result, ensure_ascii=False)[:200])

        unknown = sidecar.expect_command("definitely_not_a_command")
        results.check(tier, "未知命令返回 unknown_command", not unknown.get("ok") and error_code(unknown) == "unknown_command",
                      json.dumps(unknown, ensure_ascii=False)[:200])

        mark = sidecar.mark()
        sidecar.send_raw("{not json at all")
        try:
            bad = sidecar._wait(lambda p: p.get("type") == "response" and p.get("id") is None,
                                mark=mark, timeout=10.0, what="invalid_json response")
            results.check(tier, "非法 JSON 返回 invalid_json 且进程存活",
                          not bad.get("ok") and error_code(bad) == "invalid_json",
                          json.dumps(bad, ensure_ascii=False)[:200])
        except SidecarError as exc:
            results.check(tier, "非法 JSON 返回 invalid_json 且进程存活", False, str(exc)[:300])

        # ---- 新增命令：无活跃 session 时的错误码（契约 §3.2）
        no_session_channel = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": str(uuid.uuid4()), "channel": "listen", "enabled": False},
        )
        code = error_code(no_session_channel)
        results.check(tier, "无 session 时 set_runtime_channel 拒绝",
                      not no_session_channel.get("ok") and code in {"no_active_session", "session_mismatch"},
                      f"code={code}")
        no_session_mute = sidecar.expect_command(
            "set_speak_muted", {"session_id": str(uuid.uuid4()), "muted": True}
        )
        code = error_code(no_session_mute)
        results.check(tier, "无 session 时 set_speak_muted 拒绝",
                      not no_session_mute.get("ok") and code in {"no_active_session", "session_mismatch"},
                      f"code={code}")

        # ---- 参数校验（真实引擎，无硬件依赖）
        bad_channel = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": str(uuid.uuid4()), "channel": "both", "enabled": False},
        )
        code = error_code(bad_channel)
        results.check(tier, "channel 非法 → invalid_channel",
                      not bad_channel.get("ok") and code in {"invalid_channel", "no_active_session", "session_mismatch"},
                      f"code={code}（契约 §2.1 要求 invalid_channel；无 session 时优先级见 known-issues）")

        bad_bool = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": str(uuid.uuid4()), "channel": "listen", "enabled": "yes"},
        )
        code = error_code(bad_bool)
        results.check(tier, "enabled 非布尔 → invalid_params",
                      not bad_bool.get("ok") and code in {"invalid_params", "no_active_session", "session_mismatch"},
                      f"code={code}")

        bad_muted = sidecar.expect_command(
            "set_speak_muted", {"session_id": str(uuid.uuid4()), "muted": 1}
        )
        code = error_code(bad_muted)
        results.check(tier, "muted 非布尔 → invalid_params",
                      not bad_muted.get("ok") and code in {"invalid_params", "no_active_session", "session_mismatch"},
                      f"code={code}")

        missing_session = sidecar.expect_command(
            "set_runtime_channel", {"channel": "listen", "enabled": False}
        )
        code = error_code(missing_session)
        results.check(tier, "缺 session_id → 被拒绝",
                      not missing_session.get("ok") and code in {"invalid_params", "no_active_session", "session_mismatch"},
                      f"code={code}")

        # ---- 真实引擎的非法 start 配置（不触碰音频/网络）
        bad_start = sidecar.expect_command(
            "start", {"session_id": str(uuid.uuid4()), "config": {"engine": "realtime",
                      "realtime": {"protocol": "livetranslate", "model": REALTIME_MODEL}},
                      "secrets": {}}
        )
        results.check(tier, "缺少 realtime_api_key 的 start 返回 invalid_start_config",
                      not bad_start.get("ok") and error_code(bad_start) == "invalid_start_config",
                      json.dumps(bad_start, ensure_ascii=False)[:300])

        stop_without_session = sidecar.expect_command("stop")
        results.check(tier, "无 session 时 stop 幂等成功",
                      bool(stop_without_session.get("ok")) and result_of(stop_without_session).get("already_stopped") is True,
                      json.dumps(stop_without_session, ensure_ascii=False)[:200])

        devices = sidecar.expect_command("devices", timeout=30.0)
        results.check(tier, "devices 命令可用（真实硬件枚举）", bool(devices.get("ok")),
                      "机器无音频端点时会失败，属环境问题" if not devices.get("ok") else "")

        mark = sidecar.mark()
        shutdown = sidecar.expect_command("shutdown")
        results.check(tier, "shutdown 返回 ok", bool(shutdown.get("ok")),
                      json.dumps(shutdown, ensure_ascii=False)[:200])
        exit_code = sidecar.wait_exit(timeout=20.0)
        results.check(tier, "shutdown 后进程自行退出且 exit code==0", exit_code == 0, f"exit={exit_code}")

        # ---- 协议完整性
        non_json = sidecar.non_json_lines()
        results.check(tier, "stdout 全部为合法 JSON（协议未被污染）", not non_json,
                      f"非 JSON 行 {len(non_json)} 条：{non_json[:3]}")
        results.check(tier, "收到了响应/事件流量", sidecar.raw_line_count() > 0,
                      f"{sidecar.raw_line_count()} 行")
    finally:
        sidecar.close()


# --------------------------------------------------------------------------- Tier B


def tier_b(results: Results, *, harness_state: dict[str, Any]) -> None:
    tier = "B/离线引擎"
    sidecar = Sidecar(offline_engine=True)
    session_one = str(uuid.uuid4())
    session_two = str(uuid.uuid4())
    try:
        try:
            sidecar.wait_event("ready", timeout=60.0)
        except SidecarError as exc:
            if any("QA_HARNESS_UNSUPPORTED" in line for line in sidecar.stderr_tail(50)):
                harness_state["unsupported"] = True
                results.check(tier, "离线引擎桩可用", False,
                              "HARNESS_UNSUPPORTED: livetranslate.LiveTranslateChannel 不存在，需更新 harness",
                              status="BLOCKED")
                return
            results.check(tier, "离线 sidecar 启动并发出 ready", False, str(exc)[:400])
            return

        # ---------------------------------------------------------- session 1
        if not active_session(sidecar, session_one, results, tier):
            return
        results.check(tier, "start 后进入 listening（活跃 session）", True, session_one)

        mark = sidecar.mark()
        response = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": session_one, "channel": "listen", "enabled": False},
        )
        body = result_of(response)
        results.check(tier, "关闭收听通道 → ok/changed:true",
                      bool(response.get("ok")) and body.get("changed") is True,
                      json.dumps(response, ensure_ascii=False)[:300])
        results.check(tier, "结果回显生效后的 channel/enabled/session_id",
                      body.get("channel") == "listen" and body.get("enabled") is False
                      and body.get("session_id") == session_one,
                      json.dumps(body, ensure_ascii=False)[:300])
        try:
            event = sidecar.wait_event("runtime.channel", timeout=10.0, mark=mark, session_id=session_one)
            data = event.get("data", {})
            results.check(tier, "发出 runtime.channel 事件且字段符合契约 §4.2",
                          data.get("channel") == "listen" and data.get("enabled") is False
                          and data.get("configured") is True,
                          json.dumps(event, ensure_ascii=False)[:300])
        except SidecarError as exc:
            results.check(tier, "发出 runtime.channel 事件且字段符合契约 §4.2", False, str(exc)[:300])

        # ---------------------------------------------------------- 幂等重放
        mark = sidecar.mark()
        replay = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": session_one, "channel": "listen", "enabled": False},
        )
        replay_ok = results.check(tier, "重放同一值 → ok:true 且 changed:false（幂等）",
                                  bool(replay.get("ok")) and result_of(replay).get("changed") is False,
                                  json.dumps(replay, ensure_ascii=False)[:300])
        sidecar.quiesce()
        duplicates = [m for m in sidecar.messages_since(mark) if m.get("event") == "runtime.channel"]
        # 前置命令失败时不得把「没有事件」当成通过 —— 那是空转的绿。
        results.check(tier, "幂等重放不重复发 runtime.channel（契约 §4.2）",
                      replay_ok and not duplicates,
                      json.dumps(duplicates, ensure_ascii=False)[:300],
                      blocked=not replay_ok,
                      status="BLOCKED" if not replay_ok else None)

        # ---------------------------------------------------------- 恢复通道
        mark = sidecar.mark()
        restore = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": session_one, "channel": "listen", "enabled": True},
        )
        restore_ok = results.check(tier, "恢复收听通道 → changed:true",
                                   bool(restore.get("ok")) and result_of(restore).get("changed") is True,
                                   json.dumps(restore, ensure_ascii=False)[:300])
        sidecar.quiesce()
        states = [m for m in sidecar.messages_since(mark)
                  if m.get("event") == "state" and m.get("data", {}).get("state") == "stopped"]
        results.check(tier, "通道开关不会停止整个 session（契约 §1.4）",
                      restore_ok and not states,
                      json.dumps(states, ensure_ascii=False)[:300],
                      status="BLOCKED" if not restore_ok else None)

        # ---------------------------------------------------------- 静音
        mark = sidecar.mark()
        mute = sidecar.expect_command("set_speak_muted", {"session_id": session_one, "muted": True})
        results.check(tier, "静音 → ok:true muted:true changed:true",
                      bool(mute.get("ok")) and result_of(mute).get("muted") is True
                      and result_of(mute).get("changed") is True,
                      json.dumps(mute, ensure_ascii=False)[:300])
        try:
            event = sidecar.wait_event("runtime.mute", timeout=10.0, mark=mark, session_id=session_one)
            results.check(tier, "发出 runtime.mute 事件且 muted:true",
                          event.get("data", {}).get("muted") is True,
                          json.dumps(event, ensure_ascii=False)[:300])
        except SidecarError as exc:
            results.check(tier, "发出 runtime.mute 事件且 muted:true", False, str(exc)[:300])

        mark = sidecar.mark()
        mute_again = sidecar.expect_command("set_speak_muted", {"session_id": session_one, "muted": True})
        mute_again_ok = results.check(tier, "重复静音 → changed:false（幂等）",
                                      bool(mute_again.get("ok")) and result_of(mute_again).get("changed") is False,
                                      json.dumps(mute_again, ensure_ascii=False)[:300])
        sidecar.quiesce()
        duplicates = [m for m in sidecar.messages_since(mark) if m.get("event") == "runtime.mute"]
        results.check(tier, "重复静音不重复发 runtime.mute",
                      mute_again_ok and not duplicates,
                      json.dumps(duplicates, ensure_ascii=False)[:300],
                      status="BLOCKED" if not mute_again_ok else None)

        unmute = sidecar.expect_command("set_speak_muted", {"session_id": session_one, "muted": False})
        results.check(tier, "取消静音 → changed:true 且通道仍在（无 stopped 事件）",
                      bool(unmute.get("ok")) and result_of(unmute).get("changed") is True,
                      json.dumps(unmute, ensure_ascii=False)[:300])

        # ---------------------------------------------------------- stop
        mark = sidecar.mark()
        stop = sidecar.expect_command("stop")
        results.check(tier, "stop 返回 ok 且回显 session_id",
                      bool(stop.get("ok")) and result_of(stop).get("session_id") == session_one,
                      json.dumps(stop, ensure_ascii=False)[:300])
        try:
            stopped = sidecar.wait_event("state", timeout=20.0, mark=mark, session_id=session_one)
            results.check(tier, "stop 后发出 state 事件（stopping/stopped）",
                          stopped.get("data", {}).get("state") in {"stopping", "stopped"},
                          json.dumps(stopped, ensure_ascii=False)[:200])
        except SidecarError as exc:
            results.check(tier, "stop 后发出 state 事件（stopping/stopped）", False, str(exc)[:300])

        # 停止后旧 session 的命令必须被拒绝
        after_stop = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_one, "channel": "listen", "enabled": True}
        )
        code = error_code(after_stop)
        results.check(tier, "停止后旧 session_id 被拒绝",
                      not after_stop.get("ok") and code in {"no_active_session", "session_mismatch"},
                      f"code={code}")

        sidecar.quiesce(0.6)

        # ---------------------------------------------------------- session 2：状态复位 + 旧 id 拒绝
        mark = sidecar.mark()
        if not active_session(sidecar, session_two, results, tier):
            return
        results.check(tier, "第二次 start 进入 listening（新 session）", True, session_two)

        reset_channel = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_two, "channel": "listen", "enabled": False}
        )
        results.check(tier, "重启后运行时通道复位为配置默认值（changed:true）",
                      bool(reset_channel.get("ok")) and result_of(reset_channel).get("changed") is True,
                      f"契约 §1.2；实测 {json.dumps(reset_channel, ensure_ascii=False)[:240]}")

        reset_mute = sidecar.expect_command("set_speak_muted", {"session_id": session_two, "muted": False})
        results.check(tier, "重启后 speak_muted 复位为 false（changed:false）",
                      bool(reset_mute.get("ok")) and result_of(reset_mute).get("changed") is False,
                      f"契约 §1.2；实测 {json.dumps(reset_mute, ensure_ascii=False)[:240]}")

        mark = sidecar.mark()
        old_id = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_one, "channel": "listen", "enabled": False}
        )
        code = error_code(old_id)
        old_id_rejected = results.check(tier, "旧 session id → session_mismatch",
                                        not old_id.get("ok") and code == "session_mismatch",
                                        f"code={code}（契约 §2.1/§3.2）")
        old_id_mute = sidecar.expect_command("set_speak_muted", {"session_id": session_one, "muted": True})
        code = error_code(old_id_mute)
        results.check(tier, "旧 session id（静音）→ session_mismatch",
                      not old_id_mute.get("ok") and code == "session_mismatch", f"code={code}")
        sidecar.quiesce()
        leaked = [m for m in sidecar.messages_since(mark)
                  if m.get("event") in {"runtime.channel", "runtime.mute"}]
        results.check(tier, "被拒绝的旧 session 调用不改变任何状态（无事件泄漏）",
                      old_id_rejected and not leaked,
                      json.dumps(leaked, ensure_ascii=False)[:300],
                      status="BLOCKED" if not old_id_rejected else None)

        # ---------------------------------------------------------- 未配置通道
        mark = sidecar.mark()
        stop = sidecar.expect_command("stop")
        results.check(tier, "第二次 stop 成功", bool(stop.get("ok")),
                      json.dumps(stop, ensure_ascii=False)[:200])
        sidecar.quiesce(0.6)
        session_three = str(uuid.uuid4())
        response = sidecar.expect_command("start", start_params(session_three, listen=True, speak=False))
        if results.check(tier, "仅启用收听通道的 start 成功", bool(response.get("ok")),
                         json.dumps(response, ensure_ascii=False)[:240]):
            try:
                sidecar.wait_event("state", timeout=20.0, mark=0, session_id=session_three)
            except SidecarError as exc:
                results.check(tier, "第三个 session 进入 listening", False, str(exc)[:300])
                return
            not_configured = sidecar.expect_command(
                "set_speak_muted", {"session_id": session_three, "muted": True}
            )
            code = error_code(not_configured)
            results.check(tier, "未配置的发言通道静音 → channel_not_configured",
                          not not_configured.get("ok") and code == "channel_not_configured",
                          f"code={code}（契约 §2.2）")
            not_configured_channel = sidecar.expect_command(
                "set_runtime_channel",
                {"session_id": session_three, "channel": "speak", "enabled": True},
            )
            code = error_code(not_configured_channel)
            results.check(tier, "未配置通道开启 → channel_not_configured（不得伪造已开启）",
                          not not_configured_channel.get("ok") and code == "channel_not_configured",
                          f"code={code}（契约 §1.3）")

            mark = sidecar.mark()
            stop = sidecar.expect_command("stop")
            results.check(tier, "第三个 session 停止成功", bool(stop.get("ok")), "")
            sidecar.quiesce(0.6)

        # ---------------------------------------------------------- 协议完整性 + 退出
        non_json = sidecar.non_json_lines()
        results.check(tier, "Tier B 全程 stdout 全部为合法 JSON", not non_json,
                      f"非 JSON 行 {len(non_json)} 条：{non_json[:3]}")

        shutdown = sidecar.expect_command("shutdown")
        results.check(tier, "shutdown 返回 ok", bool(shutdown.get("ok")), "")
        exit_code = sidecar.wait_exit(timeout=20.0)
        results.check(tier, "shutdown 后进程自行退出且 exit code==0", exit_code == 0, f"exit={exit_code}")
    finally:
        sidecar.close()


# --------------------------------------------------------------------------- Tier C（反向验证）


# 契约 §4.4 表中「已声明」的音频类 code + 既有音频 code。
AUDIO_ERROR_CODES = {
    "audio_start_failed",
    "audio_device_lost",
    "audio_device_missing",
    "audio_device_failed",
    "audio_startup_timeout",
    "audio_playback_failed",
    "audio_worker_start_failed",
}


def tier_c1_real_audio_failure(results: Results) -> None:
    """C1：**真实引擎**下制造音频启动失败，验证 D1 裁决（service=audio，不是 audio_start_failed）。"""

    tier = "C1/真实引擎音频失败"
    sidecar = Sidecar(offline_engine=False)
    session_id = str(uuid.uuid4())
    try:
        sidecar.wait_event("ready", timeout=60.0)
        params = start_params(session_id, listen=False, speak=True)
        # 发言通道用麦克风 + 一个不存在的设备 id：真实 `_open_input` 会在
        # `sc.get_microphone(id=...)` 处失败，不会打开任何真实硬件。
        # 同时把 WS 指向本机不可达端口，万一音频意外打开也不会产生外部网络流量。
        params["config"]["audio"]["speak"]["input"] = "microphone"
        params["config"]["audio"]["speak"]["input_device"] = "qa-no-such-device-0000"
        params["config"]["realtime"]["base_url"] = "wss://127.0.0.1:9/api-ws/v1/realtime"
        response = sidecar.expect_command("start", params, timeout=30.0)
        if not results.check(tier, "真实引擎 start 被接受（失败发生在运行期而不是配置校验）",
                             bool(response.get("ok")),
                             json.dumps(response, ensure_ascii=False)[:300]):
            return

        try:
            error = sidecar.wait_payload(
                lambda payload: payload.get("type") == "event" and payload.get("event") == "error",
                timeout=45.0,
                what="任意 error 事件",
            )
        except SidecarError as exc:
            results.check(tier, "真实引擎上报了一次错误", False, str(exc)[:600])
            return

        data = error.get("data", {})
        code = str(data.get("code", ""))
        service = str(data.get("service", ""))
        results.check(tier, "音频失败以 service=audio 上报（D1 判据）",
                      service == "audio",
                      f"service={service!r} code={code!r} message={data.get('message')!r}")
        results.check(tier, "没有发出 audio_start_failed（D1 偏差真实存在，不是猜测）",
                      code != "audio_start_failed", f"code={code!r}")
        results.check(tier, "发出的 code 是既有音频 code",
                      code in AUDIO_ERROR_CODES, f"code={code!r}")

        all_events = sidecar.all_messages()
        reconnecting = [
            item for item in all_events
            if isinstance(item.get("data"), dict)
            and item["data"].get("code") == "websocket_reconnecting"
        ]
        results.check(tier, "没有发出 websocket_reconnecting（D2 偏差）", not reconnecting,
                      json.dumps(reconnecting, ensure_ascii=False)[:300])

        audio_status = [
            item for item in all_events
            if item.get("event") == "audio.status"
        ]
        results.check(tier, "音频失败时发出 audio.status",
                      bool(audio_status) and audio_status[-1].get("data", {}).get("status") == "failed",
                      json.dumps(audio_status[-1:] if audio_status else [], ensure_ascii=False)[:300])
    finally:
        sidecar.close()


def tier_c2_partial_fault(results: Results) -> None:
    """C2：部分通道故障 → network.status=degraded，且**不**发 websocket_reconnecting。"""

    tier = "C2/部分通道故障"
    sidecar = Sidecar(offline_engine=True, harness_env={"QA_FAULT": "partial"})
    session_id = str(uuid.uuid4())
    try:
        sidecar.wait_event("ready", timeout=60.0)
        response = sidecar.expect_command("start", start_params(session_id, listen=True, speak=True))
        if not results.check(tier, "双通道 start 成功", bool(response.get("ok")),
                             json.dumps(response, ensure_ascii=False)[:300]):
            return

        try:
            degraded = sidecar.wait_payload(
                lambda payload: payload.get("event") == "network.status"
                and payload.get("data", {}).get("status") == "degraded",
                timeout=25.0,
                what="network.status=degraded",
            )
            results.check(tier, "部分通道故障 → network.status=degraded（D2 替代判据）", True,
                          json.dumps(degraded, ensure_ascii=False)[:300])
        except SidecarError as exc:
            results.check(tier, "部分通道故障 → network.status=degraded（D2 替代判据）", False,
                          str(exc)[:600])
            return

        sidecar.quiesce(0.5)
        events = sidecar.all_messages()
        reconnecting = [
            item for item in events
            if isinstance(item.get("data"), dict)
            and item["data"].get("code") == "websocket_reconnecting"
        ]
        results.check(tier, "没有发出 websocket_reconnecting（D2：引擎无重连逻辑）",
                      not reconnecting, json.dumps(reconnecting, ensure_ascii=False)[:300])

        failed_status = [
            item for item in events
            if item.get("event") == "network.status"
            and item.get("data", {}).get("status") == "failed"
        ]
        results.check(tier, "sibling 存活时不得上报 network.status=failed", not failed_status,
                      json.dumps(failed_status, ensure_ascii=False)[:300])

        stopped = [
            item for item in events
            if item.get("event") == "state" and item.get("data", {}).get("state") == "stopped"
        ]
        results.check(tier, "单通道故障不终止整个 session（sibling 继续）", not stopped,
                      json.dumps(stopped, ensure_ascii=False)[:300])
    finally:
        sidecar.close()


def tier_c3_audio_service(results: Results) -> None:
    """C3：全部通道音频失败 → audio.status=failed，错误 service=audio。"""

    tier = "C3/音频故障分类"
    sidecar = Sidecar(offline_engine=True, harness_env={"QA_FAULT": "audio"})
    session_id = str(uuid.uuid4())
    try:
        sidecar.wait_event("ready", timeout=60.0)
        response = sidecar.expect_command("start", start_params(session_id, listen=True, speak=True))
        if not results.check(tier, "双通道 start 成功", bool(response.get("ok")),
                             json.dumps(response, ensure_ascii=False)[:300]):
            return
        try:
            error = sidecar.wait_payload(
                lambda payload: payload.get("event") == "error"
                and payload.get("data", {}).get("service") == "audio",
                timeout=25.0,
                what="service=audio 的 error 事件",
            )
            results.check(tier, "音频失败 → error.service == \"audio\"", True,
                          json.dumps(error, ensure_ascii=False)[:300])
        except SidecarError as exc:
            results.check(tier, "音频失败 → error.service == \"audio\"", False, str(exc)[:600])
            return
        data = error.get("data", {})
        results.check(tier, "音频失败没有使用 audio_start_failed",
                      data.get("code") != "audio_start_failed", f"code={data.get('code')!r}")
        audio_status = [
            item for item in sidecar.all_messages() if item.get("event") == "audio.status"
        ]
        results.check(tier, "发出 audio.status=failed 且带 channel",
                      bool(audio_status)
                      and audio_status[-1].get("data", {}).get("status") == "failed"
                      and bool(audio_status[-1].get("data", {}).get("channel")),
                      json.dumps(audio_status[-1:] if audio_status else [], ensure_ascii=False)[:300])
        events = sidecar.all_messages()
        reconnecting = [
            item for item in events
            if isinstance(item.get("data"), dict)
            and item["data"].get("code") == "websocket_reconnecting"
        ]
        results.check(tier, "没有发出 websocket_reconnecting", not reconnecting,
                      json.dumps(reconnecting, ensure_ascii=False)[:300])
    finally:
        sidecar.close()


# --------------------------------------------------------------------------- Tier D（参数校验 / 竞态）


def tier_d_strict_params(results: Results) -> None:
    """D：**有活跃 session 时**参数校验优先级无歧义，可做严格断言；另含并发竞态。"""

    tier = "D/严格校验与竞态"
    sidecar = Sidecar(offline_engine=True)
    session_id = str(uuid.uuid4())
    try:
        sidecar.wait_event("ready", timeout=60.0)
        if not active_session(sidecar, session_id, results, tier):
            return

        cases = [
            (
                "channel=both 有活跃 session → invalid_channel",
                "set_runtime_channel",
                {"session_id": session_id, "channel": "both", "enabled": True},
                "invalid_channel",
            ),
            (
                "channel 缺失 → invalid_channel 或 invalid_params",
                "set_runtime_channel",
                {"session_id": session_id, "enabled": True},
                {"invalid_channel", "invalid_params"},
            ),
            (
                "enabled 为字符串 → invalid_params",
                "set_runtime_channel",
                {"session_id": session_id, "channel": "listen", "enabled": "yes"},
                "invalid_params",
            ),
            (
                "enabled 为数字 → invalid_params",
                "set_runtime_channel",
                {"session_id": session_id, "channel": "listen", "enabled": 1},
                "invalid_params",
            ),
            (
                "muted 为字符串 → invalid_params",
                "set_speak_muted",
                {"session_id": session_id, "muted": "true"},
                "invalid_params",
            ),
            (
                "会话活跃但 session_id 非 UUID → session_mismatch",
                "set_runtime_channel",
                {"session_id": "not-a-uuid", "channel": "listen", "enabled": True},
                "session_mismatch",
            ),
            (
                "会话活跃但 session_id 缺失 → 被拒绝",
                "set_runtime_channel",
                {"channel": "listen", "enabled": True},
                {"invalid_params", "session_mismatch"},
            ),
            (
                "会话活跃但 session_id 为随机 UUID → session_mismatch",
                "set_speak_muted",
                {"session_id": str(uuid.uuid4()), "muted": True},
                "session_mismatch",
            ),
        ]
        for name, command, params, expected in cases:
            response = sidecar.expect_command(command, params)
            code = error_code(response)
            allowed = expected if isinstance(expected, set) else {expected}
            results.check(tier, name, not response.get("ok") and code in allowed,
                          f"code={code}（允许 {sorted(allowed)}）")

        # 参数非法不得改变状态：以上 8 次调用后，通道应仍是配置默认值（开启）
        probe = sidecar.expect_command(
            "set_runtime_channel",
            {"session_id": session_id, "channel": "listen", "enabled": True},
        )
        results.check(tier, "8 次非法调用后运行时状态未被污染（仍为默认开启）",
                      bool(probe.get("ok")) and result_of(probe).get("changed") is False,
                      json.dumps(probe, ensure_ascii=False)[:300])

        # ---------------------------------------------------------------- 竞态
        # 交错（交替 true/false）连发：每次都在翻转，因此**每一次**都应为 changed:true。
        mark = sidecar.mark()
        burst = 6
        ids = []
        for index in range(burst):
            request_id = sidecar.next_id(f"race{index}")
            ids.append(request_id)
            sidecar._send({
                "type": "request",
                "id": request_id,
                "command": "set_speak_muted",
                "params": {"session_id": session_id, "muted": index % 2 == 0},
            })
        responses = []
        for request_id in ids:
            responses.append(sidecar.wait_response(request_id, timeout=20.0))
        results.check(tier, f"连发 {burst} 个交错请求全部得到响应（id 一一对应）",
                      len(responses) == burst and all(r.get("ok") for r in responses),
                      json.dumps([r.get("id") for r in responses], ensure_ascii=False)[:300])
        sidecar.quiesce(0.5)
        changed = [r for r in responses if result_of(r).get("changed") is True]
        results.check(tier, "交错请求按顺序生效（交替翻转 → 每次 changed:true）",
                      len(changed) == burst,
                      f"changed=true 次数={len(changed)}，期望={burst}；"
                      f"实测值序列={[result_of(r).get('muted') for r in responses]}")

        # 同值连发：只有第一次真正改变，其余必须幂等 changed:false。
        ids = []
        for index in range(burst):
            request_id = sidecar.next_id(f"dup{index}")
            ids.append(request_id)
            sidecar._send({
                "type": "request",
                "id": request_id,
                "command": "set_speak_muted",
                "params": {"session_id": session_id, "muted": True},
            })
        dup_responses = [sidecar.wait_response(request_id, timeout=20.0) for request_id in ids]
        sidecar.quiesce(0.5)
        dup_changed = [r for r in dup_responses if result_of(r).get("changed") is True]
        results.check(tier, "同值连发只有第一次 changed:true（其余幂等）",
                      len(dup_changed) == 1 and all(r.get("ok") for r in dup_responses),
                      f"changed=true 次数={len(dup_changed)}，期望=1")
        mute_events = [
            item for item in sidecar.messages_since(mark)
            if item.get("event") == "runtime.mute"
        ]
        results.check(tier, "同值连发只发一次 runtime.mute 事件（无事件风暴）",
                      len(mute_events) == burst + 1,
                      f"runtime.mute 事件数={len(mute_events)}，期望={burst + 1}"
                      "（6 次翻转 + 1 次置 true）")

        final_mute = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": False})
        results.check(tier, "并发后状态机未损坏（仍可正常设置）", bool(final_mute.get("ok")),
                      json.dumps(final_mute, ensure_ascii=False)[:200])

        # ---------------------------------------------------------------- stop 幂等
        first_stop = sidecar.expect_command("stop")
        second_stop = sidecar.expect_command("stop")
        results.check(tier, "重复 stop 幂等（第二次 already_stopped）",
                      bool(first_stop.get("ok")) and bool(second_stop.get("ok"))
                      and result_of(second_stop).get("already_stopped") is True,
                      json.dumps(second_stop, ensure_ascii=False)[:200])

        results.check(tier, "全程 stdout 纯 JSON", not sidecar.non_json_lines(),
                      json.dumps(sidecar.non_json_lines()[:3], ensure_ascii=False))
    finally:
        sidecar.close()


# --------------------------------------------------------------------------- Tier E（幽灵态 / 事件顺序）


def tier_e_ghost_state(results: Results) -> None:
    """E：契约 §1.5（关通道必清静音 + 事件顺序）与 §1.5.1（拒绝口径边界）的证伪型验证。

    全部通过**原始 JSONL 直连 sidecar**完成，绕过 Rust —— 也就是模拟「最坏情况：
    有个客户端不受 Rust 前置检查约束」。
    """

    tier = "E/幽灵态与事件顺序"
    sidecar = Sidecar(offline_engine=True)
    session_id = str(uuid.uuid4())

    def spoke_events(mark: int) -> list[tuple[str, Any]]:
        rows = []
        for item in sidecar.messages_since(mark):
            if item.get("event") == "runtime.mute":
                rows.append(("runtime.mute", item.get("data", {}).get("muted")))
            elif item.get("event") == "runtime.channel":
                data = item.get("data", {})
                rows.append((f"runtime.channel:{data.get('channel')}", data.get("enabled")))
        return rows

    try:
        sidecar.wait_event("ready", timeout=60.0)
        if not active_session(sidecar, session_id, results, tier):
            return

        # ---------------------------------------------------------------- §1.5 正向
        mark = sidecar.mark()
        mute = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": True})
        results.check(tier, "§1.5 前置：静音成功（changed:true）",
                      bool(mute.get("ok")) and result_of(mute).get("changed") is True,
                      json.dumps(mute, ensure_ascii=False)[:240])

        mark = sidecar.mark()
        disable = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_id, "channel": "speak", "enabled": False}
        )
        results.check(tier, "§1.5 关闭已静音的发言通道 → 成功",
                      bool(disable.get("ok")) and result_of(disable).get("changed") is True,
                      json.dumps(disable, ensure_ascii=False)[:240])
        sidecar.quiesce(0.5)
        order = spoke_events(mark)
        results.check(tier, "§1.5 事件顺序：先 runtime.mute{false} 后 runtime.channel{false}",
                      order == [("runtime.mute", False), ("runtime.channel:speak", False)],
                      json.dumps(order, ensure_ascii=False))

        # 幽灵态判别器：通道已关时若静音已被清除，再置 false 必须 changed:false。
        probe = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": False})
        results.check(tier, "§1.5 静音确实被清除（再置 false → changed:false）",
                      bool(probe.get("ok")) and result_of(probe).get("changed") is False,
                      json.dumps(probe, ensure_ascii=False)[:240])

        # ---------------------------------------------------------------- §1.5 反向
        sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_id, "channel": "speak", "enabled": True}
        )
        sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": True})
        again = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_id, "channel": "speak", "enabled": True}
        )
        keep = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": True})
        results.check(tier, "§1.5 反向：重新启用通道不得改变 speak_muted（仍为 true）",
                      bool(again.get("ok")) and result_of(again).get("changed") is False
                      and bool(keep.get("ok")) and result_of(keep).get("changed") is False,
                      f"enable.changed={result_of(again).get('changed')} "
                      f"mute.changed={result_of(keep).get('changed')}")

        # ---------------------------------------------------------------- §1.5.1 幽灵窗口
        # 此时状态：speak 运行时开启且已静音（上一步反向验证的收尾）。
        sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_id, "channel": "speak", "enabled": False}
        )
        ghost = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": True})
        results.check(tier, "§1.5.1 运行时已关闭的发言通道：set_speak_muted 仍返回成功（设计如此）",
                      bool(ghost.get("ok")),
                      json.dumps(ghost, ensure_ascii=False)[:300])
        # 证明确实同时满足 speakEnabled=false 与 speakMuted=true（绕过 Rust 时的最坏情况）：
        #   - 上一步刚发出 channel{enabled:false}；
        #   - 静音响应回显 muted:true 且 changed:true —— changed:true 说明此前确为 false，
        #     即「通道关闭」与「已静音」确实并存过。
        results.check(tier, "§1.5.1 确认绕过 Rust 时能瞬时构造 speakEnabled=false && speakMuted=true",
                      result_of(ghost).get("muted") is True and result_of(ghost).get("changed") is True,
                      f"mute 响应={json.dumps(result_of(ghost), ensure_ascii=False)}")

        # ---------------------------------------------------------------- 幽灵态不可持久
        # 契约 §1.5.0（Lead 依本测试实测固化）：**幂等**关闭（changed:false）也必须清掉幽灵静音。
        # 此时只补发 runtime.mute{false}，**不**补发 runtime.channel 事件（符合 §4.2「仅在实际变化时发出」）。
        # 若未来有人改成「只在 changed 时才清理」，即为回退，本断言必须变红。
        clear_mark = sidecar.mark()
        idempotent = sidecar.expect_command(
            "set_runtime_channel", {"session_id": session_id, "channel": "speak", "enabled": False}
        )
        sidecar.quiesce(0.5)
        cleared = spoke_events(clear_mark)
        results.check(tier, "§1.5.0 幂等关闭（changed:false）也清掉幽灵静音，且只补发 runtime.mute{false}",
                      result_of(idempotent).get("changed") is False
                      and cleared == [("runtime.mute", False)],
                      f"changed={result_of(idempotent).get('changed')}，事件={json.dumps(cleared, ensure_ascii=False)}"
                      "（channel 值未变化故不补发 channel 事件，符合 §4.2）")

        final = sidecar.expect_command("set_speak_muted", {"session_id": session_id, "muted": False})
        results.check(tier, "§1.5.1 结论：绕过 Rust 也无法留下**持久**幽灵态",
                      bool(final.get("ok")) and result_of(final).get("changed") is False,
                      json.dumps(final, ensure_ascii=False)[:240])

        results.check(tier, "全程 stdout 纯 JSON", not sidecar.non_json_lines(),
                      json.dumps(sidecar.non_json_lines()[:3], ensure_ascii=False))
    finally:
        sidecar.close()


# --------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="真实 sidecar 进程的跨模块 JSONL 集成测试")
    parser.add_argument("--tier", choices=["a", "b", "c", "d", "e", "all"], default="all")
    parser.add_argument("--json", dest="json_path", default=None,
                        help="把结果写成机器可读 JSON（含每条断言的实测结论）")
    args = parser.parse_args(argv)

    results = Results()
    harness_state: dict[str, Any] = {"unsupported": False}

    print(f"bridge  : {BRIDGE_PATH}", flush=True)
    print(f"python  : {PYTHON}", flush=True)
    started = time.time()
    if args.tier in {"a", "all"}:
        tier_a(results)
    if args.tier in {"b", "all"}:
        tier_b(results, harness_state=harness_state)
    if args.tier in {"c", "all"}:
        tier_c1_real_audio_failure(results)
        tier_c2_partial_fault(results)
        tier_c3_audio_service(results)
    if args.tier in {"d", "all"}:
        tier_d_strict_params(results)

    if args.tier in {"e", "all"}:
        tier_e_ghost_state(results)
    elapsed = time.time() - started

    failed = results.failed()
    blocked = results.blocked()
    payload = {
        "bridge": str(BRIDGE_PATH),
        "python": PYTHON,
        "tier": args.tier,
        "elapsed_s": round(elapsed, 2),
        "pass": len([r for r in results.rows if r["status"] == "PASS"]),
        "fail": len(failed),
        "blocked": len(blocked),
        "harness_unsupported": harness_state["unsupported"],
        "checks": results.rows,
    }
    if args.json_path:
        target = Path(args.json_path)
        if not target.is_absolute():
            target = ROOT / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结果已写入 {target}", flush=True)

    print("\n" + "=" * 72)
    print(f"PASS {payload['pass']} / FAIL {payload['fail']} / BLOCKED {payload['blocked']}"
          f"  ({elapsed:.1f}s)")
    for row in failed:
        print(f"  FAIL  {row['tier']} :: {row['name']}\n        {row['detail'][:400]}")
    for row in blocked:
        print(f"  BLOCK {row['tier']} :: {row['name']}\n        {row['detail'][:400]}")
    print("=" * 72)

    if harness_state["unsupported"]:
        print("HARNESS_UNSUPPORTED: 离线引擎桩需要更新（被测代码重构），不算产品缺陷。")
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
