"""CutFlow CLI — local server, hardware/NVENC doctor, and DB migrations."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys

import typer
import uvicorn

from . import __version__, db, paths
from .workspace.benchmark import run_benchmark

cli = typer.Typer(name="cutflow", help="CutFlow AI Video Clipping Studio CLI.")


def _run_cmd(argv: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=8, check=False)
        return proc.returncode, (proc.stdout + "\n" + proc.stderr).strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)


def _probe_nvenc() -> tuple[bool, str]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False, "ffmpeg not found on PATH"
    code, out = _run_cmd(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x128:d=0.1",
            "-c:v",
            "h264_nvenc",
            "-f",
            "null",
            "-",
        ]
    )
    if code == 0:
        return True, "h264_nvenc operational"
    if "minimum required nvidia driver" in out.lower() or "api version" in out.lower():
        first_line = out.splitlines()[0]
        msg = f"Driver/FFmpeg NVENC API mismatch (CPU libx264 fallback active): {first_line}"
        return False, msg
    return False, (out.splitlines()[0] if out else "NVENC unavailable")


@cli.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="Bind host (127.0.0.1 enforced for security)."),
    port: int = typer.Option(8010, help="HTTP port."),
    reload: bool = typer.Option(False, help="Enable hot reload for development."),
) -> None:
    """Start the local CutFlow studio server."""
    allow_container = os.environ.get("CUTFLOW_ALLOW_CONTAINER_BIND") == "1"
    allowed = ("127.0.0.1", "localhost", "::1") + (("0.0.0.0",) if allow_container else ())
    if host not in allowed:
        typer.secho(
            f"Refusing non-local bind host {host!r}; CutFlow requires local-first binding.",
            fg=typer.colors.RED,
        )
        raise typer.Exit(code=2)
    uvicorn.run("cutflow.app:app", host=host, port=port, reload=reload)


@cli.command("db-upgrade")
def db_upgrade() -> None:
    """Apply Alembic database migrations to head."""
    paths.ensure_layout()
    db.init_db()
    typer.secho(f"Database migrated cleanly ({paths.database_url()}).", fg=typer.colors.GREEN)


def inspect_environment() -> dict[str, object]:
    """Collect structured hardware, FFmpeg, libass, NVENC, and storage diagnostics."""
    ffmpeg = shutil.which("ffmpeg")
    _, ff_ver = _run_cmd([ffmpeg, "-version"]) if ffmpeg else (1, "missing")
    first_ff = ff_ver.splitlines()[0] if ff_ver else "missing"
    has_libass = "enable-libass" in ff_ver

    nvenc_ok, nvenc_detail = _probe_nvenc()
    smi = shutil.which("nvidia-smi")
    gpu_line = "None detected"
    if smi:
        code, smi_out = _run_cmd(
            [smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"]
        )
        if code == 0 and smi_out:
            gpu_line = smi_out.splitlines()[0]

    disk = shutil.disk_usage(paths.root() if paths.root().exists() else paths.root().parent)
    free_gb = round(disk.free / (1024**3), 1)
    return {
        "version": __version__,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "ffmpeg": first_ff,
        "libass": has_libass,
        "ytDlp": bool(shutil.which("yt-dlp")),
        "gpu": gpu_line,
        "nvencOk": nvenc_ok,
        "nvencDetail": nvenc_detail,
        "dataRoot": str(paths.root()),
        "freeGb": free_gb,
        "inboxRoot": str(paths.inbox_dir()),
    }


@cli.command()
def doctor() -> None:
    """Inspect Python, FFmpeg, libass, GPU/NVENC compatibility, and storage health."""
    info = inspect_environment()
    typer.echo(f"CutFlow {info['version']} Doctor")
    typer.echo("-" * 56)
    typer.echo(f"Platform    : {info['platform']}")
    typer.echo(f"Python      : {info['python']}")
    typer.echo(f"FFmpeg      : {info['ffmpeg']}")
    typer.echo(f"libass      : {'OK' if info['libass'] else 'MISSING'}")
    typer.echo(f"yt-dlp      : {'OK' if info['ytDlp'] else 'MISSING'}")
    typer.echo(f"GPU         : {info['gpu']}")
    nv_state = "OK" if info["nvencOk"] else "FALLBACK"
    typer.echo(f"NVENC       : {nv_state} — {info['nvencDetail']}")
    typer.echo(f"Data Root   : {info['dataRoot']} ({info['freeGb']} GB free)")
    typer.echo(f"Inbox Root  : {info['inboxRoot']}")


@cli.command()
def benchmark(
    duration: int = typer.Option(12, help="Synthetic 1080p clip duration in seconds."),
    draft_only: bool = typer.Option(False, help="Skip 1080p Final render for faster CI check."),
) -> None:
    """Run timed CutFlow hardware benchmarks and output a Markdown table for README."""
    typer.echo(f"Running CutFlow {__version__} hardware benchmark ({duration}s 1080p clip)...")
    result = run_benchmark(duration_s=duration, include_final_1080p=not draft_only)
    typer.echo("")
    typer.echo(result["markdown"])


def main() -> None:
    cli()
