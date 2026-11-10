"""Model lookup/download and device selection (CUDA float16, or CPU int8 as fallback)."""

from __future__ import annotations

import os
from typing import Any, Callable

from .errors import UserError, describe

Log = Callable[[str], None]

# Same files faster_whisper.utils.download_model fetches.
MODEL_FILE_PATTERNS = [
    'config.json',
    'preprocessor_config.json',
    'model.bin',
    'tokenizer.json',
    'vocabulary.*',
]

CUDA_FALLBACK_MESSAGE = '找不到可用的 CUDA，改用 CPU 執行，速度會慢很多'


def repo_id_for(model: str) -> str:
    """HF repo id for a model id or a faster-whisper size name ("tiny", "large-v3"...)."""
    if '/' in model:
        return model
    from faster_whisper.utils import _MODELS  # size name -> repo id

    repo = _MODELS.get(model)
    if repo is None:
        raise UserError(f'找不到語音辨識模型：{model}')
    return repo


def model_download_error(model: str, exc: BaseException) -> UserError:
    try:
        from huggingface_hub import errors as hub_errors
    except ImportError:  # pragma: no cover
        hub_errors = None
    not_found = tuple(
        getattr(hub_errors, name)
        for name in ('RepositoryNotFoundError', 'RevisionNotFoundError', 'GatedRepoError', 'EntryNotFoundError')
        if hub_errors is not None and hasattr(hub_errors, name)
    )
    offline = tuple(
        getattr(hub_errors, name)
        for name in ('LocalEntryNotFoundError', 'OfflineModeIsEnabled')
        if hub_errors is not None and hasattr(hub_errors, name)
    )
    if isinstance(exc, UserError):
        return exc
    if offline and isinstance(exc, offline):
        return UserError(f'無法下載語音辨識模型 {model}，請檢查網路連線')
    if not_found and isinstance(exc, not_found):
        return UserError(f'找不到語音辨識模型 {model}（Hugging Face 上沒有這個模型，或需要登入才能下載）')
    if isinstance(exc, ValueError):
        return UserError(f'找不到語音辨識模型：{model}')
    if isinstance(exc, (ConnectionError, TimeoutError)) or 'connect' in type(exc).__name__.lower():
        return UserError(f'無法下載語音辨識模型 {model}，請檢查網路連線（{describe(exc)}）')
    return UserError(f'下載語音辨識模型 {model} 失敗：{describe(exc)}')


def cached_model_path(model: str) -> str | None:
    """Local folder of a model that is fully in the HF cache (or is a folder), else None."""
    if os.path.isdir(model):
        return model
    from faster_whisper.utils import download_model

    try:
        path = download_model(model, local_files_only=True)
    except Exception:
        return None
    # An interrupted download can leave a snapshot folder without the weights.
    return path if os.path.isfile(os.path.join(path, 'model.bin')) else None


def resolve_model(model: str, log: Log) -> str:
    """Local folder of the model, downloading it into the HF cache on first use."""
    path = cached_model_path(model)
    if path is not None:
        return path
    if os.path.isabs(model) or model.startswith('.'):
        raise UserError(f'找不到語音辨識模型資料夾：{model}')
    from faster_whisper.utils import download_model

    repo_id = repo_id_for(model)
    log(f'第一次使用語音辨識模型 {model}，正在下載，請稍候…')
    try:
        return download_model(repo_id)
    except Exception as exc:
        raise model_download_error(model, exc) from exc


def cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def cpu_threads() -> int:
    # ctranslate2 defaults to 4; physical cores (about half the logical ones) is faster on bigger CPUs.
    return max(4, min(16, (os.cpu_count() or 8) // 2))


def warm_up(model: Any) -> None:
    """Runs the encoder once on silence so a missing cuBLAS fails here, not mid-transcription."""
    import numpy as np
    from faster_whisper.audio import pad_or_trim

    features = model.feature_extractor(np.zeros(16000, dtype=np.float32))
    model.encode(pad_or_trim(features))


def _default_factory(path: str, device: str, compute_type: str) -> Any:
    from faster_whisper import WhisperModel

    if device == 'cpu':
        return WhisperModel(path, device='cpu', compute_type=compute_type, cpu_threads=cpu_threads())
    return WhisperModel(path, device=device, compute_type=compute_type)


def load_model(
    model_path: str,
    requested: str,
    log: Log,
    *,
    factory: Callable[[str, str, str], Any] | None = None,
    cuda_count: Callable[[], int] | None = None,
    check_cuda: Callable[[Any], None] | None = None,
) -> tuple[Any, str]:
    """Returns (WhisperModel, device). CUDA failures fall back to CPU with a log event."""
    make = factory or _default_factory
    count = cuda_count or cuda_device_count
    probe = check_cuda or warm_up

    use_cuda = requested == 'cuda' or (requested == 'auto' and count() > 0)
    if use_cuda:
        try:
            model = make(model_path, 'cuda', 'float16')
            probe(model)
            log('使用 NVIDIA 顯示卡（CUDA）執行語音辨識')
            return model, 'cuda'
        except Exception as exc:
            model = None
            log(f'{CUDA_FALLBACK_MESSAGE}（{describe(exc)}）')
    elif requested == 'auto':
        log('沒有偵測到可用的 NVIDIA 顯示卡，使用 CPU 執行語音辨識')
    return make(model_path, 'cpu', 'int8'), 'cpu'
