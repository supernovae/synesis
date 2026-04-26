from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schema import EMBEDDING_DIM
from app.synpack import SynPackError, validate_synpack


def _write_pack(path: Path, manifest: dict, row: dict | None = None) -> None:
    row = row or {
        "text": "Package fmt implements formatted I/O.",
        "source_url": "https://pkg.go.dev/fmt",
        "embedding": [0.0] * EMBEDDING_DIM,
    }
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("metadata.jsonl", json.dumps(row) + "\n")


def test_validate_synpack_accepts_bge_m3_manifest(tmp_path: Path):
    pack = tmp_path / "go.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "Go 1.26",
            "pack_version": "1.0.0",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": EMBEDDING_DIM,
            "synesis_catalog_schema_version": 17,
        },
    )

    manifest = validate_synpack(pack)

    assert manifest["pack_id"] == "go-1-26"
    assert manifest["embedding_model"] == "BAAI/bge-m3"


def test_validate_synpack_rejects_dimension_mismatch(tmp_path: Path):
    pack = tmp_path / "bad.synpack"
    _write_pack(
        pack,
        {
            "pack_id": "go-1.26",
            "embedding_model": "BAAI/bge-m3",
            "embedding_dimensions": 384,
            "synesis_catalog_schema_version": 17,
        },
    )

    with pytest.raises(SynPackError, match="dimension mismatch"):
        validate_synpack(pack)
