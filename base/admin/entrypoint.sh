#!/bin/sh
set -e

# Run pending Alembic migrations before starting the app.
# `upgrade head` is idempotent — it checks the alembic_version table
# and only applies migrations that haven't run yet.
# Migrations themselves check table existence before CREATE, so even
# partially-stamped databases are handled correctly.
if [ -f alembic.ini ]; then
    echo "[entrypoint] Running database migrations..."

    # If tables already exist (from a prior create_all) but alembic_version
    # doesn't exist, create it and stamp to the EARLIEST migration so that
    # `alembic upgrade head` runs all migrations (each one checks table
    # existence before CREATE, so re-runs are safe).
    python -c "
import asyncio, os
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

async def check():
    url = os.getenv('SYNESIS_ADMIN_DATABASE_URL', '')
    if not url:
        return
    eng = create_async_engine(url)
    try:
        async with eng.connect() as conn:
            r = await conn.execute(text(
                \"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='alembic_version')\"
            ))
            has_alembic = r.scalar()

            if has_alembic:
                r2 = await conn.execute(text('SELECT version_num FROM alembic_version LIMIT 1'))
                row = r2.first()
                if row:
                    return  # Alembic is tracking — let upgrade handle it

            # No alembic_version or empty — check if tables were created by create_all
            r = await conn.execute(text(
                \"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='traces')\"
            ))
            if r.scalar():
                print('[entrypoint] Tables exist without alembic tracking — stamping to 001')
                await conn.execute(text('CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)'))
                await conn.execute(text('DELETE FROM alembic_version'))
                await conn.execute(text(\"INSERT INTO alembic_version (version_num) VALUES ('001')\"))
                await conn.commit()
                print('[entrypoint] Stamped to 001 — alembic upgrade will apply remaining migrations')
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
