"""Persisted non-secret settings for CutFlow."""

from __future__ import annotations

import json
import logging
import os
from typing import Literal

from pydantic import BaseModel, Field

from . import paths

log = logging.getLogger(__name__)

ProviderName = Literal["gemini", "openai", "anthropic", "ollama"]


class ProviderConfig(BaseModel):
    model: str = ""
    base_url: str | None = None


class ModelRoutingSettings(BaseModel):
    """Optional dual-model routing (fast scan model vs smarter Co-Editor/Vision model)."""

    active_provider: ProviderName = "gemini"
    scan_model: str = "gemini-3.5-flash-lite"
    editor_model: str = "gemini-3.5-flash-lite"
    providers: dict[str, ProviderConfig] = Field(
        default_factory=lambda: {
            "gemini": ProviderConfig(model="gemini-3.5-flash-lite"),
            "openai": ProviderConfig(model="gpt-4o-mini"),
            "anthropic": ProviderConfig(model="claude-sonnet-4-5"),
            "ollama": ProviderConfig(model="", base_url="http://127.0.0.1:11434"),
        }
    )


class AlignmentSettings(BaseModel):
    whisper_model: str = "medium"
    language: str = ""
    forced_aligner: Literal["auto", "stable_ts", "onset_only"] = "auto"
    no_speech_threshold: float = 0.8
    log_prob_threshold: float = -1.2


class StorageSettings(BaseModel):
    custom_data_dir: str = ""
    inbox_dir: str = ""
    hardlink_inbox_drops: bool = True


class ExportDefaults(BaseModel):
    ratio: Literal["9:16", "1:1", "16:9"] = "9:16"
    quality: Literal["720p", "1080p", "1440p", "4k"] = "1080p"
    speed_preset: Literal["draft", "final"] = "final"
    loudness_lufs: float = -14.0
    prefer_hardware_encoder: bool = True
    censor_profanity: bool = True
    burn_captions: bool = True
    editor_boundaries: str = ""


class Settings(BaseModel):
    models: ModelRoutingSettings = Field(default_factory=ModelRoutingSettings)
    alignment: AlignmentSettings = Field(default_factory=AlignmentSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    export: ExportDefaults = Field(default_factory=ExportDefaults)

    model_config = {"extra": "ignore"}


def load() -> Settings:
    path = paths.config_path()
    if not path.exists():
        return Settings()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return Settings.model_validate(raw)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        log.warning("Could not load %s (%s); using defaults.", path, exc)
        return Settings()


def save(settings: Settings) -> Settings:
    paths.ensure_layout()
    path = paths.config_path()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(settings.model_dump(mode="json"), indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return settings
