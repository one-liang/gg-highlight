from gg_transcriber.download import progress_tqdm_class
from gg_transcriber.events import ProgressReporter


def make(total_bytes):
    events = []
    cls = progress_tqdm_class(ProgressReporter(events.append), total_bytes)
    return events, cls


def values(events):
    return [e['progress'] for e in events]


def test_byte_bars_drive_progress_against_the_expected_total():
    events, cls = make(1000)
    files = cls(total=5, desc='Fetching 5 files')
    reconstruct = cls(total=0, unit='B', unit_scale=True, desc='Reconstructing')
    # A small file registers and finishes before the big one is known: still measured against 1000.
    reconstruct.total = 10
    reconstruct.update(10)
    files.update(1)
    reconstruct.total = 1000
    reconstruct.update(490)
    reconstruct.update(500)
    files.update(4)
    assert values(events) == [0.01, 0.5, 0.99]
    for bar in (files, reconstruct):
        bar.close()


def test_without_byte_bars_counts_files():
    events, cls = make(0)
    files = cls(total=4, desc='Fetching 4 files')
    files.update(1)
    files.update(1)
    files.update(2)
    assert values(events) == [0.25, 0.5, 0.99]
    files.close()


def test_bars_print_nothing(capsys):
    events, cls = make(100)
    bar = cls(total=100, unit='B', name='huggingface_hub.snapshot_download')
    bar.update(100)
    bar.close()
    captured = capsys.readouterr()
    assert captured.out == ''
    assert captured.err == ''
