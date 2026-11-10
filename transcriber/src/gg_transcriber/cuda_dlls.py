"""Make the pip-installed NVIDIA DLLs loadable by CTranslate2 on Windows.

How CTranslate2 finds cuBLAS on Windows (checked against the CTranslate2 v4.6.3 and v4.8.3 sources):

- The PyPI Windows wheels are built with `-DWITH_CUDA=ON -DWITH_CUDNN=OFF -DCUDA_DYNAMIC_LOADING=ON`
  against CUDA 12.8 (python/tools/prepare_build_environment_windows.sh). The CUDA runtime is linked
  statically, and since 4.6.3 Conv1d has a pure CUDA kernel (#1949), so Whisper needs no cuDNN.
  cuBLAS 12 is the only CUDA library loaded from outside the wheel.
- cuBLAS is opened lazily, on the first GPU matmul, by src/cuda/cublas_stub.cc: it calls
  `SetDllDirectoryA("%CUDA_PATH%\\bin")` when CUDA_PATH is set, then `LoadLibraryA("cublas64_12.dll")`.
  The error "Library cublas64_12.dll is not found or cannot be loaded" therefore shows up when
  the model first runs, not on import.
- A plain LoadLibraryA uses the standard search order (exe folder, SetDllDirectory folder, system
  folders, then PATH). Folders registered with os.add_dll_directory (AddDllDirectory) are only
  searched by LoadLibraryEx calls with LOAD_LIBRARY_SEARCH_* flags, which is how Python loads
  extension modules and ctypes.CDLL (ctranslate2/__init__.py preloads its bundled DLLs that way).
  cublas64_12.dll in turn imports cublasLt64_12.dll from the same folder, again via that search order.

The nvidia-cublas-cu12 wheel puts cublas64_12.dll and cublasLt64_12.dll in
site-packages/nvidia/cublas/bin (and its nvrtc dependency in nvidia/cuda_nvrtc/bin). So, before
ctranslate2/faster_whisper are imported, every site-packages/nvidia/*/bin folder is
  1. prepended to PATH, for the stub's LoadLibraryA and for cuBLAS's own dependencies, and
  2. registered with os.add_dll_directory, for LoadLibraryEx/ctypes-style loads.
A system-wide CUDA Toolkit (CUDA_PATH) still wins over the wheel, which is fine for CUDA 12.x.
"""

from __future__ import annotations

import glob
import os
import sys
from typing import Any, Callable, Iterable, MutableMapping

# Handles returned by os.add_dll_directory; closing one would unregister its folder.
_dll_dir_handles: list[Any] = []
_done = False


def nvidia_dll_dirs(search_paths: Iterable[str] | None = None) -> list[str]:
    """All `<site-packages>/nvidia/*/bin` folders on the import path, in sys.path order."""
    found: list[str] = []
    for root in sys.path if search_paths is None else search_paths:
        if not root or not os.path.isdir(root):
            continue
        pattern = os.path.join(glob.escape(os.path.abspath(root)), 'nvidia', '*', 'bin')
        for path in sorted(glob.glob(pattern)):
            if os.path.isdir(path) and path not in found:
                found.append(path)
    return found


def setup_windows_cuda_dlls(
    platform: str = sys.platform,
    search_paths: Iterable[str] | None = None,
    environ: MutableMapping[str, str] | None = None,
    add_dll_directory: Callable[[str], Any] | None = None,
) -> list[str]:
    """Run once before importing ctranslate2. Returns the folders added (empty off Windows)."""
    global _done
    if platform != 'win32':
        return []
    is_default = search_paths is None and environ is None and add_dll_directory is None
    if is_default and _done:
        return []
    env = os.environ if environ is None else environ
    add = add_dll_directory if add_dll_directory is not None else getattr(os, 'add_dll_directory', None)

    dirs = nvidia_dll_dirs(search_paths)
    if dirs:
        current = [p for p in env.get('PATH', '').split(os.pathsep) if p]
        known = {os.path.normcase(p) for p in current}
        new = [d for d in dirs if os.path.normcase(d) not in known]
        env['PATH'] = os.pathsep.join(new + current)
        if add is not None:
            for d in dirs:
                try:
                    _dll_dir_handles.append(add(d))
                except OSError:
                    pass
    if is_default:
        _done = True
    return dirs
