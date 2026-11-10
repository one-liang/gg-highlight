from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TRANSCRIBER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = TRANSCRIBER_DIR.parent
FIXTURES_DIR = REPO_ROOT / 'tests' / '.tmp' / 'fixtures'
TINY_MODEL = 'Systran/faster-whisper-tiny'


def run_cli(*args: str, env: dict[str, str] | None = None, timeout: float = 600) -> tuple[int, list[dict], str, str]:
    """Runs `python -m gg_transcriber ...`; returns (exit code, parsed events, raw stdout, stderr)."""
    proc = subprocess.run(
        [sys.executable, '-m', 'gg_transcriber', *args],
        capture_output=True,
        timeout=timeout,
        env={**os.environ, **(env or {})},
    )
    stdout = proc.stdout.decode('utf-8')
    stderr = proc.stderr.decode('utf-8', errors='replace')
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    return proc.returncode, events, stdout, stderr


@pytest.fixture
def speech_en() -> Path:
    path = FIXTURES_DIR / 'speech-en.wav'
    if not path.is_file():
        pytest.skip(f'fixture missing: {path} (run node tests/fixtures/make-fixtures.mjs)')
    return path
