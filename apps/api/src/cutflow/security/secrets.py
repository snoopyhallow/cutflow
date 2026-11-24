"""Write-only OS Keyring secret storage (secrets never leave the keyring into API responses)."""

from __future__ import annotations

import contextlib
import logging
import os

log = logging.getLogger(__name__)

KEYRING_SERVICE = "cutflow"
SECRET_KEYS: tuple[str, ...] = ("gemini", "groq", "openai", "anthropic", "huggingface_token")


def _keyring():
    try:
        import keyring
        from keyring.backends.fail import Keyring as FailKeyring
    except ImportError:
        return None
    try:
        if isinstance(keyring.get_keyring(), FailKeyring):
            return None
    except Exception:
        return None
    return keyring


def get_secret(key: str) -> str | None:
    if key not in SECRET_KEYS:
        return None
    env_value = os.environ.get(f"CUTFLOW_{key.upper()}_KEY")
    if env_value:
        return env_value
    kr = _keyring()
    if kr is None:
        return None
    try:
        val = kr.get_password(KEYRING_SERVICE, key)
        return val or None
    except Exception as exc:
        log.warning("Keyring read failed for %s: %s", key, exc)
        return None


def set_secret(key: str, value: str) -> None:
    if key not in SECRET_KEYS:
        raise ValueError(f"Unknown secret key {key!r}. Allowed: {', '.join(SECRET_KEYS)}")
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Secret value cannot be empty.")
    kr = _keyring()
    if kr is None:
        raise RuntimeError(
            "No OS keyring backend is available. Set CUTFLOW_<PROVIDER>_KEY as an env var."
        )
    kr.set_password(KEYRING_SERVICE, key, cleaned)


def delete_secret(key: str) -> None:
    if key not in SECRET_KEYS:
        return
    kr = _keyring()
    if kr is None:
        return
    with contextlib.suppress(Exception):
        kr.delete_password(KEYRING_SERVICE, key)


def keys_presence() -> dict[str, bool]:
    """Return boolean presence per secret key — values are never exposed."""
    return {key: get_secret(key) is not None for key in SECRET_KEYS}
