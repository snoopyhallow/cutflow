"""Creator / Campaign Profile storage backed by SQLAlchemy + AutoClip first-run import."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import paths
from ..db import CreatorProfileRow, get_session
from ..db.models import utcnow_iso
from ..edl import NormalizedBox
from ..security import safe_slug

log = logging.getLogger(__name__)


class CreatorProfile(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=120)
    creator_name: str = ""
    brief: str = ""
    min_duration_s: float = Field(default=15.0, gt=0)
    max_duration_s: float = Field(default=50.0, gt=0)
    max_clips: int = Field(default=8, ge=1, le=50)
    layout_mode: Literal["auto_split", "fit", "auto_reframe"] = "auto_split"
    split_ratio: float = Field(default=0.35, ge=0.20, le=0.65)
    cam_box: NormalizedBox | None = None
    title_card_style: Literal["seam_card_white", "hook_banner_dark", "off"] = "seam_card_white"
    cold_open_enabled: bool = True
    cold_open_duration_ms: int = Field(default=1500, ge=500, le=4000)
    cta_mode: Literal["off", "end_banner", "persistent"] = "off"
    cta_text: str = ""
    reveal_mode: Literal["group", "progressive", "single_word"] = "progressive"
    caption_style: Literal["bold_pop", "karaoke_fill", "clean_lower", "boxed"] = "bold_pop"
    burn_captions: bool = True
    censor_profanity: bool = True
    editor_boundaries: str = ""
    channel_urls: list[str] = Field(default_factory=list)
    keyword_filters: list[str] = Field(default_factory=list)
    auto_queue_feed: bool = False
    auto_export: bool = False

    model_config = {"extra": "ignore"}


def default_profiles() -> list[CreatorProfile]:
    return [
        CreatorProfile(
            id="general-gaming-streamer",
            name="General Gaming Streamer",
            brief=(
                "Find standalone gaming stream clips that hook viewers within 2 seconds. "
                "Prioritize funny/chaotic moments, big reactions, stunts, clutches, and fails."
            ),
            layout_mode="auto_split",
            title_card_style="seam_card_white",
            cold_open_enabled=True,
            editor_boundaries="Keep the streamer webcam clearly visible on top in split-screen.",
        ),
        CreatorProfile(
            id="talking-head-podcast",
            name="Talking Head / Podcast",
            brief=(
                "Find sharp, self-contained podcast or talking-head moments with an immediate "
                "hook: contrarian takes, emotional stories, debates, and quotable rules."
            ),
            min_duration_s=20.0,
            max_duration_s=60.0,
            layout_mode="auto_reframe",
            title_card_style="hook_banner_dark",
            cold_open_enabled=False,
            editor_boundaries="Keep the active speaker centred in frame.",
        ),
    ]


def ensure_inbox_folders(profiles: list[CreatorProfile]) -> None:
    root = paths.inbox_dir()
    root.mkdir(parents=True, exist_ok=True)
    for prof in profiles:
        (root / safe_slug(prof.id)).mkdir(parents=True, exist_ok=True)


def _row_to_profile(row: CreatorProfileRow) -> CreatorProfile:
    payload = dict(row.config_json or {})
    payload["id"] = row.id
    payload["name"] = row.name
    payload["creator_name"] = row.creator_name
    return CreatorProfile.model_validate(payload)


def list_profiles() -> list[CreatorProfile]:
    with get_session() as session:
        stmt = select(CreatorProfileRow).order_by(CreatorProfileRow.created_at)
        rows = session.scalars(stmt).all()
        return [_row_to_profile(r) for r in rows]


def get_profile(profile_id: str) -> CreatorProfile | None:
    with get_session() as session:
        row = session.get(CreatorProfileRow, profile_id)
        return _row_to_profile(row) if row is not None else None


def upsert_profile(profile: CreatorProfile) -> CreatorProfile:
    now = utcnow_iso()
    with get_session() as session:
        row = session.get(CreatorProfileRow, profile.id)
        data = profile.model_dump(mode="json")
        if row is None:
            row = CreatorProfileRow(
                id=profile.id,
                name=profile.name,
                creator_name=profile.creator_name,
                config_json=data,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
        else:
            row.name = profile.name
            row.creator_name = profile.creator_name
            row.config_json = data
            row.updated_at = now
    ensure_inbox_folders([profile])
    return profile


def delete_profile(profile_id: str) -> bool:
    with get_session() as session:
        row = session.get(CreatorProfileRow, profile_id)
        if row is None:
            return False
        session.delete(row)
        return True


def seed_and_import_profiles(*, autoclip_profiles_file: Path | None = None) -> list[CreatorProfile]:
    """Seed starter profiles when empty and optionally import legacy AutoClip profiles."""
    existing = list_profiles()
    existing_ids = {p.id for p in existing}

    if not existing:
        for prof in default_profiles():
            upsert_profile(prof)
            existing_ids.add(prof.id)

    legacy_path = autoclip_profiles_file or (Path.home() / ".autoclip" / "profiles.json")
    if legacy_path.exists():
        try:
            raw = json.loads(legacy_path.read_text(encoding="utf-8"))
            items = raw if isinstance(raw, list) else raw.get("profiles", [])
            for item in items:
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                pid = safe_slug(str(item.get("id") or item["name"]))
                if pid in existing_ids:
                    continue
                migrated = CreatorProfile.model_validate(
                    {
                        "id": pid,
                        "name": str(item["name"]),
                        "creator_name": str(item.get("creator_name") or ""),
                        "brief": str(item.get("brief") or ""),
                        "min_duration_s": float(item.get("min_duration_s") or 15.0),
                        "max_duration_s": float(item.get("max_duration_s") or 50.0),
                        "max_clips": int(item.get("max_clips") or 8),
                        "layout_mode": item.get("layout_mode") or "auto_split",
                        "split_ratio": float(item.get("split_ratio") or 0.35),
                        "cam_box": item.get("cam_box"),
                        "title_card_style": (
                            "seam_card_white"
                            if (item.get("layout_mode") or "auto_split") == "auto_split"
                            else "hook_banner_dark"
                        ),
                        "cold_open_enabled": bool(item.get("cold_open_enabled", True)),
                        "cold_open_duration_ms": int(
                            round(float(item.get("cold_open_duration_s") or 1.5) * 1000)
                        ),
                        "cta_mode": item.get("cta_mode") or "off",
                        "cta_text": str(item.get("cta_text") or ""),
                        "burn_captions": bool(item.get("burn_captions", True)),
                        "censor_profanity": bool(item.get("censor_profanity", True)),
                        "editor_boundaries": str(item.get("editor_boundaries") or ""),
                        "auto_export": bool(item.get("auto_export", False)),
                    }
                )
                upsert_profile(migrated)
                existing_ids.add(pid)
                log.info("Imported legacy AutoClip profile '%s' into CutFlow.", migrated.name)
        except Exception as exc:
            log.warning("Skipped legacy AutoClip profile import (%s).", exc)

    all_profiles = list_profiles()
    ensure_inbox_folders(all_profiles)
    return all_profiles
