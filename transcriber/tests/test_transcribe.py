import json
import os
from types import SimpleNamespace

import pytest

from conftest import TINY_MODEL, run_cli
from gg_transcriber.events import ProgressReporter
from gg_transcriber.transcribe import collect_segments, segment_to_dict, transcribe_options, write_json_atomic


def fake_segment(start, end, text, words):
    return SimpleNamespace(
        start=start,
        end=end,
        text=text,
        words=[SimpleNamespace(start=s, end=e, word=w, probability=p) for s, e, w, p in words],
    )


def test_segment_to_dict_rounds_and_keeps_raw_words():
    seg = fake_segment(1.23456, 2.0, ' 大家好 ', [(1.23456, 1.5, '大', 0.912345), (1.5, float('nan'), '家', 0.5)])
    assert segment_to_dict(seg) == {
        'start': 1.235,
        'end': 2.0,
        'text': '大家好',
        'words': [
            {'start': 1.235, 'end': 1.5, 'word': '大', 'probability': 0.9123},
            {'start': 1.5, 'end': 0.0, 'word': '家', 'probability': 0.5},
        ],
    }
    assert segment_to_dict(SimpleNamespace(start=0, end=1, text=None, words=None)) == {'start': 0.0, 'end': 1.0, 'text': '', 'words': []}


def test_segment_to_dict_exports_confidence_measures():
    seg = fake_segment(0, 1, '快', [(0, 1, '快', 0.9)])
    seg.avg_logprob = -0.123456
    seg.no_speech_prob = 0.654321
    seg.compression_ratio = 2.71828
    out = segment_to_dict(seg)
    assert out['avgLogprob'] == -0.1235
    assert out['noSpeechProb'] == 0.6543
    assert out['compressionRatio'] == 2.7183
    assert list(out) == ['start', 'end', 'text', 'words', 'avgLogprob', 'noSpeechProb', 'compressionRatio']


def test_segment_to_dict_omits_missing_or_non_finite_confidence():
    seg = fake_segment(0, 1, '快', [])
    seg.avg_logprob = None
    seg.no_speech_prob = float('nan')
    seg.compression_ratio = float('inf')
    assert segment_to_dict(seg) == {'start': 0.0, 'end': 1.0, 'text': '快', 'words': []}
    # The JSON stays valid for write_json_atomic (allow_nan=False).
    json.dumps(segment_to_dict(seg), allow_nan=False)


def test_collect_segments_reports_end_over_duration():
    events = []
    segments = [fake_segment(0, 2, 'a', []), fake_segment(2, 2.01, 'b', []), fake_segment(3, 5, 'c', [])]
    out = collect_segments(iter(segments), 10.0, ProgressReporter(events.append))
    assert [s['text'] for s in out] == ['a', 'b', 'c']
    assert [e['progress'] for e in events] == [0.2, 0.5, 1.0]


def test_transcribe_options_match_the_spec():
    opts = transcribe_options('zh', '')
    assert opts == {
        'language': 'zh',
        'word_timestamps': True,
        'vad_filter': True,
        'vad_parameters': {'min_silence_duration_ms': 500},
        'beam_size': 5,
        'condition_on_previous_text': False,
        'initial_prompt': None,
    }
    assert transcribe_options('en', 'Valorant')['initial_prompt'] == 'Valorant'


def test_write_json_atomic(tmp_path):
    target = tmp_path / 'nested' / 'transcript.raw.json'
    assert write_json_atomic(str(target), {'text': '大家好'}) == str(target)
    raw = target.read_bytes()
    assert '大家好'.encode('utf-8') in raw
    assert json.loads(raw.decode('utf-8')) == {'text': '大家好'}

    write_json_atomic(str(target), {'text': 'again'})
    assert json.loads(target.read_text('utf-8')) == {'text': 'again'}
    assert os.listdir(target.parent) == ['transcript.raw.json']


