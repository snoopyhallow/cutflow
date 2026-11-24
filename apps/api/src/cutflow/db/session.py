"""Database engine, session management, and programmatic Alembic migrations."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .. import paths

_ENGINE: Engine | None = None
_ENGINE_URL: str | None = None
_SESSION_FACTORY: sessionmaker[Session] | None = None


def _configure_sqlite(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA foreign_keys=ON;")
    cursor.close()


def get_engine() -> Engine:
    """Return a cached SQLAlchemy engine, recreating if CUTFLOW_HOME/DATABASE_URL changed."""
    global _ENGINE, _ENGINE_URL, _SESSION_FACTORY
    url = paths.database_url()
    if _ENGINE is not None and url == _ENGINE_URL:
        return _ENGINE

    if _ENGINE is not None:
        _ENGINE.dispose()

    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, future=True)
    if url.startswith("sqlite"):
        event.listen(engine, "connect", _configure_sqlite)

    _ENGINE = engine
    _ENGINE_URL = url
    _SESSION_FACTORY = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return engine


def reset_engine() -> None:
    global _ENGINE, _ENGINE_URL, _SESSION_FACTORY
    if _ENGINE is not None:
        _ENGINE.dispose()
    _ENGINE = None
    _ENGINE_URL = None
    _SESSION_FACTORY = None


@contextmanager
def get_session() -> Iterator[Session]:
    get_engine()
    assert _SESSION_FACTORY is not None
    session = _SESSION_FACTORY()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_db() -> None:
    """Run Alembic migrations to head so schema upgrades are always versioned."""
    from alembic.config import Config

    from alembic import command

    api_root = Path(__file__).resolve().parents[3]
    alembic_ini = api_root / "alembic.ini"
    alembic_dir = api_root / "alembic"

    cfg = Config(str(alembic_ini))
    cfg.set_main_option("script_location", str(alembic_dir))
    cfg.set_main_option("sqlalchemy.url", paths.database_url())
    command.upgrade(cfg, "head")
    get_engine()
