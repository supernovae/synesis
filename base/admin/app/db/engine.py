"""Async SQLAlchemy engine and session factory."""

from __future__ import annotations

import os

from app.config_safety import require_production_database_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

DATABASE_URL = os.getenv(
    "SYNESIS_ADMIN_DATABASE_URL",
    "postgresql+asyncpg://app:changeme@synesis-admin-db-rw.synesis-admin.svc:5432/synesis_admin",
)
require_production_database_url("SYNESIS_ADMIN_DATABASE_URL", DATABASE_URL)

engine = create_async_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    echo=False,
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncSession:  # type: ignore[misc]
    async with async_session() as session:
        yield session
