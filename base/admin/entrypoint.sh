#!/bin/sh
set -e

# Run pending Alembic migrations before starting the app.
# `upgrade head` is idempotent — it checks the alembic_version table
# and only applies migrations that haven't run yet.
if [ -f alembic.ini ]; then
    echo "[entrypoint] Running database migrations..."

    # If tables already exist (from a prior create_all) but alembic_version
    # doesn't, stamp the baseline so Alembic doesn't try to re-create them.
    python -c "
import asyncio, os, sys
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

async def check():
    url = os.getenv('SYNESIS_ADMIN_DATABASE_URL', '')
    if not url:
        return
    eng = create_async_engine(url)
    try:
        async with eng.connect() as conn:
            # Check if alembic_version table exists
            r = await conn.execute(text(
                \"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='alembic_version')\"
            ))
            has_alembic = r.scalar()
            if has_alembic:
                return  # Alembic is tracking — normal upgrade will work

            # Check if our tables already exist (created by old create_all)
            r = await conn.execute(text(
                \"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='traces')\"
            ))
            has_tables = r.scalar()
            if has_tables:
                print('[entrypoint] Tables exist but alembic_version missing — stamping baseline')
                # Create alembic_version and stamp to 001 so only 002+ run
                await conn.execute(text('CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)'))
                await conn.execute(text(\"INSERT INTO alembic_version (version_num) VALUES ('001')\"))
                await conn.commit()
    finally:
        await eng.dispose()

asyncio.run(check())
" 2>&1 || echo "[entrypoint] Baseline check skipped (DB may not be reachable)"

    python -m alembic upgrade head 2>&1 || {
        echo "[entrypoint] WARNING: migrations failed (DB may not be reachable yet)"
        echo "[entrypoint] The app will start but some features may be unavailable"
    }
fi

exec "$@"
