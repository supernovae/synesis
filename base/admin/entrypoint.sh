#!/bin/sh
set -e

# Run pending Alembic migrations before starting the app.
# `upgrade head` is idempotent — it checks the alembic_version table
# and only applies migrations that haven't run yet.
if [ -f alembic.ini ]; then
    echo "[entrypoint] Running database migrations..."

    # If tables already exist (from a prior create_all) but alembic_version
    # doesn't, stamp to head so Alembic doesn't try to re-create them.
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
                # Check if it has any rows (table might exist but be empty)
                r2 = await conn.execute(text('SELECT count(*) FROM alembic_version'))
                if r2.scalar() > 0:
                    return  # Alembic is tracking — normal upgrade path

            # Tables were created by create_all — stamp to head
            r = await conn.execute(text(
                \"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='traces')\"
            ))
            if r.scalar():
                print('[entrypoint] Tables exist without alembic tracking — stamping to head')
                await conn.execute(text('CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)'))
                await conn.execute(text('DELETE FROM alembic_version'))
                # Get the latest revision from the alembic script directory
                from alembic.config import Config
                from alembic.script import ScriptDirectory
                cfg = Config('alembic.ini')
                script = ScriptDirectory.from_config(cfg)
                head = script.get_current_head()
                await conn.execute(text(f\"INSERT INTO alembic_version (version_num) VALUES ('{head}')\"))
                await conn.commit()
                print(f'[entrypoint] Stamped to {head}')
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
