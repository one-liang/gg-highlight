"""JSON-lines protocol on stdout (see server/lib/transcription/protocol.ts)."""

from __future__ import annotations

import json
import math
import sys
import threading
from typing import Any, Callable, TextIO

Emit = Callable[[dict[str, Any]], None]


def configure_stdio() -> None:
    """UTF-8 everywhere, so Chinese text survives a cp950/cp1252 Windows console."""
    for stream, errors in ((sys.stdout, 'replace'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure is None:
            continue
        try:
            # newline='\n' keeps Windows from writing \r\n (the reader accepts both anyway).
            reconfigure(encoding='utf-8', errors=errors, newline='\n')
        except (ValueError, OSError):
            pass


class EventWriter:
    """Writes one JSON object per line and flushes it immediately. Thread-safe."""

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def __call__(self, event: dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False, allow_nan=False)
        stream = self._stream or sys.stdout
        with self._lock:
            stream.write(line + '\n')
            stream.flush()

    def progress(self, value: float) -> None:
        self({'type': 'progress', 'progress': value})

    def log(self, message: str) -> None:
        self({'type': 'log', 'message': message})

    def done(self, output: str) -> None:
        self({'type': 'done', 'output': output})

    def error(self, message: str) -> None:
        self({'type': 'error', 'message': message})


class ProgressReporter:
    """Monotonic 0-1 progress, emitted only when it grew by at least `min_step`."""

    def __init__(self, emit: Emit, min_step: float = 0.005) -> None:
        self._emit = emit
        self._min_step = min_step
        self._lock = threading.Lock()
        self.last = 0.0
        self.emitted = False

    def report(self, value: float) -> None:
        if not isinstance(value, (int, float)) or math.isnan(value):
            return
        value = round(min(1.0, max(0.0, float(value))), 4)
        with self._lock:
            if value >= 1.0:
                if self.last >= 1.0 and self.emitted:
                    return
            elif value < self.last + self._min_step:
                return
            self.last = value
            self.emitted = True
        self._emit({'type': 'progress', 'progress': value})

    def finish(self) -> None:
        self.report(1.0)
