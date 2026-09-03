from __future__ import annotations

import json
import os
import queue
import threading
import tkinter as tk
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Any

import dashscope
import numpy as np
import soundcard as sc
from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult
from google import genai
from google.genai import types
from scipy.signal import resample_poly


APP_NAME = "SimultaneousTranslator"
CONFIG_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
CONFIG_PATH = CONFIG_DIR / "config.json"


@dataclass
class Config:
    dashscope_api_key: str = ""
    dashscope_ws_url: str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    gemini_api_key: str = ""
    gemini_base_url: str = "https://nikoapi.xyz"
    gemini_model: str = "gemini-3.7-flash-high-c"
    target_language: str = "简体中文"
    source_language: str = "自动检测"

    @classmethod
    def load(cls) -> "Config":
        values: dict[str, Any] = {}
        if CONFIG_PATH.exists():
            try:
                values = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                values = {}
        allowed = cls.__dataclass_fields__.keys()
        config = cls(**{key: value for key, value in values.items() if key in allowed})
        config.dashscope_api_key = os.environ.get("DASHSCOPE_API_KEY", config.dashscope_api_key)
        config.gemini_api_key = os.environ.get("GEMINI_API_KEY", config.gemini_api_key)
        return config

    def save(self) -> None:
        # NOTE: this legacy entry point still stores both API keys as plaintext
        # in CONFIG_PATH.  The Tauri desktop app keeps them in the Windows
        # credential manager instead and should be preferred; only use this
        # window for compatibility troubleshooting.
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")


def nested(data: Any, *keys: str, default: Any = None) -> Any:
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            current = getattr(current, key, default)
        if current is None:
            return default
    return current


class AsrCallback(RecognitionCallback):
    def __init__(self, events: queue.Queue[tuple[str, Any]]) -> None:
        self.events = events

    def on_open(self) -> None:
        self.events.put(("status", "语音识别已连接"))

    def on_close(self) -> None:
        self.events.put(("status", "语音识别连接已关闭"))

    def on_error(self, result: RecognitionResult) -> None:
        message = nested(result, "message", default=str(result))
        self.events.put(("error", f"语音识别错误：{message}"))

    def on_complete(self) -> None:
        self.events.put(("status", "本轮语音识别已完成"))

    def on_event(self, result: RecognitionResult) -> None:
        sentence = nested(result, "output", "sentence")
        if sentence is None:
            sentence = nested(result, "payload", "output", "sentence", default={})
        text = nested(sentence, "text", default="") if sentence else ""
        if not text:
            return
        is_final = bool(
            nested(sentence, "sentence_end", default=False)
            or nested(sentence, "end_time", default=None) is not None
        )
        self.events.put(("final" if is_final else "partial", str(text).strip()))


class TranslationService:
    def __init__(self, config: Config) -> None:
        http_options = types.HttpOptions(base_url=config.gemini_base_url.rstrip("/"))
        self.client = genai.Client(api_key=config.gemini_api_key, http_options=http_options)
        self.model = config.gemini_model
        self.source_language = config.source_language
        self.target_language = config.target_language

    def translate(self, text: str) -> str:
        prompt = (
            "You are a professional simultaneous interpreter. Translate the speech segment below "
            f"from {self.source_language} into {self.target_language}. Preserve meaning, names, numbers, "
            "and tone. Return only the translation, with no notes or quotation marks.\n\n"
            f"Speech: {text}"
        )
        response = self.client.models.generate_content(
            model=self.model,
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.1),
        )
        return (response.text or "").strip()


