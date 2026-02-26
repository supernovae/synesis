"""Parse choosealicense.com license data for permissions/conditions/limitations."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger("synesis.indexer.license.choosealicense")


@dataclass
class ChoosealicenseData:
    spdx_id: str
    title: str = ""
    description: str = ""
    how: str = ""
    permissions: list[str] = field(default_factory=list)
    conditions: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)


_YAML_FRONT_MATTER = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


def _parse_yaml_front_matter(content: str) -> dict:
    """Extract YAML front matter from a Jekyll file."""
    import yaml
    match = _YAML_FRONT_MATTER.match(content)
    if not match:
        return {}
    try:
        return yaml.safe_load(match.group(1)) or {}
    except Exception:
        return {}


def fetch_choosealicense_licenses(
    repo: str,
    branch: str,
    licenses_path: str,
) -> list[ChoosealicenseData]:
    """Fetch license files from the choosealicense.com GitHub repo."""
    api_url = f"https://api.github.com/repos/{repo}/contents/{licenses_path}?ref={branch}"
    try:
        resp = httpx.get(api_url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        files = resp.json()
    except Exception as e:
        logger.warning(f"Could not list choosealicense files: {e}")
        return []

    results: list[ChoosealicenseData] = []
    for f in files:
        if not f.get("name", "").endswith(".txt"):
            continue

        raw_url = f.get("download_url", "")
        if not raw_url:
            continue

        try:
            file_resp = httpx.get(raw_url, timeout=15, follow_redirects=True)
            file_resp.raise_for_status()
            meta = _parse_yaml_front_matter(file_resp.text)
        except Exception as e:
            logger.debug(f"Could not fetch {f['name']}: {e}")
            continue

        if not meta:
            continue

        data = ChoosealicenseData(
            spdx_id=meta.get("spdx-id", ""),
            title=meta.get("title", ""),
            description=meta.get("description", ""),
            how=meta.get("how", ""),
            permissions=meta.get("permissions", []) or [],
            conditions=meta.get("conditions", []) or [],
            limitations=meta.get("limitations", []) or [],
        )
        if data.spdx_id:
            results.append(data)

    logger.info(f"Parsed {len(results)} licenses from choosealicense.com")
    return results
