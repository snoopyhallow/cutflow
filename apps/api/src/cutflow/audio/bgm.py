"""BGM & Transition SFX asset library, procedural starter beds, and beat-drop offset scanner."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .. import paths
from ..edl.schema import BgmTrack
from ..security import PathSandboxError, safe_resolve, safe_slug
from ..workspace.profiles import CreatorProfile
from .media import MediaError, extract_wav_16k, probe_media
from .peaks import compute_rms_windows

log = logging.getLogger(__name__)

AUDIO_EXTENSIONS = frozenset({".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"})
AUDIO_MIME_TYPES: dict[str, str] = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


@dataclass(slots=True)
class BgmAsset:
    id: str
    name: str
    filename: str
    mood: str
    duration_ms: int
    size_bytes: int
    drop_offset_ms: int = 0
    builtin: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _index_path() -> Path:
    return paths.bgm_dir() / "bgm_index.json"


def _write_stereo_wav(dest: Path, left: np.ndarray, right: np.ndarray, sr: int = 44100) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    stereo = np.stack([np.clip(left, -0.98, 0.98), np.clip(right, -0.98, 0.98)], axis=1)
    pcm16 = (stereo * 32767.0).astype(np.int16)
    with wave.open(str(dest), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())


def _synthesize_dark_cinema_pulse(dest: Path, sr: int = 44100, dur_s: float = 16.0) -> None:
    """Synthesize a moody JJ_EDIT-style dark synthwave bass + atmospheric pad bed."""
    t = np.linspace(0.0, dur_s, int(sr * dur_s), endpoint=False, dtype=np.float32)
    # 2-bar root progression (D1 -> Bb0 -> G0 -> A0) with warm saw-like harmonics
    notes_hz = np.select(
        [t < 4.0, t < 8.0, t < 12.0],
        [73.42, 58.27, 49.00],
        default=55.00,
    ).astype(np.float32)
    phase = 2.0 * np.pi * np.cumsum(notes_hz) / sr
    # Eighth-note dark pulse envelope (120 BPM -> 4 Hz pulse)
    pulse = 0.45 + 0.55 * (0.5 * (1.0 - np.cos(2.0 * np.pi * 4.0 * t))) ** 2
    bass = (0.62 * np.sin(phase) + 0.24 * np.sin(2.0 * phase) + 0.10 * np.sin(3.0 * phase)) * pulse

    # Stereo detuned minor-fifth atmospheric pad
    pad_l = 0.18 * np.sin(2.0 * np.pi * 220.0 * t) + 0.14 * np.sin(2.0 * np.pi * 261.63 * t)
    pad_r = 0.18 * np.sin(2.0 * np.pi * 220.8 * t) + 0.14 * np.sin(2.0 * np.pi * 262.4 * t)

    # Seamless loop crossfade edges
    fade_n = int(sr * 0.08)
    env = np.ones_like(t)
    env[:fade_n] = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    env[-fade_n:] = np.linspace(1.0, 0.0, fade_n, dtype=np.float32)
    _write_stereo_wav(dest, (0.55 * bass + pad_l) * env, (0.55 * bass + pad_r) * env, sr=sr)


def _synthesize_upbeat_challenge_drive(dest: Path, sr: int = 44100, dur_s: float = 16.0) -> None:
    """Synthesize a high-retention challenge/gaming beat bed (128 BPM kick + arp)."""
    t = np.linspace(0.0, dur_s, int(sr * dur_s), endpoint=False, dtype=np.float32)
    beat_hz = 128.0 / 60.0
    beat_pos = (t * beat_hz) % 1.0
    # Punchy 4-on-the-floor kick drum sweep
    kick_env = np.exp(-14.0 * beat_pos)
    kick_freq = 52.0 + 95.0 * np.exp(-28.0 * beat_pos)
    kick = 0.55 * np.sin(2.0 * np.pi * kick_freq * beat_pos) * kick_env

    # Plucky sixteenth-note synth arpeggio
    arp_freqs = np.array([261.63, 329.63, 392.00, 523.25], dtype=np.float32)
    step_idx = (np.floor(t * beat_hz * 4.0).astype(np.int32)) % 4
    step_pos = (t * beat_hz * 4.0) % 1.0
    arp_env = np.exp(-7.5 * step_pos)
    arp_f = arp_freqs[step_idx]
    arp_l = 0.26 * np.sin(2.0 * np.pi * arp_f * t) * arp_env
    arp_r = 0.26 * np.sin(2.0 * np.pi * (arp_f * 1.003) * t) * arp_env

    fade_n = int(sr * 0.05)
    env = np.ones_like(t)
    env[:fade_n] = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    env[-fade_n:] = np.linspace(1.0, 0.0, fade_n, dtype=np.float32)
    _write_stereo_wav(dest, (kick + arp_l) * env, (kick + arp_r) * env, sr=sr)


def _synthesize_transition_sfx(sfx_folder: Path, sr: int = 44100) -> None:
    """Synthesize crisp stereo whoosh_flash.wav and cinema_hit.wav transition SFX."""
    whoosh_path = sfx_folder / "whoosh_flash.wav"
    if not whoosh_path.is_file():
        dur = 0.30
        n = int(sr * dur)
        t = np.linspace(0.0, dur, n, endpoint=False, dtype=np.float32)
        rng = np.random.default_rng(42)
        noise = rng.standard_normal(n).astype(np.float32) * 0.28
        # Bell envelope peaking right at the cut midpoint (0.14s) + swept tone
        bell = np.exp(-(((t - 0.14) / 0.065) ** 2))
        sweep = 0.35 * np.sin(2.0 * np.pi * (180.0 + 1400.0 * (t / dur) ** 2) * t)
        pan_l = np.linspace(0.85, 0.35, n, dtype=np.float32)
        pan_r = np.linspace(0.35, 0.85, n, dtype=np.float32)
        sig = (noise + sweep) * bell
        _write_stereo_wav(whoosh_path, sig * pan_l, sig * pan_r, sr=sr)

    hit_path = sfx_folder / "cinema_hit.wav"
    if not hit_path.is_file():
        dur = 0.55
        n = int(sr * dur)
        t = np.linspace(0.0, dur, n, endpoint=False, dtype=np.float32)
        env = np.exp(-6.5 * t)
        sub_boom = 0.72 * np.sin(2.0 * np.pi * (68.0 * np.exp(-3.2 * t) + 36.0) * t) * env
        shimmer = 0.14 * np.sin(2.0 * np.pi * 110.0 * t) * np.exp(-9.0 * t)
        _write_stereo_wav(hit_path, sub_boom + shimmer, sub_boom - shimmer * 0.5, sr=sr)


def resolve_sfx_path(sfx_kind: str) -> Path | None:
    if sfx_kind not in ("whoosh_flash", "cinema_hit"):
        return None
    paths.ensure_layout()
    _synthesize_transition_sfx(paths.sfx_dir())
    candidate = paths.sfx_dir() / f"{sfx_kind}.wav"
    return candidate if candidate.is_file() else None


def find_bgm_start_offset_ms(audio_path: Path, duration_ms: int) -> int:
    """Locate the first energetic beat/drop onset so clips skip dead song intros."""
    if duration_ms < 8000 or not audio_path.is_file():
        return 0
    tmp_wav: Path | None = None
    try:
        if audio_path.suffix.lower() == ".wav":
            scan_wav = audio_path
        else:
            tmp_wav = paths.cache_dir() / f"bgm_scan_{audio_path.stem}.wav"
            extract_wav_16k(audio_path, tmp_wav, duration_ms=min(duration_ms, 90_000))
            scan_wav = tmp_wav

        windows = compute_rms_windows(scan_wav, window_s=1.0)
        if not windows:
            return 0
        max_start_s = max(0.0, (duration_ms - 8000) / 1000.0)
        eligible = [(s0, score) for s0, _, score in windows if s0 <= max_start_s]
        if not eligible:
            return 0
        peak = max(score for _, score in eligible)
        # If opening 2 seconds are already energetic, start cleanly at 0ms
        if eligible[0][1] >= peak * 0.62:
            return 0
        for s0, score in eligible:
            if score >= peak * 0.68:
                return int(round(s0 * 1000.0))
        return 0
    except Exception as exc:
        log.debug("BGM offset scan skipped for %s (%s).", audio_path.name, exc)
        return 0
    finally:
        if tmp_wav is not None:
            tmp_wav.unlink(missing_ok=True)


def _load_raw_index() -> dict[str, dict[str, Any]]:
    idx_file = _index_path()
    if not idx_file.is_file():
        return {}
    try:
        raw = json.loads(idx_file.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_raw_index(entries: dict[str, dict[str, Any]]) -> None:
    idx_file = _index_path()
    idx_file.parent.mkdir(parents=True, exist_ok=True)
    idx_file.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def ensure_starter_audio_assets() -> None:
    """Idempotently synthesize built-in royalty-free BGM beds and transition SFX."""
    paths.ensure_layout()
    bgm_folder = paths.bgm_dir()
    _synthesize_transition_sfx(paths.sfx_dir())

    starters = (
        (
            "dark_cinema_pulse",
            "Dark Cinema Synth Pulse",
            "dark_cinema",
            _synthesize_dark_cinema_pulse,
        ),
        (
            "upbeat_challenge_drive",
            "Upbeat Challenge Drive",
            "upbeat_gaming",
            _synthesize_upbeat_challenge_drive,
        ),
    )
    idx = _load_raw_index()
    changed = False
    for asset_id, label, mood, builder in starters:
        wav_file = bgm_folder / f"{asset_id}.wav"
        if not wav_file.is_file():
            builder(wav_file)
            changed = True
        if asset_id not in idx:
            idx[asset_id] = {
                "id": asset_id,
                "name": label,
                "filename": wav_file.name,
                "mood": mood,
                "duration_ms": 16_000,
                "size_bytes": wav_file.stat().st_size,
                "drop_offset_ms": 0,
                "builtin": True,
            }
            changed = True
    if changed:
        _save_raw_index(idx)


def _probe_audio_duration_ms(file_path: Path) -> int:
    if file_path.suffix.lower() == ".wav":
        try:
            with wave.open(str(file_path), "rb") as wf:
                sr = wf.getframerate()
                frames = wf.getnframes()
                if sr > 0:
                    return int(round((frames / sr) * 1000.0))
        except Exception:
            pass
    try:
        info = probe_media(file_path)
        if info.duration_ms > 0:
            return info.duration_ms
    except MediaError:
        pass
    # Audio-only containers have no video stream, so probe format duration directly via ffprobe
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        try:
            return max(1000, int(round(float(proc.stdout.strip()) * 1000.0)))
        except ValueError:
            pass
    return 30_000


def list_bgm_assets() -> list[BgmAsset]:
    """Return all available BGM tracks, auto-discovering any files dropped in ~/.cutflow/bgm/."""
    ensure_starter_audio_assets()
    folder = paths.bgm_dir()
    idx = _load_raw_index()
    known_files = {str(v.get("filename") or ""): k for k, v in idx.items()}
    changed = False

    # Remove stale index entries whose files were deleted manually
    for aid in list(idx):
        fname = str(idx[aid].get("filename") or "")
        if not fname or not (folder / fname).is_file():
            idx.pop(aid, None)
            changed = True

    # Auto-register newly dropped audio files in ~/.cutflow/bgm/
    for entry in sorted(folder.iterdir()):
        if not entry.is_file() or entry.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        if entry.name in known_files:
            continue
        aid = safe_slug(entry.stem, max_length=48, default="bgm")
        base = aid
        n = 2
        while aid in idx:
            aid = f"{base}-{n}"
            n += 1
        dur_ms = _probe_audio_duration_ms(entry)
        drop_ms = find_bgm_start_offset_ms(entry, dur_ms)
        idx[aid] = {
            "id": aid,
            "name": entry.stem.replace("_", " ").replace("-", " ").strip().title()[:80] or aid,
            "filename": entry.name,
            "mood": "any",
            "duration_ms": dur_ms,
            "size_bytes": entry.stat().st_size,
            "drop_offset_ms": drop_ms,
            "builtin": False,
        }
        changed = True

    if changed:
        _save_raw_index(idx)

    assets = [
        BgmAsset(
            id=str(v["id"]),
            name=str(v.get("name") or v["id"]),
            filename=str(v["filename"]),
            mood=str(v.get("mood") or "any"),
            duration_ms=int(v.get("duration_ms") or 16_000),
            size_bytes=int(v.get("size_bytes") or 0),
            drop_offset_ms=int(v.get("drop_offset_ms") or 0),
            builtin=bool(v.get("builtin", False)),
        )
        for v in idx.values()
    ]
    # Show custom uploaded tracks first, then built-in starter beds
    assets.sort(key=lambda a: (a.builtin, a.name.lower()))
    return assets


def save_uploaded_bgm(
    raw_filename: str,
    data: bytes,
    *,
    name: str = "",
    mood: str = "any",
) -> BgmAsset:
    """Persist an uploaded BGM audio file safely in ~/.cutflow/bgm/ and compute drop offset."""
    ext = Path(raw_filename).suffix.lower() or ".mp3"
    if ext not in AUDIO_EXTENSIONS:
        allowed = ", ".join(sorted(AUDIO_EXTENSIONS))
        raise ValueError(f"Unsupported audio format {ext!r}; allowed: {allowed}")
    if not data:
        raise ValueError("Uploaded BGM audio file is empty.")

    ensure_starter_audio_assets()
    folder = paths.bgm_dir()
    idx = _load_raw_index()

    stem = Path(raw_filename).stem
    aid = safe_slug(name or stem, max_length=48, default="bgm")
    base = aid
    n = 2
    while aid in idx or (folder / f"{aid}{ext}").exists():
        aid = f"{base}-{n}"
        n += 1

    dest = safe_resolve(folder / f"{aid}{ext}", folder)
    dest.write_bytes(data)

    dur_ms = _probe_audio_duration_ms(dest)
    drop_ms = find_bgm_start_offset_ms(dest, dur_ms)
    valid_moods = ("dark_cinema", "upbeat_gaming", "suspense", "emotional", "any")
    clean_mood = mood if mood in valid_moods else "any"
    display_name = (name.strip() or stem.replace("_", " ").strip())[:80] or aid

    asset = BgmAsset(
        id=aid,
        name=display_name,
        filename=dest.name,
        mood=clean_mood,
        duration_ms=dur_ms,
        size_bytes=len(data),
        drop_offset_ms=drop_ms,
        builtin=False,
    )
    idx[aid] = asset.to_dict()
    _save_raw_index(idx)
    return asset


def resolve_bgm_asset_path(asset_id: str) -> tuple[Path, str] | None:
    """Resolve ``asset_id`` to a sandboxed ``(file_path, mime_type)`` inside ``bgm_dir()``."""
    if not asset_id:
        return None
    assets = {a.id: a for a in list_bgm_assets()}
    found = assets.get(asset_id)
    if found is None:
        return None
    try:
        safe = safe_resolve(paths.bgm_dir() / found.filename, paths.bgm_dir())
    except PathSandboxError:
        return None
    if not safe.is_file():
        return None
    mime = AUDIO_MIME_TYPES.get(safe.suffix.lower(), "application/octet-stream")
    return safe, mime


def delete_bgm_asset(asset_id: str) -> bool:
    idx = _load_raw_index()
    entry = idx.pop(asset_id, None)
    if entry is None:
        return False
    _save_raw_index(idx)
    fname = str(entry.get("filename") or "")
    if fname:
        try:
            safe = safe_resolve(paths.bgm_dir() / fname, paths.bgm_dir())
            safe.unlink(missing_ok=True)
        except PathSandboxError:
            pass
    return True


def select_bgm_track_for_profile(
    profile: CreatorProfile,
    *,
    mood_hint: str = "",
) -> BgmTrack | None:
    """Automatically choose a BGM track & beat-drop offset for zero-touch clip generation."""
    if profile.bgm_mode == "off":
        return None

    assets = list_bgm_assets()
    if not assets:
        return None

    by_id = {a.id: a for a in assets}
    chosen: BgmAsset | None = None

    if profile.bgm_mode == "pinned_asset" and profile.bgm_asset_id in by_id:
        chosen = by_id[profile.bgm_asset_id]
    else:
        fallback_mood = "dark_cinema" if profile.content_mode == "cinema" else "upbeat_gaming"
        target_mood = (
            profile.bgm_mood
            if profile.bgm_mood != "any"
            else (mood_hint or fallback_mood)
        )
        # 1. Custom uploaded track matching mood
        custom_mood = [a for a in assets if not a.builtin and a.mood in (target_mood, "any")]
        # 2. Built-in starter bed matching mood
        builtin_mood = [a for a in assets if a.builtin and a.mood == target_mood]
        if custom_mood:
            chosen = custom_mood[0]
        elif builtin_mood:
            chosen = builtin_mood[0]
        else:
            chosen = assets[0]

    default_gain = -15.5 if profile.content_mode == "cinema" else -17.0
    return BgmTrack(
        asset_id=chosen.id,
        gain_db=default_gain,
        ducking_enabled=True,
        start_offset_ms=chosen.drop_offset_ms,
        fade_in_ms=500,
        fade_out_ms=1100,
    )
