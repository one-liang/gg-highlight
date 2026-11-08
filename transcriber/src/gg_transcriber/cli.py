"""gg-transcribe: the Python side of server/lib/transcription/protocol.ts.

    gg-transcribe transcribe --audio <wav> --language <zh|en> --model <repo-or-path>
                             --device <auto|cuda|cpu> --out <json> [--initial-prompt <text>]
    gg-transcribe check
    gg-transcribe download --model <repo-or-path>

stdout carries one JSON event per line; everything else goes to stderr.
"""

from __future__ import annotations

import argparse
import platform
import sys
import traceback
from typing import Any, NoReturn, Sequence

from .errors import UserError, describe
from .events import EventWriter, configure_stdio


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise UserError(f'參數錯誤：{message}')


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog='gg-transcribe', description='gg-highlight 語音辨識（faster-whisper）')
    sub = parser.add_subparsers(dest='command', required=True)

    t = sub.add_parser('transcribe', help='辨識音訊檔，輸出逐字稿 JSON')
    t.add_argument('--audio', required=True, help='16 kHz WAV (any format ffmpeg/PyAV can read works)')
    t.add_argument('--language', required=True, help='Whisper language code, e.g. zh or en')
    t.add_argument('--model', required=True, help='Hugging Face repo id or local CTranslate2 model folder')
    t.add_argument('--device', choices=['auto', 'cuda', 'cpu'], default='auto')
    t.add_argument('--out', required=True, help='RawTranscript JSON path')
    t.add_argument('--initial-prompt', default=None)

    sub.add_parser('check', help='列出 Python、faster-whisper、ctranslate2 版本與 CUDA 裝置數')

    d = sub.add_parser('download', help='下載模型到 Hugging Face 快取')
    d.add_argument('--model', required=True)
    return parser


def cmd_transcribe(args: argparse.Namespace, emit: EventWriter) -> None:
    from .transcribe import run_transcribe

    run_transcribe(
        audio=args.audio,
        language=args.language,
        model=args.model,
        device=args.device,
        out=args.out,
        emit=emit,
        initial_prompt=args.initial_prompt,
    )


def check_info() -> dict[str, Any]:
    import ctranslate2
    import faster_whisper

    from .models import cuda_device_count

    return {
        'type': 'check',
        'python': platform.python_version(),
        'fasterWhisper': faster_whisper.__version__,
        'ctranslate2': ctranslate2.__version__,
        'cudaDevices': cuda_device_count(),
    }


def cmd_check(args: argparse.Namespace, emit: EventWriter) -> None:
    emit(check_info())


def cmd_download(args: argparse.Namespace, emit: EventWriter) -> None:
    from .download import run_download

    run_download(model=args.model, emit=emit)


COMMANDS = {
    'transcribe': cmd_transcribe,
    'check': cmd_check,
    'download': cmd_download,
}


def main(argv: Sequence[str] | None = None) -> int:
    configure_stdio()
    emit = EventWriter()
    try:
        args = build_parser().parse_args(argv)
        # Must run before anything imports ctranslate2 (faster_whisper does).
        from .cuda_dlls import setup_windows_cuda_dlls

        setup_windows_cuda_dlls()
        COMMANDS[args.command](args, emit)
        return 0
    except SystemExit:
        raise  # --help
    except KeyboardInterrupt:
        _safe_error(emit, '已取消')
        return 130
    except UserError as exc:
        _safe_error(emit, describe(exc))
        return 1
    except BaseException as exc:
        traceback.print_exc(file=sys.stderr)
        _safe_error(emit, describe(exc))
        return 1


def _safe_error(emit: EventWriter, message: str) -> None:
    try:
        emit.error(message)
    except Exception:
        pass


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
