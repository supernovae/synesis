#!/usr/bin/env python3
"""Check relative Markdown links in maintained documentation and repo guidance."""

import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    errors = []
    checked = 0
    for name in tracked:
        path = ROOT / name
        if path.suffix.lower() not in {".md", ".mdc"} or not path.is_file() or name.startswith(".agents/"):
            continue
        # Literal examples inside fenced blocks are not documentation links.
        content = re.sub(r"^```[^\n]*\n.*?^```[^\n]*$", "", path.read_text(), flags=re.M | re.S)
        for raw in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", content):
            target = raw.strip().split(' "', 1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path or parsed.path.startswith("/"):
                continue
            checked += 1
            if not (path.parent / unquote(parsed.path)).exists():
                errors.append(f"{name}: missing link target {target}")
    for error in errors:
        print(error)
    print(f"Checked {checked} local links; {len(errors)} missing targets.")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