class AudioWorker(threading.Thread):
    def __init__(self, config: Config, events: queue.Queue[tuple[str, Any]], stop_event: threading.Event) -> None:
        super().__init__(daemon=True)
        self.config = config
        self.events = events
        self.stop_event = stop_event

    def run(self) -> None:
        recognition: Recognition | None = None
        try:
            dashscope.api_key = self.config.dashscope_api_key
            dashscope.base_websocket_api_url = self.config.dashscope_ws_url
            callback = AsrCallback(self.events)
            recognition = Recognition(
                model="qwen-audio-3.0-asr-flash-streaming",
                format="pcm",
                sample_rate=16000,
                callback=callback,
                semantic_punctuation_enabled=False,
            )
            speaker = sc.default_speaker()
            if speaker is None:
                raise RuntimeError("未找到 Windows 默认播放设备")
            raw_speaker_id = getattr(speaker, "id", None)
            if not isinstance(raw_speaker_id, str) or not raw_speaker_id.strip():
                raise RuntimeError("默认播放设备没有可用的稳定 ID")
            speaker_id = raw_speaker_id.strip()
            # speaker.name is neither unique nor stable, and soundcard falls back
            # to substring/fuzzy name matching, which can open a different
            # endpoint.  The WASAPI id maps to exactly one loopback input.
            loopback = sc.get_microphone(id=speaker_id, include_loopback=True)
            loopback_channels = int(
                getattr(loopback, "channels", 0) or getattr(speaker, "channels", 0) or 0
            )
            if loopback_channels < 1:
                raise RuntimeError("默认播放设备没有可用的音频通道")
            self.events.put(("device", speaker.name))
            recognition.start()

            capture_rate = 48000
            frame_count = capture_rate // 10
            # The recorder must use the device's real channel count; a hardcoded
            # 2 fails on mono and surround outputs.
            with loopback.recorder(samplerate=capture_rate, channels=loopback_channels) as recorder:
                while not self.stop_event.is_set():
                    audio = recorder.record(numframes=frame_count)
                    mono = np.mean(audio, axis=1)
                    pcm = resample_poly(mono, 1, 3)
                    pcm = np.clip(pcm, -1.0, 1.0)
                    recognition.send_audio_frame((pcm * 32767).astype("<i2").tobytes())
        except Exception as exc:
            self.events.put(("error", f"音频采集或识别失败：{exc}"))
        finally:
            if recognition is not None:
                try:
                    recognition.stop()
                except Exception:
                    pass
            self.events.put(("stopped", None))


