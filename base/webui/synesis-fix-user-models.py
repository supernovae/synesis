#!/usr/bin/env python3
"""Backfill Synesis Open WebUI defaults on the SQLite PVC.

Open WebUI stores chat default in user.settings JSON (SQLite on PVC). If the UI
validates selected IDs against an empty /models list, it can persist [''].
This runs after pod start (postStart) and waits for webui.db to exist.

It also normalizes noisy task-generation defaults that otherwise create extra
planner calls and trace rows for every chat turn.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time

DB_PATH = "/app/backend/data/webui.db"
WAIT_SECONDS = 90
SLEEP_INTERVAL = 0.5

NO_EMOJI_TITLE_TEMPLATE = """### Task:
Generate a concise, 3-5 word plain-text title summarizing the chat history.
### Guidelines:
- Do not use emoji, icons, markdown, quotation marks, or decorative formatting.
- The title should clearly represent the main theme or subject of the conversation.
- Write the title in the chat's primary language; default to English if multilingual.
- Your entire response must consist solely of the JSON object.
### Output:
JSON format: { "title": "your concise title here" }
### Chat History:
<chat_history>
{{MESSAGES:END:2}}
</chat_history>"""


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


def _configured_title_template() -> str:
    return (os.environ.get("TITLE_GENERATION_PROMPT_TEMPLATE") or NO_EMOJI_TITLE_TEMPLATE).strip()


def _ensure_path(root: dict, path: tuple[str, ...]) -> dict:
    cur = root
    for key in path:
        val = cur.get(key)
        if not isinstance(val, dict):
            val = {}
            cur[key] = val
        cur = val
    return cur


def _upsert_global_task_config(conn: sqlite3.Connection) -> bool:
    cur = conn.execute("SELECT id, data FROM config ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    config_id = row[0] if row else None
    data = _parse_settings(row[1]) if row else {"version": 0, "ui": {}}

    task = _ensure_path(data, ("task",))
    follow_up = _ensure_path(task, ("follow_up",))
    title = _ensure_path(task, ("title",))

    changed = False
    if follow_up.get("enable") is not False:
        follow_up["enable"] = False
        changed = True
    if title.get("enable") is not False:
        title["enable"] = False
        changed = True

    title_template = _configured_title_template()
    if title.get("prompt_template") != title_template:
        title["prompt_template"] = title_template
        changed = True

    if not changed:
        return False

    encoded = json.dumps(data)
    if config_id is None:
        conn.execute("INSERT INTO config (data, version) VALUES (?, ?)", (encoded, int(data.get("version", 0) or 0)))
    else:
        conn.execute("UPDATE config SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (encoded, config_id))
    return True


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

    updated_config = _upsert_global_task_config(conn)
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

    if updated or updated_config:
        conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
