import json
import re

from conftest import run_cli


def assert_only_json_lines(stdout: str) -> None:
    for line in stdout.splitlines():
        if line.strip():
            json.loads(line)


def test_check_prints_versions_and_cuda_count():
    code, events, stdout, _ = run_cli('check')
    assert code == 0
    assert len(events) == 1
    check = events[0]
    assert check['type'] == 'check'
    assert re.match(r'^3\.12\.\d+$', check['python'])
    assert re.match(r'^\d+\.\d+', check['fasterWhisper'])
    assert re.match(r'^4\.\d+', check['ctranslate2'])
    assert isinstance(check['cudaDevices'], int) and check['cudaDevices'] >= 0
    assert set(check) == {'type', 'python', 'fasterWhisper', 'ctranslate2', 'cudaDevices'}


def test_missing_command_is_an_error_event():
    code, events, stdout, _ = run_cli()
    assert code == 1
    assert events[-1]['type'] == 'error'
    assert events[-1]['message'].startswith('參數錯誤')
    assert_only_json_lines(stdout)


def test_bad_device_is_an_error_event():
    code, events, _, _ = run_cli('transcribe', '--audio', 'a.wav', '--language', 'en', '--model', 'tiny', '--device', 'gpu', '--out', 'o.json')
    assert code == 1
    assert events == [{'type': 'error', 'message': events[0]['message']}]
    assert '參數錯誤' in events[0]['message']


def test_missing_audio_is_a_readable_error(tmp_path):
    audio = tmp_path / '不存在.wav'
    out = tmp_path / 'out.json'
    code, events, stdout, _ = run_cli(
        'transcribe', '--audio', str(audio), '--language', 'zh', '--model', 'tiny', '--device', 'cpu', '--out', str(out),
    )
    assert code == 1
    assert events == [{'type': 'error', 'message': f'找不到音訊檔：{audio}'}]
    # Raw UTF-8 on stdout, not \u escapes.
    assert '找不到音訊檔' in stdout
    assert not out.exists()


def test_unreadable_audio_is_an_error_event(tmp_path):
    audio = tmp_path / 'broken.wav'
    audio.write_bytes(b'not really audio')
    code, events, stdout, stderr = run_cli(
        'transcribe', '--audio', str(audio), '--language', 'en', '--model', 'Systran/faster-whisper-tiny', '--device', 'cpu',
        '--out', str(tmp_path / 'o.json'),
    )
    assert code == 1
    assert events[-1]['type'] == 'error'
    assert events[-1]['message'].startswith(f'無法讀取音訊檔：{audio}')
    assert_only_json_lines(stdout)


def test_unknown_model_is_a_readable_error(tmp_path, speech_en):
    code, events, _, _ = run_cli(
        'transcribe', '--audio', str(speech_en), '--language', 'en', '--model', 'not-a-model', '--device', 'cpu',
        '--out', str(tmp_path / 'o.json'),
    )
    assert code == 1
    assert events[-1] == {'type': 'error', 'message': '找不到語音辨識模型：not-a-model'}
