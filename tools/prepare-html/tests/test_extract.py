from __future__ import annotations

import hashlib
import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import extract as extract_mod

FIXTURE = ROOT / "examples/source-pack/saved-guide.html"


def test_converter_preserves_code_links_and_tables_without_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("Saved HTML must not resolve or connect to a network")

    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    text = extract_mod.html_to_markdown(FIXTURE.read_text())
    assert "readPinnedSource" in text
    assert "close" in text and "Search" in text and "Home" in text
    assert "Recover source text" in text
    assert "https://example.invalid/source" in text
    assert "must-not-run" not in text


def test_saved_html_records_original_identity_and_refuses_overwrite(tmp_path):
    source = tmp_path / "input.html"
    source.write_bytes(FIXTURE.read_bytes())
    output = tmp_path / "derived.md"
    result = extract_mod.extract_saved_html(str(tmp_path), source.name, str(output))
    assert result["sourceSha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result["outputSha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert result["sourcePath"] == "input.html"
    assert result["kind"] == "derived-html"
    assert output.stat().st_mode & 0o777 == 0o600
    assert "sourceSha256" in output.read_text()
    original = output.read_bytes()
    with pytest.raises(FileExistsError):
        extract_mod.extract_saved_html(str(tmp_path), source.name, str(output))
    assert output.read_bytes() == original


@pytest.mark.parametrize("path", ["../outside.html", "/outside.html", "a/../input.html", "./input.html"])
def test_saved_html_rejects_ambiguous_or_escaping_paths(tmp_path, path):
    with pytest.raises(ValueError):
        extract_mod.extract_saved_html(str(tmp_path), path, str(tmp_path / "output.md"))


def test_saved_html_rejects_symlinks_binary_and_oversized_inputs(tmp_path):
    source = tmp_path / "source.html"
    source.write_bytes(FIXTURE.read_bytes())
    link = tmp_path / "link.html"
    link.symlink_to(source)
    with pytest.raises(ValueError, match="Symlinks"):
        extract_mod.extract_saved_html(str(tmp_path), link.name, str(tmp_path / "out.md"))
    source.write_bytes(b"\xff")
    with pytest.raises(UnicodeError):
        extract_mod.extract_saved_html(str(tmp_path), source.name, str(tmp_path / "out.md"))
    with source.open("wb") as stream:
        stream.truncate(8 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match="8 MiB"):
        extract_mod.extract_saved_html(str(tmp_path), source.name, str(tmp_path / "out.md"))
    assert not (tmp_path / "out.md").exists()


def test_saved_html_round_trip_through_real_pack_cli(tmp_path):
    cli = ROOT / "packages/synesis-mcp/dist/cli.js"
    if not cli.exists():
        pytest.fail("Build the local reader with npm run build before this integration test")
    source = tmp_path / "source.html"
    source.write_bytes(FIXTURE.read_bytes())
    generated = tmp_path / "derived.md"
    extraction = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools/prepare-html/extract.py"),
            "--root",
            str(tmp_path),
            "--input",
            source.name,
            "--output",
            str(generated),
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
    )
    provenance = json.loads(extraction.stdout)
    config = tmp_path / "pack.json"
    config.write_text(
        json.dumps(
            {
                "id": "saved-guide",
                "version": "1.0",
                "title": "Saved guide",
                "sourceRevision": provenance["sourceSha256"],
                "attribution": "Synesis contributors",
                "license": "Apache-2.0",
                "files": ["derived.md"],
            }
        )
    )

    def node(*args):
        result = subprocess.run(
            ["node", str(cli), *args], cwd=tmp_path, text=True, capture_output=True, timeout=15, check=True
        )
        return json.loads(result.stdout)

    archive = str(tmp_path / "guide.synpack")
    library = str(tmp_path / "library")
    node("build", str(config), "--root", str(tmp_path), "--output", archive)
    node("import", archive, "--library", library)
    evidence = node("read", "--library", library, "--pack", "saved-guide", "--version", "1.0", "--path", "derived.md")
    assert evidence["text"] == generated.read_text()
    assert evidence["sha256"] == provenance["outputSha256"]
    assert evidence["sourceRevision"] == provenance["sourceSha256"]
    assert evidence["citation"] == "synpack:saved-guide@1.0/derived.md#L1"