class SettingsDialog(tk.Toplevel):
    FIELDS = (
        ("DashScope Key", "dashscope_api_key", True),
        ("DashScope WebSocket", "dashscope_ws_url", False),
        ("Gemini 中转 Key", "gemini_api_key", True),
        ("Gemini 中转地址", "gemini_base_url", False),
        ("Gemini 模型", "gemini_model", False),
        ("源语言", "source_language", False),
        ("目标语言", "target_language", False),
    )

    def __init__(self, parent: "TranslatorApp", config: Config) -> None:
        super().__init__(parent)
        self.title("同传设置")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self.result: Config | None = None
        self.variables: dict[str, tk.StringVar] = {}

        body = ttk.Frame(self, padding=16)
        body.grid(sticky="nsew")
        for row, (label, field, secret) in enumerate(self.FIELDS):
            ttk.Label(body, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=6)
            variable = tk.StringVar(value=getattr(config, field))
            self.variables[field] = variable
            ttk.Entry(body, textvariable=variable, width=52, show="*" if secret else "").grid(
                row=row, column=1, sticky="ew", pady=6
            )
        buttons = ttk.Frame(body)
        buttons.grid(row=len(self.FIELDS), column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="取消", command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(buttons, text="保存", command=self._save).pack(side="right")
        self.bind("<Escape>", lambda _event: self.destroy())
        self.protocol("WM_DELETE_WINDOW", self.destroy)

    def _save(self) -> None:
        values = {field: variable.get().strip() for field, variable in self.variables.items()}
        if not values["gemini_base_url"].startswith("https://"):
            messagebox.showerror("设置错误", "Gemini 中转地址必须以 https:// 开头", parent=self)
            return
        if not values["dashscope_ws_url"].startswith("wss://"):
            messagebox.showerror("设置错误", "DashScope 地址必须以 wss:// 开头", parent=self)
            return
        self.result = Config(**values)
        self.result.save()
        self.destroy()


class TranslatorApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.config_data = Config.load()
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.stop_event = threading.Event()
        self.audio_worker: AudioWorker | None = None
        self.translator: TranslationService | None = None
        # A single worker preserves the order of sentence-by-sentence translations.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translation")
        self.last_final = ""

        self.title("同传翻译")
        self.geometry("920x520")
        self.minsize(680, 400)
        self.configure(bg="#111418")
        self.attributes("-topmost", True)
        self.protocol("WM_DELETE_WINDOW", self._close)
        self._build_ui()
        self.after(80, self._drain_events)

    def _build_ui(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Toolbar.TFrame", background="#191d22")
        style.configure("Toolbar.TLabel", background="#191d22", foreground="#cbd2da")
        style.configure("Accent.TButton", padding=(18, 9), background="#2e7d5b", foreground="white")

        toolbar = ttk.Frame(self, style="Toolbar.TFrame", padding=(16, 12))
        toolbar.pack(fill="x")
        ttk.Label(toolbar, text="同传翻译", font=("Microsoft YaHei UI", 14, "bold"), style="Toolbar.TLabel").pack(side="left")
        self.status_var = tk.StringVar(value="准备就绪")
        ttk.Label(toolbar, textvariable=self.status_var, style="Toolbar.TLabel").pack(side="left", padx=18)
        ttk.Button(toolbar, text="设置", command=self._settings).pack(side="right")
        self.start_button = ttk.Button(toolbar, text="开始同传", style="Accent.TButton", command=self._toggle)
        self.start_button.pack(side="right", padx=(0, 8))

        content = tk.Frame(self, bg="#111418", padx=28, pady=24)
        content.pack(fill="both", expand=True)
        tk.Label(content, text="原文", bg="#111418", fg="#7f8b99", font=("Microsoft YaHei UI", 10)).pack(anchor="w")
        self.source_var = tk.StringVar(value="等待系统声音…")
        tk.Label(
            content, textvariable=self.source_var, bg="#111418", fg="#eef1f4",
            font=("Microsoft YaHei UI", 18), justify="left", anchor="nw", wraplength=840,
        ).pack(fill="x", pady=(8, 26))
        tk.Frame(content, bg="#2a3038", height=1).pack(fill="x", pady=(0, 24))
        tk.Label(content, text="译文", bg="#111418", fg="#7f8b99", font=("Microsoft YaHei UI", 10)).pack(anchor="w")
        self.translation_var = tk.StringVar(value="Translation will appear here")
        tk.Label(
            content, textvariable=self.translation_var, bg="#111418", fg="#74d6a6",
            font=("Microsoft YaHei UI", 24, "bold"), justify="left", anchor="nw", wraplength=840,
        ).pack(fill="both", expand=True, pady=(8, 0))

    def _toggle(self) -> None:
        if self.audio_worker and self.audio_worker.is_alive():
            self._stop()
        else:
            self._start()

    def _start(self) -> None:
        self.config_data = Config.load()
        if not self.config_data.dashscope_api_key or not self.config_data.gemini_api_key:
            messagebox.showwarning("缺少密钥", "请先在设置中填写两个 API Key，或配置对应环境变量。")
            self._settings()
            return
        try:
            self.translator = TranslationService(self.config_data)
        except Exception as exc:
            messagebox.showerror("初始化失败", str(exc))
            return
        self.stop_event = threading.Event()
        self.last_final = ""
        self.audio_worker = AudioWorker(self.config_data, self.events, self.stop_event)
        self.audio_worker.start()
        self.start_button.configure(text="停止")
        self.status_var.set("正在连接…")

    def _stop(self) -> None:
        self.stop_event.set()
        self.status_var.set("正在停止…")
        self.start_button.configure(state="disabled")

    def _settings(self) -> None:
        if self.audio_worker and self.audio_worker.is_alive():
            messagebox.showinfo("请先停止", "修改设置前请先停止当前同传。")
            return
        dialog = SettingsDialog(self, self.config_data)
        self.wait_window(dialog)
        if dialog.result:
            self.config_data = dialog.result
            self.status_var.set("设置已保存")

    def _submit_translation(self, text: str) -> None:
        if not self.translator:
            return
        # The executor thread runs the callback.  Spawning a waiter thread per
        # sentence instead leaked one thread for every translated segment.
        future = self.executor.submit(self.translator.translate, text)
        future.add_done_callback(self._on_translation_done)

    def _on_translation_done(self, future: "Future[str]") -> None:
        try:
            translation = future.result()
        except CancelledError:
            return
        except Exception as exc:
            self.events.put(("error", f"翻译失败：{exc}"))
        else:
            self.events.put(("translation", translation))

    def _drain_events(self) -> None:
        try:
            while True:
                event, value = self.events.get_nowait()
                if event in ("partial", "final"):
                    self.source_var.set(value)
                    if event == "final" and value and value != self.last_final:
                        self.last_final = value
                        self.status_var.set("正在翻译…")
                        self._submit_translation(value)
                elif event == "translation":
                    self.translation_var.set(value or "（无翻译结果）")
                    self.status_var.set("同传进行中")
                elif event == "status":
                    self.status_var.set(value)
                elif event == "device":
                    self.status_var.set(f"正在监听：{value}")
                elif event == "error":
                    self.status_var.set(value)
                    self.translation_var.set(value)
                elif event == "stopped":
                    self.start_button.configure(text="开始同传", state="normal")
                    if self.status_var.get() == "正在停止…":
                        self.status_var.set("已停止")
        except queue.Empty:
            pass
        self.after(80, self._drain_events)

    def _close(self) -> None:
        self.stop_event.set()
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.destroy()


if __name__ == "__main__":
    TranslatorApp().mainloop()
