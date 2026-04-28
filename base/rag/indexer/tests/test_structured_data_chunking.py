from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "base" / "images" / "base-api" / "synesis-telemetry"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.handlers.structured_data import MAX_CHUNK_CHARS, chunk_structured_content


def test_oversized_yaml_resource_splits_without_truncation():
    rules = "\n".join(f"  key_{i}: value_{i}" for i in range(900))
    content = f"""apiVersion: v1
kind: ConfigMap
metadata:
  name: large-config
data:
{rules}
"""

    chunks = chunk_structured_content(content, "yaml", "helm/templates/configmap.yaml", "configmap.yaml")

    assert len(chunks) > 1
    assert all(len(chunk.text) <= MAX_CHUNK_CHARS for chunk in chunks)
    assert "key_899" in "\n".join(chunk.text for chunk in chunks)
    assert all(chunk.metadata["content_format"] == "yaml" for chunk in chunks)
    assert all(chunk.metadata["symbol_type"] == "k8s_configmap" for chunk in chunks)


def test_oversized_terraform_block_splits_without_truncation():
    attrs = "\n".join(f'  tag_{i} = "value_{i}"' for i in range(900))
    content = f"""resource "aws_instance" "web" {{
{attrs}
}}
"""

    chunks = chunk_structured_content(content, "hcl", "main.tf", "main.tf")

    assert len(chunks) > 1
    assert all(len(chunk.text) <= MAX_CHUNK_CHARS for chunk in chunks)
    assert "tag_899" in "\n".join(chunk.text for chunk in chunks)
    assert all(chunk.metadata["content_format"] == "hcl" for chunk in chunks)
    assert all(chunk.metadata["symbol_type"] == "hcl_resource" for chunk in chunks)
