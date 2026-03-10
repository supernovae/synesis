#!/usr/bin/env python3
"""Build synesis_feedback_export.json for Open WebUI Import Functions."""

import json
from pathlib import Path

PLUGIN_DIR = Path(__file__).parent
PY_FILE = PLUGIN_DIR / "synesis_feedback.py"
OUT_FILE = PLUGIN_DIR / "synesis_feedback_export.json"


def main():
    content = PY_FILE.read_text()
    export = [
        {
            "name": "Synesis Feedback",
            "meta": {
                "description": "View Synesis classifier feedback (thumbs up/down) with classification context for tuning.",
                "manifest": {
                    "title": "Synesis Feedback Dashboard",
                    "author": "Synesis",
                    "required_open_webui_version": "0.2.0",
                    "requirements": ["httpx"],
                    "version": "0.1.0",
                },
                "type": "pipe",
            },
            "content": content,
            "id": "synesisfeedback",
            "userId": "",
        }
    ]
    OUT_FILE.write_text(json.dumps(export, indent=2))
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
