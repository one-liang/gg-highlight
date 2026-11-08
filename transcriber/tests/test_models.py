import pytest

from gg_transcriber.errors import UserError
from gg_transcriber.models import (
    CUDA_FALLBACK_MESSAGE,
    load_model,
    model_download_error,
    repo_id_for,
    resolve_model,
)


class FakeFactory:
    def __init__(self, fail_cuda=False):
        self.calls = []
        self.fail_cuda = fail_cuda

    def __call__(self, path, device, compute_type):
        self.calls.append((device, compute_type))
        if device == 'cuda' and self.fail_cuda:
            raise RuntimeError('CUDA failed with error no CUDA-capable device is detected')
        return f'model@{device}'


def ok_probe(model):
    pass


def test_auto_uses_cuda_float16_when_a_device_exists():
    logs, factory = [], FakeFactory()
    model, device = load_model('m', 'auto', logs.append, factory=factory, cuda_count=lambda: 1, check_cuda=ok_probe)
    assert (model, device) == ('model@cuda', 'cuda')
    assert factory.calls == [('cuda', 'float16')]


def test_auto_uses_cpu_int8_without_cuda_devices():
    logs, factory = [], FakeFactory()
    model, device = load_model('m', 'auto', logs.append, factory=factory, cuda_count=lambda: 0, check_cuda=ok_probe)
    assert device == 'cpu'
    assert factory.calls == [('cpu', 'int8')]
    assert len(logs) == 1


def test_cpu_never_touches_cuda():
    logs, factory = [], FakeFactory()

    def boom():
        raise AssertionError('should not ask for CUDA devices')

    _, device = load_model('m', 'cpu', logs.append, factory=factory, cuda_count=boom, check_cuda=ok_probe)
    assert device == 'cpu'
    assert factory.calls == [('cpu', 'int8')]
    assert logs == []


def test_cuda_model_creation_failure_falls_back_to_cpu_with_log():
    logs, factory = [], FakeFactory(fail_cuda=True)
    model, device = load_model('m', 'auto', logs.append, factory=factory, cuda_count=lambda: 1, check_cuda=ok_probe)
    assert (model, device) == ('model@cpu', 'cpu')
    assert factory.calls == [('cuda', 'float16'), ('cpu', 'int8')]
    assert len(logs) == 1
    assert logs[0].startswith(CUDA_FALLBACK_MESSAGE)
    assert 'no CUDA-capable device' in logs[0]


def test_missing_cublas_found_by_warm_up_falls_back_to_cpu():
    logs, factory = [], FakeFactory()

    def probe(model):
        raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')

    _, device = load_model('m', 'cuda', logs.append, factory=factory, cuda_count=lambda: 0, check_cuda=probe)
    assert device == 'cpu'
    assert 'cublas64_12.dll' in logs[0]
    assert CUDA_FALLBACK_MESSAGE in logs[0]


def test_repo_id_for():
    assert repo_id_for('Systran/faster-whisper-tiny') == 'Systran/faster-whisper-tiny'
    assert repo_id_for('tiny') == 'Systran/faster-whisper-tiny'
    with pytest.raises(UserError, match='找不到語音辨識模型'):
        repo_id_for('not-a-model')


def test_resolve_model_accepts_a_local_folder(tmp_path):
    logs = []
    assert resolve_model(str(tmp_path), logs.append) == str(tmp_path)
    assert logs == []


def test_resolve_model_rejects_a_missing_local_folder(tmp_path):
    with pytest.raises(UserError, match='找不到語音辨識模型資料夾'):
        resolve_model(str(tmp_path / 'nope'), [].append)


def test_download_errors_are_readable():
    from huggingface_hub import errors

    offline = errors.LocalEntryNotFoundError('cannot find the requested files in the local cache')
    assert '請檢查網路連線' in str(model_download_error('a/b', offline))
    assert '找不到語音辨識模型' in str(model_download_error('a/b', ValueError('Invalid model size')))
    assert '請檢查網路連線' in str(model_download_error('a/b', ConnectionError('refused')))
    assert str(model_download_error('a/b', RuntimeError('x'))) == '下載語音辨識模型 a/b 失敗：RuntimeError: x'
