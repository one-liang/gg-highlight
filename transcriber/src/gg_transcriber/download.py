"""`download` command: fetch a model into the Hugging Face cache with progress events."""

from __future__ import annotations

import fnmatch
import io
import os
import threading
from typing import Any

from tqdm.std import tqdm as std_tqdm

from .errors import UserError
from .events import EventWriter, ProgressReporter
from .models import MODEL_FILE_PATTERNS, cached_model_path, model_download_error, repo_id_for


class _Discard(io.TextIOBase):
    def write(self, s: str) -> int:
        return len(s)


def expected_bytes(repo_id: str) -> int:
    """Total size of the files we download, from the Hub metadata; 0 when unknown."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo_id, files_metadata=True)
        return sum(
            (s.size or 0)
            for s in info.siblings or []
            if any(fnmatch.fnmatch(s.rfilename, p) for p in MODEL_FILE_PATTERNS)
        )
    except Exception:
        return 0


def progress_tqdm_class(progress: ProgressReporter, total_bytes: int) -> type:
    """A silent tqdm class for huggingface_hub that turns its byte counters into progress events.

    huggingface_hub 1.x/2.x aggregates every file into byte-unit bars built from `tqdm_class`; older
    versions only count files. Bytes win when present. Capped below 1 until the download returns.
    """
    bars: list[std_tqdm] = []
    lock = threading.Lock()

    def report() -> None:
        with lock:
            byte_bars = [b for b in bars if b.unit == 'B']
            pool = byte_bars or bars
            done = max((b.n or 0 for b in pool), default=0)
            total = max([b.total or 0 for b in pool] + ([total_bytes] if byte_bars else []))
        if total > 0:
            progress.report(min(0.99, done / total))

    class ProgressTqdm(std_tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs.pop('name', None)
            kwargs['file'] = _Discard()
            kwargs['disable'] = False
            super().__init__(*args, **kwargs)
            with lock:
                bars.append(self)

        def update(self, n: float | None = 1) -> bool | None:
            result = super().update(n)
            report()
            return result

    return ProgressTqdm


def run_download(*, model: str, emit: EventWriter) -> str:
    progress = ProgressReporter(emit)
    if os.path.isdir(model):
        emit.log(f'模型已在本機資料夾：{model}')
        progress.finish()
        emit.done(model)
        return model

    repo_id = repo_id_for(model)
    cached = cached_model_path(model)
    if cached is not None:
        emit.log(f'語音辨識模型 {model} 已經下載過，檢查是否有更新…')
    else:
        emit.log(f'正在下載語音辨識模型 {model}…')

    import huggingface_hub

    try:
        path = huggingface_hub.snapshot_download(
            repo_id,
            allow_patterns=MODEL_FILE_PATTERNS,
            tqdm_class=progress_tqdm_class(progress, expected_bytes(repo_id)),
        )
    except Exception as exc:
        if cached is not None:
            # Offline with a complete cache is fine.
            path = cached
        else:
            raise model_download_error(model, exc) from exc
    if not os.path.isfile(os.path.join(path, 'model.bin')):
        raise UserError(f'語音辨識模型 {model} 下載不完整，請重新下載')
    progress.finish()
    emit.log(f'語音辨識模型 {model} 已就緒')
    emit.done(path)
    return path
