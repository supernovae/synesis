"""Handler: License data from SPDX, Fedora, and choosealicense.com.

Fetches license metadata from multiple sources, builds structured
summary chunks, and optionally includes full license text for
verbatim recall (needed for LICENSE file creation).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx
import yaml

from ..safe_http import get_public_https
from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.license_spdx")

LONG_TEXT_LICENSES = {
    "GPL-2.0-only",
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "LGPL-2.1-only",
    "LGPL-3.0-only",
    "MPL-2.0",
    "GPL-2.0-or-later",
    "GPL-3.0-or-later",
    "AGPL-3.0-or-later",
    "LGPL-2.1-or-later",
    "LGPL-3.0-or-later",
}

MAX_FULL_TEXT_CHUNK = 6000


@dataclass
class _LicenseRecord:
    spdx_id: str
    name: str
    osi_approved: bool
    reference_url: str
    full_text: str
    fedora_status: str
    copyleft: str
    choose_description: str
    choose_permissions: list[str]
    choose_conditions: list[str]
    choose_limitations: list[str]
    choose_how: str


@register
class LicenseSPDXHandler:
    handler_type = "license_spdx"
    source_type = "license"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        """Fetch license data from SPDX, Fedora, and choosealicense.

        The source_config.config should contain paths/URLs for:
        - spdx.licenses_url, spdx.details_base_url
        - fedora.repo_url, fedora.common_licenses
        - choosealicense.repo, choosealicense.branch, choosealicense.licenses_path
        - compat_path (optional, for compatibility rules)
        """
        config = source_config.get("config", {})
        name = source_config.get("name", "SPDX Licenses")

        spdx_cfg = config.get("spdx", {})
        licenses_url = spdx_cfg.get("licenses_url", "")
        details_base = spdx_cfg.get("details_base_url", "")

        if not licenses_url:
            logger.error("license_spdx requires config.spdx.licenses_url")
            return []

        spdx_data = _fetch_spdx(licenses_url, details_base)
        fedora_map = _fetch_fedora_statuses(config.get("fedora", {}))
        choose_map = _fetch_choosealicense(config.get("choosealicense", {}))
        copyleft_map = _load_copyleft(config.get("compat_path", ""))

        records: list[_LicenseRecord] = []
        for lic in spdx_data:
            sid = lic["spdx_id"]
            fedora = fedora_map.get(sid, "unknown")
            choose = choose_map.get(sid, {})
            records.append(
                _LicenseRecord(
                    spdx_id=sid,
                    name=lic["name"],
                    osi_approved=lic.get("osi_approved", False),
                    reference_url=lic.get("reference_url", ""),
                    full_text=lic.get("full_text", ""),
                    fedora_status=fedora,
                    copyleft=copyleft_map.get(sid, "unknown"),
                    choose_description=choose.get("description", ""),
                    choose_permissions=choose.get("permissions", []),
                    choose_conditions=choose.get("conditions", []),
                    choose_limitations=choose.get("limitations", []),
                    choose_how=choose.get("how", ""),
                )
            )

        # Pack all license records into a single RawDocument with metadata
        return [
            RawDocument(
                doc_id=f"license:{name}",
                name=name,
                content="",  # content is in metadata
                source_url="https://spdx.org/licenses/",
                metadata={"records": records, "compat_path": config.get("compat_path", "")},
            )
        ]

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        records: list[_LicenseRecord] = doc.metadata.get("records", [])
        compat_path = doc.metadata.get("compat_path", "")
        chunks: list[Chunk] = []
        idx = 0

        for rec in records:
            summary = _build_summary(rec)
            tags = _build_tags(rec)
            chunks.append(
                Chunk(
                    text=summary,
                    section=f"License: {rec.spdx_id}",
                    heading_path=f"Licenses > {rec.spdx_id}",
                    chunk_index=idx,
                    metadata={
                        "tags": tags,
                        "source_url": rec.reference_url,
                    },
                )
            )
            idx += 1

            if rec.full_text and rec.spdx_id in LONG_TEXT_LICENSES:
                for part in _split_full_text(rec.full_text, rec.spdx_id):
                    chunks.append(
                        Chunk(
                            text=part,
                            section=f"{rec.spdx_id} (full text)",
                            heading_path=f"Licenses > {rec.spdx_id} > Full Text",
                            chunk_index=idx,
                            metadata={
                                "tags": f"spdx:{rec.spdx_id} fulltext:true {tags}"[:512],
                                "source_url": rec.reference_url,
                            },
                        )
                    )
                    idx += 1

        # Compatibility rules
        if compat_path:
            compat_chunks = _build_compat_chunks(compat_path, idx)
            chunks.extend(compat_chunks)

        logger.info("Produced %d license chunks", len(chunks))
        return chunks


def _build_summary(rec: _LicenseRecord) -> str:
    parts = [
        f"License: {rec.name} (SPDX: {rec.spdx_id})",
        f"OSI Approved: {'Yes' if rec.osi_approved else 'No'}",
        f"Copyleft: {rec.copyleft}",
    ]
    if rec.fedora_status != "unknown":
        parts.append(f"Red Hat / Fedora Status: {rec.fedora_status}")
    if rec.choose_description:
        parts.append(f"Description: {rec.choose_description}")
    if rec.choose_permissions:
        parts.append(f"Permissions: {', '.join(rec.choose_permissions)}")
    if rec.choose_conditions:
        parts.append(f"Conditions: {', '.join(rec.choose_conditions)}")
    if rec.choose_limitations:
        parts.append(f"Limitations: {', '.join(rec.choose_limitations)}")
    if rec.choose_how:
        parts.append(f"How to apply: {rec.choose_how}")
    return "\n".join(parts)


def _build_tags(rec: _LicenseRecord) -> str:
    parts = [f"spdx:{rec.spdx_id}", f"osi:{str(rec.osi_approved).lower()}"]
    parts.append(f"copyleft:{rec.copyleft[:16]}")
    if rec.fedora_status != "unknown":
        parts.append(f"rh:{rec.fedora_status[:24]}")
    return " ".join(parts)[:512]


def _split_full_text(text: str, spdx_id: str) -> list[str]:
    if len(text) <= MAX_FULL_TEXT_CHUNK:
        return [text] if text.strip() else []

    chunks: list[str] = []
    paragraphs = text.split("\n\n")
    current = f"[{spdx_id} full text continued]\n\n"

    for para in paragraphs:
        if len(current) + len(para) + 2 > MAX_FULL_TEXT_CHUNK:
            if current.strip():
                chunks.append(current.strip())
            current = f"[{spdx_id} full text continued]\n\n{para}\n\n"
        else:
            current += para + "\n\n"

    if current.strip():
        chunks.append(current.strip())
    return chunks


def _build_compat_chunks(compat_path: str, start_idx: int) -> list[Chunk]:
    """Load compatibility rules from YAML and build chunks."""
    try:
        from pathlib import Path

        path = Path(compat_path)
        if not path.exists():
            return []
        with open(path) as f:
            data = yaml.safe_load(f)
        rules = data.get("rules", [])
    except Exception as e:
        logger.warning("Failed to load compat rules: %s", e)
        return []

    chunks: list[Chunk] = []
    idx = start_idx
    for rule in rules:
        from_lic = rule.get("from", "")
        to_lic = rule.get("to", "")
        compatible = rule.get("compatible", "")
        note = rule.get("note", "")
        text = f"License Compatibility: {from_lic} -> {to_lic}\nCompatible: {compatible}\nNote: {note}"
        chunks.append(
            Chunk(
                text=text,
                section=f"Compatibility: {from_lic} -> {to_lic}",
                heading_path=f"License Compatibility > {from_lic} > {to_lic}",
                chunk_index=idx,
                metadata={"tags": f"compat {from_lic}->{to_lic}"},
            )
        )
        idx += 1

    return chunks


# --- Data fetching helpers ---


def _fetch_spdx(licenses_url: str, details_base: str) -> list[dict]:
    """Fetch SPDX license list and optionally full text."""
    if not licenses_url:
        return []
    try:
        data = get_public_https(licenses_url, timeout=30).json()
    except Exception as e:
        logger.error("Failed to fetch SPDX licenses: %s", e)
        return []

    licenses = []
    for lic in data.get("licenses", []):
        record = {
            "spdx_id": lic.get("licenseId", ""),
            "name": lic.get("name", ""),
            "osi_approved": lic.get("isOsiApproved", False),
            "reference_url": lic.get("reference", ""),
            "full_text": "",
        }
        if details_base and record["spdx_id"]:
            try:
                detail_url = f"{details_base}{record['spdx_id']}.json"
                dresp = get_public_https(detail_url, timeout=15)
                if dresp.status_code == 200:
                    record["full_text"] = dresp.json().get("licenseText", "")
            except Exception:  # nosec B110
                pass
        licenses.append(record)

    return licenses


def _fetch_fedora_statuses(fedora_cfg: dict) -> dict[str, str]:
    """Fetch Fedora license statuses. Returns {spdx_id: status}."""
    repo_url = fedora_cfg.get("repo_url", "")
    common = fedora_cfg.get("common_licenses", [])
    if not repo_url or not common:
        return {}

    statuses: dict[str, str] = {}
    for spdx_id in common:
        try:
            url = f"{repo_url}{spdx_id}.toml"
            resp = get_public_https(url, timeout=10)
            if resp.status_code == 200:
                for line in resp.text.splitlines():
                    if line.startswith("status"):
                        statuses[spdx_id] = line.split("=", 1)[-1].strip().strip('"')
                        break
        except Exception:  # nosec B110
            pass

    return statuses


def _fetch_choosealicense(choose_cfg: dict) -> dict[str, dict]:
    """Fetch choosealicense.com license data. Returns {spdx_id: data}."""
    repo = choose_cfg.get("repo", "")
    branch = choose_cfg.get("branch", "gh-pages")
    licenses_path = choose_cfg.get("licenses_path", "_licenses")
    if not repo:
        return {}

    try:
        owner, name = repo.split("/", 1)
        url = f"https://api.github.com/repos/{owner}/{name}/git/trees/{branch}?recursive=1"
        with httpx.Client(timeout=30) as client:
            resp = client.get(url)
            resp.raise_for_status()
            trees = resp.json().get("tree", [])
    except Exception as e:
        logger.warning("Failed to list choosealicense files: %s", e)
        return {}

    result: dict[str, dict] = {}
    for item in trees:
        p = item.get("path", "")
        if not p.startswith(f"{licenses_path}/") or not p.endswith(".txt"):
            continue
        try:
            raw_url = f"https://raw.githubusercontent.com/{repo}/{branch}/{p}"
            with httpx.Client(timeout=10) as client:
                resp = client.get(raw_url)
                if resp.status_code != 200:
                    continue
                content = resp.text

            # Parse YAML frontmatter
            if content.startswith("---"):
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    meta = yaml.safe_load(parts[1])
                    if isinstance(meta, dict) and meta.get("spdx-id"):
                        spdx_id = meta["spdx-id"]
                        result[spdx_id] = {
                            "description": meta.get("description", ""),
                            "permissions": meta.get("permissions", []),
                            "conditions": meta.get("conditions", []),
                            "limitations": meta.get("limitations", []),
                            "how": meta.get("how", ""),
                        }
        except Exception:  # nosec B112
            continue

    return result


def _load_copyleft(compat_path: str) -> dict[str, str]:
    """Load copyleft classification from compatibility YAML."""
    if not compat_path:
        return {}
    try:
        from pathlib import Path

        path = Path(compat_path)
        if not path.exists():
            return {}
        with open(path) as f:
            data = yaml.safe_load(f)
        return data.get("copyleft", {})
    except Exception:
        return {}
