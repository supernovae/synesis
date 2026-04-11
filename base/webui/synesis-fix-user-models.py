#!/usr/bin/env python3
"""Backfill Open WebUI per-user ui.models / ui.pinnedModels when missing or empty.

Open WebUI stores chat default in user.settings JSON (SQLite on PVC). If the UI
validates selected IDs against an empty /models list, it can persist [''].
This runs after pod start (postStart) and waits for webui.db to exist.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time

DB_PATH = "/app/backend/data/webui.db"
WAIT_SECONDS = 90
SLEEP_INTERVAL = 0.5


def _default_chat_models() -> list[str]:
    raw = (os.environ.get("DEFAULT_MODELS") or "Synesis Auto").strip()
    if not raw:
        return ["Synesis Auto"]
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts if parts else ["Synesis Auto"]


def _pinned_models() -> list[str]:
    raw = (os.environ.get("DEFAULT_PINNED_MODELS") or "").strip()
    if not raw:
        return [
            "Synesis Auto",
            "Synesis Pulse",
            "Synesis Core",
            "Synesis Horizon",
        ]
    return [p.strip() for p in raw.split(",") if p.strip()]


def _needs_models_fix(models: object) -> bool:
    if models is None:
        return True
    if not isinstance(models, list):
        return True
    if len(models) == 0:
        return True
    return all(m == "" or m is None for m in models)


def _parse_settings(raw: object) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return {}


def main() -> None:
    deadline = time.time() + WAIT_SECONDS
    while not os.path.isfile(DB_PATH) and time.time() < deadline:
        time.sleep(SLEEP_INTERVAL)
    if not os.path.isfile(DB_PATH):
        return

    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    try:
        cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='user'")
        if not cur.fetchone():
            return
        rows = conn.execute("SELECT id, settings FROM user").fetchall()
    except sqlite3.OperationalError:
        return

    chat_defaults = _default_chat_models()
    pins = _pinned_models()
    primary = chat_defaults[0] if chat_defaults else "Synesis Auto"

    updated = 0
    for uid, settings_raw in rows:
        settings = _parse_settings(settings_raw)
        ui = settings.get("ui")
        if not isinstance(ui, dict):
            ui = {}
        changed = False

        if _needs_models_fix(ui.get("models")):
            ui["models"] = [primary]
            changed = True

        pins_val = ui.get("pinnedModels")
        if "pinnedModels" not in ui or pins_val is None:
            ui["pinnedModels"] = pins
            changed = True

        if changed:
            settings["ui"] = ui
            conn.execute(
                "UPDATE user SET settings = ? WHERE id = ?",
                (json.dumps(settings), uid),
            )
            updated += 1

    if updated:
        conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
