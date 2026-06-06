"""SQLAlchemy persistence layer (mirrors TrendVault-Coder/core/database.py).

SQLite single-file DB at data/app.db. Phase 1 records completed renders (for the
mainframe dashboard later); JSON files in data/ still hold presets/drafts to
keep parity with the Node app's on-disk shapes. More models land in later phases.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from core.constants import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class RenderRecord(Base):
    """One row per render attempt — fuels the mainframe job history."""
    __tablename__ = "render_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(String, index=True)
    folder = Column(String)
    sign = Column(String, nullable=True)
    status = Column(String, default="running")   # running | done | error
    output_file = Column(String, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
