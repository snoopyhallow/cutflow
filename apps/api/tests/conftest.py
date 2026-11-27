"""Shared pytest fixtures isolating CUTFLOW_HOME and resetting SQLAlchemy state."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cutflow import app as app_module
from cutflow import db, paths
from cutflow.security import secrets as secrets_module


class _InMemoryKeyring:
    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, key: str) -> str | None:
        return self._store.get((service, key))

    def set_password(self, service: str, key: str, value: str) -> None:
        self._store[(service, key)] = value

    def delete_password(self, service: str, key: str) -> None:
        self._store.pop((service, key), None)


@pytest.fixture(autouse=True)
def _isolate_os_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep pytest completely isolated from the developer's real OS Keyring credentials."""
    mem = _InMemoryKeyring()
    monkeypatch.setattr(secrets_module, "_keyring", lambda: mem)


@pytest.fixture
def cutflow_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    home = tmp_path / "cutflow_home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv(paths.ENV_HOME, str(home))
    monkeypatch.setenv(app_module.ENV_SKIP_LEGACY_IMPORT, "1")
    monkeypatch.setenv(app_module.ENV_DISABLE_WATCHER, "1")
    monkeypatch.delenv(paths.ENV_DB_URL, raising=False)
    monkeypatch.delenv(paths.ENV_INBOX, raising=False)
    db.reset_engine()
    yield home
    db.reset_engine()


@pytest.fixture
def client(cutflow_home: Path) -> Iterator[TestClient]:
    with TestClient(app_module.create_app()) as test_client:
        yield test_client
