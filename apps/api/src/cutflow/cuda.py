"""Register pip-installed NVIDIA CUDA runtime libraries (cuBLAS / cuDNN) on Windows & POSIX."""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import sysconfig
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

_COMPONENTS = ("cuda_runtime", "cublas", "cudnn", "cuda_nvrtc")


def _nvidia_roots() -> list[Path]:
    candidates = [sysconfig.get_paths().get("purelib"), sysconfig.get_paths().get("platlib")]
    candidates.extend(sys.path)
    roots: list[Path] = []
    for entry in candidates:
        if not entry:
            continue
        nv = Path(entry) / "nvidia"
        if nv.is_dir() and nv not in roots:
            roots.append(nv)
    return roots


def library_directories() -> list[Path]:
    subdir = "bin" if sys.platform == "win32" else "lib"
    found: list[Path] = []
    for root in _nvidia_roots():
        for comp in _COMPONENTS:
            p = root / comp / subdir
            if p.is_dir() and p not in found:
                found.append(p)
        for child in sorted(root.iterdir()):
            p = child / subdir
            if p.is_dir() and p not in found:
                found.append(p)
    return found


@lru_cache(maxsize=1)
def ensure_cuda_libraries() -> list[Path]:
    """Make pip-installed ``nvidia-*`` DLLs/SOs loadable by CTranslate2 / faster-whisper."""
    dirs = library_directories()
    if not dirs:
        return []

    registered: list[Path] = []
    for directory in dirs:
        try:
            if sys.platform == "win32":
                os.add_dll_directory(str(directory))
            else:
                for lib in sorted(directory.glob("*.so*")):
                    try:
                        ctypes.CDLL(str(lib), mode=getattr(ctypes, "RTLD_GLOBAL", 0))
                    except OSError:
                        continue
            registered.append(directory)
        except Exception as exc:
            log.debug("Could not register CUDA directory %s: %s", directory, exc)

    if sys.platform == "win32" and registered:
        existing = os.environ.get("PATH", "")
        additions = [str(d) for d in registered if str(d) not in existing]
        if additions:
            os.environ["PATH"] = os.pathsep.join([*additions, existing])

    return registered
