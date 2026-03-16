"""Build Open WebUI Functions export JSON for Synesis Progress Pipe.

Usage:
  python build_export.py
"""

from __future__ import annotations

import json
from pathlib import Path


def main() -> None:
    here = Path(__file__).resolve().parent
    pipe_path = here / "pipe.py"
    out_path = here / "synesis_progress_export.json"

    pipe_code = pipe_path.read_text(encoding="utf-8")

    # Open WebUI export envelope for function import.
    payload = {
        "version": "1.0",
        "functions": [
            {
                "id": "synesis-progress-pipe",
                "name": "Synesis Progress Pipe",
                "type": "pipe",
                "content": pipe_code,
            }
        ],
    }

    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
