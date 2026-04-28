from __future__ import annotations

import builtins
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import extract as extract_mod


def test_html_to_markdown_warns_once_when_trafilatura_missing(monkeypatch, caplog):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "trafilatura":
            raise ModuleNotFoundError("No module named 'trafilatura'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setattr(extract_mod, "_TRAFILATURA_EXTRACT", None)

    first = extract_mod.html_to_markdown("<html><body><h1>Title</h1><p>Body</p></body></html>")
    second = extract_mod.html_to_markdown("<html><body><h1>Again</h1><p>More</p></body></html>")

    assert "Title" in first
    assert "Again" in second
    warnings = [record for record in caplog.records if "trafilatura unavailable" in record.message]
    assert len(warnings) == 1
