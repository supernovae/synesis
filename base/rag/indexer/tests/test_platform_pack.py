from __future__ import annotations

import json
import struct
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import nornic_bulk_importer, platform_pack
from app.schema import EMBEDDING_DIM, GRAPH_EDGE_TYPES
from app.synpack import validate_synpack


def test_extract_openshift_platform_pack_builds_resource_schema_and_risk_graph():
    config = platform_pack._load_yaml(ROOT / "base/rag/pack-configs/platform/openshift.yaml")

    chunks, nodes, edges, sources_lock = platform_pack.extract_platform_pack(
        platform="openshift",
        config=config,
        pack_id="openshift-latest",
        pack_version="1.0.0",
        source_version="4.16",
    )

    resource_names = {node["name"] for node in nodes["ResourceKind"]}
    assert {"Deployment", "Pod", "Role", "Route", "SecurityContextConstraints"}.issubset(resource_names)
    assert any(node["field_path"] == "spec.selector" for node in nodes["SchemaProperty"])
    assert any(node["constraint_type"] == "immutable_selector" for node in nodes["PlatformConstraint"])
    assert any(node["name"] == "route-tls-mismatch" for node in nodes["RiskPattern"])
    assert any("oc adm policy who-can" in node["command"] for node in nodes["PlatformCommand"])
    assert any(edge["type"] == "HAS_FIELD" for edge in edges)
    assert any(edge["type"] == "VALIDATED_BY" for edge in edges)
    assert {edge["type"] for edge in edges}.issubset(set(GRAPH_EDGE_TYPES))
    assert sources_lock["resource_kind_count"] >= 5
    assert chunks


def test_build_platform_pack_from_openshift_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    class FakeEmbedClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def embed_texts(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] * EMBEDDING_DIM for _ in texts]

    monkeypatch.setattr(platform_pack, "EmbedClient", FakeEmbedClient)
    out = tmp_path / "openshift.synpack"

    result = platform_pack.build_platform_pack(
        platform="openshift",
        output_path=out,
        pack_config=ROOT / "base/rag/pack-configs/platform/openshift.yaml",
        skip_enrichment=True,
    )

    assert result["ok"] is True
    manifest = validate_synpack(out)
    assert manifest["pack_id"] == "openshift-latest"
    with zipfile.ZipFile(out) as zf:
        names = set(zf.namelist())
        assert "nodes/resource_kinds.jsonl" in names
        assert "nodes/schema_properties.jsonl" in names
        assert "nodes/platform_commands.jsonl" in names
        assert "nodes/pack_manifest.jsonl" in names
        pack_manifest = json.loads(zf.read("nodes/pack_manifest.jsonl"))
        quality = json.loads(zf.read("quality/report.json"))
    assert pack_manifest["kind"] == "PackManifest"
    assert pack_manifest["pack_id"] == "openshift-latest"
    assert pack_manifest["node_count"] == quality["node_count"]
    assert pack_manifest["edge_count"] == quality["edge_count"]
    assert pack_manifest["quality_score"] > 0
    assert quality["node_counts_by_kind"]["ResourceKind"] >= 5
    assert quality["node_counts_by_kind"]["ValidationRecipe"] >= 5
    assert quality["dangling_edge_count"] == 0


def test_bulk_importer_loads_platform_node_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pack = tmp_path / "platform.synpack"
    vector = [0.0] * EMBEDDING_DIM
    manifest = {
        "pack_id": "openshift-latest",
        "pack_version": "1.0.0",
        "embedding_model": "BAAI/bge-m3",
        "embedding_dimensions": EMBEDDING_DIM,
        "synesis_catalog_schema_version": 17,
        "requires_bulk_import": True,
        "node_count": 3,
        "chunk_count": 1,
        "edge_count": 1,
    }
    chunk = {
        "id": "chunk-1",
        "chunk_id": "chunk-1",
        "kind": "Chunk",
        "text": "OpenShift Route exposes a service.",
        "doc_id": "doc-1",
        "pack_id": "openshift-latest",
        "domain": "openshift",
    }
    resource = {
        "id": "openshift-latest:resource:route.openshift.io.v1.Route",
        "kind": "ResourceKind",
        "name": "Route",
        "pack_id": "openshift-latest",
        "platform": "openshift",
    }
    recipe = {
        "id": "openshift-latest:validation:server-dry-run",
        "kind": "ValidationRecipe",
        "name": "server-dry-run",
        "pack_id": "openshift-latest",
        "platform": "openshift",
    }
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("nodes/chunks.jsonl", json.dumps(chunk) + "\n")
        zf.writestr("nodes/resource_kinds.jsonl", json.dumps(resource) + "\n")
        zf.writestr("nodes/validation_recipes.jsonl", json.dumps(recipe) + "\n")
        zf.writestr(
            "edges/validated_by.jsonl",
            json.dumps({"type": "VALIDATED_BY", "source_id": resource["id"], "target_id": recipe["id"]}) + "\n",
        )
        zf.writestr(
            "vectors/index.json",
            json.dumps(
                {
                    "format": "synpack-v2-vectors",
                    "dtype": "float32",
                    "dimensions": EMBEDDING_DIM,
                    "count": 1,
                    "rows": [{"chunk_id": "chunk-1", "offset": 0}],
                }
            ),
        )
        zf.writestr("vectors/chunks.f32", struct.pack(f"<{EMBEDDING_DIM}f", *vector))
        zf.writestr(
            "quality/report.json",
            json.dumps({"node_count": 3, "chunk_count": 1, "edge_count": 1, "dangling_edge_count": 0}),
        )

    written_nodes: list[dict] = []
    written_edges: list[dict] = []

    class FakeWriter:
        def __init__(self, uri: str = ""):
            self.uri = uri
            self.client = self

        def close(self) -> None:
            return None

        def suspend_unique_constraint(self) -> None:
            return None

        def restore_unique_constraint(self) -> None:
            return None

        def delete_pack(self, pack_id: str) -> int:
            return 0

        def bulk_upsert_nodes(
            self, rows: list[dict], *, create_only: bool = False, batch_size: int | None = None
        ) -> int:
            written_nodes.extend(rows)
            return len(rows)

        def upsert_edges(self, edges: list[dict]) -> int:
            written_edges.extend(edges)
            return len(edges)

        def pack_counts(self, pack_id: str) -> dict:
            return {
                "node_count": len(written_nodes),
                "chunk_count": sum(1 for node in written_nodes if node.get("kind") == "Chunk"),
                "embedding_count": sum(1 for node in written_nodes if node.get("embedding")),
                "edge_count": len(written_edges),
                "node_counts_by_kind": {},
            }

    monkeypatch.setattr(nornic_bulk_importer, "NornicGraphWriter", FakeWriter)
    monkeypatch.setattr(nornic_bulk_importer, "ensure_synesis_catalog", lambda client: client)

    result = nornic_bulk_importer.bulk_load_synpack(pack, replace=True)

    assert result["nodes"] == 3
    assert {node["kind"] for node in written_nodes} == {"Chunk", "ResourceKind", "ValidationRecipe"}
    assert written_edges[0]["type"] == "VALIDATED_BY"