def test_write_json_atomic_leaves_old_file_on_failure(tmp_path):
    target = tmp_path / 'raw.json'
    write_json_atomic(str(target), {'ok': True})
    with pytest.raises(ValueError):
        write_json_atomic(str(target), {'bad': float('nan')})
    assert json.loads(target.read_text('utf-8')) == {'ok': True}
    assert os.listdir(tmp_path) == ['raw.json']


def test_real_transcription_with_tiny_model_on_cpu(tmp_path, speech_en):
    out = tmp_path / 'out' / 'transcript.raw.json'
    code, events, stdout, stderr = run_cli(
        'transcribe', '--audio', str(speech_en), '--language', 'en', '--model', TINY_MODEL, '--device', 'auto',
        '--out', str(out),
    )
    assert code == 0, stderr
    assert events[-1] == {'type': 'done', 'output': str(out)}
    assert not any(e['type'] == 'error' for e in events)

    progress = [e['progress'] for e in events if e['type'] == 'progress']
    assert progress, events
    assert progress == sorted(progress)
    assert progress[-1] == 1.0
    assert all(0 < p <= 1 for p in progress)
    # The final 1.0 comes before done, after the file was written.
    assert events[-2] == {'type': 'progress', 'progress': 1.0}

    raw = json.loads(out.read_text('utf-8'))
    assert raw['language'] == 'en'
    assert raw['model'] == TINY_MODEL
    assert raw['device'] == 'cpu'
    assert 5 < raw['durationSec'] < 30
    assert raw['segments']
    words = [w for s in raw['segments'] for w in s['words']]
    assert words
    for seg in raw['segments']:
        assert 0 <= seg['start'] <= seg['end'] <= raw['durationSec'] + 0.5
        assert isinstance(seg['text'], str)
        for w in seg['words']:
            assert w['start'] <= w['end']
            assert 0 <= w['probability'] <= 1
        assert seg['avgLogprob'] <= 0
        assert 0 <= seg['noSpeechProb'] <= 1
        assert seg['compressionRatio'] > 0
    text = ' '.join(w['word'] for w in words).lower()
    assert 'welcome' in text
    assert 'stream' in text


def test_download_of_a_cached_model_finishes_with_done(speech_en):
    # The real transcription test above (or an earlier run) put the tiny model in the HF cache.
    code, events, _, stderr = run_cli('download', '--model', TINY_MODEL)
    assert code == 0, stderr
    assert events[-1]['type'] == 'done'
    assert os.path.isfile(os.path.join(events[-1]['output'], 'model.bin'))
    assert {'type': 'progress', 'progress': 1.0} in events


@pytest.fixture(scope='module')
def tiny_cpu_model():
    from faster_whisper import WhisperModel

    from gg_transcriber.models import resolve_model

    return WhisperModel(resolve_model(TINY_MODEL, print), device='cpu', compute_type='int8')


def test_batched_pipeline_path_works(tiny_cpu_model, speech_en):
    # The CUDA path uses BatchedInferencePipeline; run it on CPU to check the options are accepted.
    from gg_transcriber.transcribe import start_transcription

    events = []
    segments, info = start_transcription(tiny_cpu_model, True, str(speech_en), transcribe_options('en', 'Hello'))
    out = collect_segments(segments, info.duration, ProgressReporter(events.append))
    text = ' '.join(w['word'] for s in out for w in s['words']).lower()
    assert 'welcome' in text and 'stream' in text
    assert events[-1] == {'type': 'progress', 'progress': 1.0}


def test_warm_up_runs_the_encoder(tiny_cpu_model):
    from gg_transcriber.models import warm_up

    warm_up(tiny_cpu_model)


def test_readable_failures():
    import av.error

    from gg_transcriber.transcribe import readable_failure

    oom = readable_failure(RuntimeError('CUDA failed with error out of memory'), 'a.wav')
    assert oom is not None and str(oom).startswith('記憶體不足')
    bad = readable_failure(av.error.InvalidDataError(1094995529, 'Invalid data found when processing input'), 'a.wav')
    assert bad is not None and str(bad).startswith('無法讀取音訊檔：a.wav')
    assert readable_failure(RuntimeError('other'), 'a.wav') is None
