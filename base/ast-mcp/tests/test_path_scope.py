from pathlib import Path

import pytest
from app.server import resolve_allowed_file_path


def test_resolve_allowed_file_path_accepts_path_under_allowed_root(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    target = src / "app.py"
    target.write_text("def ok():\n    return True\n", encoding="utf-8")

    resolved = resolve_allowed_file_path(str(target), [tmp_path])

    assert resolved == target.resolve()


def test_resolve_allowed_file_path_rejects_sibling_path(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    sibling = tmp_path / "sibling.py"
    sibling.write_text("def nope():\n    return False\n", encoding="utf-8")

    with pytest.raises(ValueError, match="file_path_outside_allowed_roots"):
        resolve_allowed_file_path(str(sibling), [allowed])


def test_resolve_allowed_file_path_rejects_traversal_outside_root(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("def nope():\n    return False\n", encoding="utf-8")

    with pytest.raises(ValueError, match="file_path_outside_allowed_roots"):
        resolve_allowed_file_path(str(allowed / ".." / "outside.py"), [allowed])
