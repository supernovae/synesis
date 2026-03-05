"""Parse Fedora License Data (TOML) for Red Hat approval status."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore[no-redef]

logger = logging.getLogger("synesis.indexer.license.fedora")


@dataclass
class FedoraLicenseStatus:
    spdx_id: str
    status: str  # "allowed", "allowed-content", "not-allowed"
    fedora_abbrev: str = ""
    fedora_name: str = ""


def fetch_fedora_license(base_url: str, spdx_id: str) -> FedoraLicenseStatus | None:
    """Fetch a single Fedora license TOML and parse its approval status."""
    url = f"{base_url}{spdx_id}.toml"
    try:
        resp = httpx.get(url, timeout=15, follow_redirects=True)
        resp.raise_for_status()
        data = tomllib.loads(resp.text)

        status = data.get("status", {})
        status_value = "unknown"
        if isinstance(status, dict):
            for key in ("allowed", "allowed-content", "not-allowed"):
                if status.get(key):
                    status_value = key
                    break
        elif isinstance(status, list) and status:
            status_value = str(status[0])

        return FedoraLicenseStatus(
            spdx_id=spdx_id,
            status=status_value,
            fedora_abbrev=data.get("fedora_abbrev", ""),
            fedora_name=data.get("fedora_name", ""),
        )
    except httpx.HTTPStatusError:
        logger.debug(f"Fedora license data not found for {spdx_id}")
        return None
    except Exception as e:
        logger.debug(f"Error parsing Fedora data for {spdx_id}: {e}")
        return None


def fetch_fedora_statuses(
    base_url: str,
    spdx_ids: list[str],
) -> dict[str, FedoraLicenseStatus]:
    """Fetch Fedora approval status for a list of SPDX IDs."""
    results: dict[str, FedoraLicenseStatus] = {}
    for spdx_id in spdx_ids:
        status = fetch_fedora_license(base_url, spdx_id)
        if status:
            results[spdx_id] = status
    logger.info(f"Fetched Fedora status for {len(results)}/{len(spdx_ids)} licenses")
    return results
