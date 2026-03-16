"""Build Open WebUI Functions import JSON for Synesis Progress Pipe.

Usage:
  python build_export.py
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path


def main() -> None:
    here = Path(__file__).resolve().parent
    pipe_path = here / "pipe.py"
    out_path = here / "synesis_progress_export.json"

    pipe_code = pipe_path.read_text(encoding="utf-8")

    # Open WebUI import format: list of flattened function records.
    # Keep id/userId as hex (no dashes) to avoid parser edge cases seen in
    # some Open WebUI builds when importing JSON from third-party sources.
    function_id = uuid.uuid4().hex
    user_id = uuid.uuid4().hex
    payload = [
        {
            "id": function_id,
            "userId": user_id,
            "name": "Synesis Progress Pipe",
            "meta": {
                "description": "Proxy Synesis planner SSE and mirror progress phases into chat.",
                "manifest": {},
                "type": "pipe",
            },
            "content": pipe_code,
        }
    ]

    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
