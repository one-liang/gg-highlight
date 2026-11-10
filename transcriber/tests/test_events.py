import io
import json

from gg_transcriber.errors import UserError, describe
from gg_transcriber.events import EventWriter, ProgressReporter


class FlushCounter(io.StringIO):
    def __init__(self) -> None:
        super().__init__()
        self.flushes = 0

    def flush(self) -> None:
        self.flushes += 1
        super().flush()


def test_event_is_one_utf8_json_line_and_flushed():
    stream = FlushCounter()
    emit = EventWriter(stream)
    emit.log('找不到可用的 CUDA，改用 CPU 執行\n第二行')
    emit.progress(0.5)
    emit.done('C:\\data\\videos\\x\\transcript.raw.json')
    emit.error('壞了')

    lines = stream.getvalue().split('\n')
    assert lines[-1] == ''
    lines = lines[:-1]
    assert len(lines) == 4
    # Chinese stays readable (ensure_ascii=False); embedded newlines are escaped.
    assert '找不到可用的 CUDA' in lines[0]
    assert '\\u' not in lines[0]
    events = [json.loads(line) for line in lines]
    assert events == [
        {'type': 'log', 'message': '找不到可用的 CUDA，改用 CPU 執行\n第二行'},
        {'type': 'progress', 'progress': 0.5},
        {'type': 'done', 'output': 'C:\\data\\videos\\x\\transcript.raw.json'},
        {'type': 'error', 'message': '壞了'},
    ]
    assert stream.flushes == 4


def collect():
    events = []
    return events, ProgressReporter(events.append)


def test_progress_is_throttled_monotonic_and_ends_at_one():
    events, progress = collect()
    for value in [0.001, 0.004, 0.006, 0.007, 0.0115, 0.2, 0.1, 0.2049, 0.21, 2.0, 1.0]:
        progress.report(value)
    progress.finish()
    values = [e['progress'] for e in events]
    assert all(e['type'] == 'progress' for e in events)
    assert values == [0.006, 0.0115, 0.2, 0.21, 1.0]
    assert values == sorted(values)


def test_progress_finish_always_emits_one_once():
    events, progress = collect()
    progress.report(0.998)
    progress.finish()
    progress.finish()
    assert [e['progress'] for e in events] == [0.998, 1.0]

    events, progress = collect()
    progress.finish()
    assert [e['progress'] for e in events] == [1.0]


def test_progress_ignores_nan_and_clamps_negative():
    events, progress = collect()
    progress.report(float('nan'))
    progress.report(-3)
    assert events == []


def test_describe():
    assert describe(UserError('找不到音訊檔：a.wav')) == '找不到音訊檔：a.wav'
    assert describe(RuntimeError('boom')) == 'RuntimeError: boom'
    assert describe(RuntimeError()) == 'RuntimeError'
