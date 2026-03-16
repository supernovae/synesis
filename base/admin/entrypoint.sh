#!/bin/sh
set -e

# Run pending Alembic migrations before starting the app.
# `upgrade head` is idempotent — it checks the alembic_version table
# and only applies migrations that haven't run yet.
if [ -f alembic.ini ]; then
    echo "[entrypoint] Running database migrations..."
    python -m alembic upgrade head 2>&1 || {
        echo "[entrypoint] WARNING: migrations failed (DB may not be reachable yet)"
        echo "[entrypoint] The app will start but some features may be unavailable"
    }
fi

exec "$@"
