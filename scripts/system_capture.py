"""Windows process-loopback reader. Excludes all audio rendered by this sidecar."""
from __future__ import annotations

import contextlib
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading

import numpy as np
from scipy.signal import resample_poly


def capture_executable() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "translator-audio-capture.exe"
    return Path(__file__).resolve().parent.parent / "desktop/src-tauri/target/debug/translator-audio-capture.exe"


class SystemCapture:
    def __init__(self, startup_timeout: float = 8.0):
        self._timeout = startup_timeout
        self._process = None
        self._reader = None
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._frames = queue.Queue(maxsize=3)
        self._error = None
        self._close_lock = threading.Lock()

    def __enter__(self):
        if sys.platform != "win32" or sys.getwindowsversion().build < 20348:
            raise RuntimeError("隔离采集需要 Windows 11 或 Windows build 20348 及以上版本")
        executable = capture_executable()
        if not executable.is_file():
            raise RuntimeError("缺少系统声音采集组件，请重新构建或安装桌面版")
        self._process = subprocess.Popen(
            [str(executable), str(os.getpid())], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self._reader = threading.Thread(target=self._read, name="system-audio-reader", daemon=True)
        self._reader.start()
        if not self._ready.wait(self._timeout):
            self.close()
            raise RuntimeError("隔离采集启动超时，请检查 Windows 音频服务")
        if self._error:
            self.close()
            raise RuntimeError(self._error)
        return self

    def _read(self):
        try:
            if self._process.stdout.read(4) != b"STC1":
                detail = self._process.stderr.read(2048).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"隔离采集无法启动：{detail}")
            self._ready.set()
            while not self._closed.is_set():
                data = self._process.stdout.read(4800 * 2 * 4)
                if len(data) != 4800 * 2 * 4:
                    raise RuntimeError("系统声音采集已中断，请重新开始同传")
                mono = np.frombuffer(data, dtype="<f4").reshape(-1, 2).mean(axis=1)
                frame = resample_poly(mono, 1, 3).astype("float32").reshape(-1, 1)
                if self._frames.full():
                    with contextlib.suppress(queue.Empty):
                        self._frames.get_nowait()
                self._frames.put_nowait(frame)
        except Exception as error:
            if not self._closed.is_set():
                self._error = str(error)
        finally:
            self._ready.set()

    def record(self, numframes):
        if numframes != 1600:
            raise ValueError("System capture uses 100 ms frames at 16 kHz")
        while not self._closed.is_set():
            if self._error:
                raise RuntimeError(self._error)
            try:
                return self._frames.get(timeout=0.2)
            except queue.Empty:
                continue
        return np.zeros((numframes, 1), dtype="float32")

    def close(self):
        with self._close_lock:
            self._close()

    def _close(self):
        self._closed.set()
        if self._process:
            with contextlib.suppress(OSError):
                self._process.stdin.close()
            if self._process.poll() is None:
                self._process.kill()
            self._process.wait(timeout=3)
            if self._reader:
                self._reader.join(timeout=3)
            self._process.stdout.close()
            self._process.stderr.close()
            self._process = None

    def __exit__(self, *_):
        self.close()
