"""`transcribe` command: audio file -> RawTranscript JSON (see protocol.ts)."""

from __future__ import annotations

import json
import math
import os
import tempfile
from typing import Any, Iterable

from .errors import UserError, describe
from .events import EventWriter, ProgressReporter
from .models import load_model, resolve_model

BATCH_SIZE = 8


def _num(value: Any, digits: int = 3) -> float:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return 0.0
    return round(x, digits) if math.isfinite(x) else 0.0


def segment_to_dict(segment: Any) -> dict[str, Any]:
    words = [
        {
            'start': _num(w.start),
            'end': _num(w.end),
            'word': w.word,
            'probability': _num(w.probability, 4),
        }
        for w in (segment.words or [])
    ]
    return {
        'start': _num(segment.start),
        'end': _num(segment.end),
        'text': (segment.text or '').strip(),
        'words': words,
    }


def transcribe_options(language: str, initial_prompt: str | None) -> dict[str, Any]:
    return {
        'language': language,
        'word_timestamps': True,
        'vad_filter': True,
        'vad_parameters': {'min_silence_duration_ms': 500},
        'beam_size': 5,
        'condition_on_previous_text': False,
        'initial_prompt': initial_prompt or None,
    }


def collect_segments(segments: Iterable[Any], duration: float, progress: ProgressReporter) -> list[dict[str, Any]]:
    """Drains faster-whisper's lazy segment generator, reporting segment.end / duration."""
    out: list[dict[str, Any]] = []
    for segment in segments:
        out.append(segment_to_dict(segment))
        if duration > 0:
            progress.report(segment.end / duration)
    progress.finish()
    return out


def write_json_atomic(path: str, data: Any) -> str:
    """Writes UTF-8 JSON next to `path` and renames it into place. Returns the absolute path."""
    target = os.path.abspath(path)
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f'.{os.path.basename(target)}.', suffix='.tmp', dir=folder)
    try:
        os.chmod(tmp, 0o644)  # mkstemp creates 0600
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return target


def start_transcription(whisper: Any, batched: bool, audio: str, options: dict[str, Any]) -> tuple[Iterable[Any], Any]:
    """Decodes the audio and runs VAD now; the returned segments are produced lazily.

    The GPU path uses BatchedInferencePipeline (several 30 s windows per encoder/decoder call); on
    CPU batching does not pay off, so the plain sequential model is used.
    """
    if batched:
        from faster_whisper import BatchedInferencePipeline

        return BatchedInferencePipeline(model=whisper).transcribe(audio, batch_size=BATCH_SIZE, **options)
    return whisper.transcribe(audio, **options)


def readable_failure(exc: BaseException, audio: str) -> UserError | None:
    import av.error

    if isinstance(exc, av.error.FFmpegError):
        return UserError(f'無法讀取音訊檔：{audio}（{describe(exc)}）')
    if isinstance(exc, (RuntimeError, MemoryError)) and 'out of memory' in str(exc).lower():
        return UserError(f'記憶體不足（顯示卡或系統記憶體），請關閉其他佔用顯示卡的程式後重試（{describe(exc)}）')
    return None


def run_transcribe(
    *,
    audio: str,
    language: str,
    model: str,
    device: str,
    out: str,
    emit: EventWriter,
    initial_prompt: str | None = None,
) -> str:
    if not os.path.isfile(audio):
        raise UserError(f'找不到音訊檔：{audio}')

    from .cuda_dlls import setup_windows_cuda_dlls

    setup_windows_cuda_dlls()

    model_path = resolve_model(model, emit.log)
    whisper, used_device = load_model(model_path, device, emit.log)
    options = transcribe_options(language, initial_prompt)
    progress = ProgressReporter(emit)
    try:
        segments, info = start_transcription(whisper, used_device == 'cuda', audio, options)
        raw = {
            'language': info.language,
            'durationSec': _num(info.duration),
            'model': model,
            'device': used_device,
            'segments': collect_segments(segments, float(info.duration or 0), progress),
        }
    except Exception as exc:
        friendly = readable_failure(exc, audio)
        if friendly is None:
            raise
        raise friendly from exc
    written = write_json_atomic(out, raw)
    emit.done(written)
    return written
