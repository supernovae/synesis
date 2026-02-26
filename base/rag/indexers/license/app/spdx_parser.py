"""Parse the SPDX License List JSON into structured license records."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger("synesis.indexer.license.spdx")


@dataclass
class SPDXLicense:
    spdx_id: str
    name: str
    osi_approved: bool = False
    deprecated: bool = False
    reference_url: str = ""
    full_text: str = ""


def fetch_spdx_list(licenses_url: str) -> list[dict]:
    """Fetch the SPDX license list index."""
    resp = httpx.get(licenses_url, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    data = resp.json()
    return data.get("licenses", [])


def fetch_license_detail(details_base_url: str, spdx_id: str) -> str:
    """Fetch the full text for a specific license from SPDX details."""
    url = f"{details_base_url}{spdx_id}.json"
    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        data = resp.json()
        return data.get("licenseText", "")
    except Exception as e:
        logger.debug(f"Could not fetch detail for {spdx_id}: {e}")
        return ""


def parse_spdx_licenses(
    licenses_url: str,
    details_base_url: str,
    fetch_full_text: bool = True,
    limit: int | None = None,
) -> list[SPDXLicense]:
    """Parse SPDX license list into structured records."""
    raw = fetch_spdx_list(licenses_url)
    results: list[SPDXLicense] = []

    for entry in raw:
        if entry.get("isDeprecatedLicenseId", False):
            continue

        lic = SPDXLicense(
            spdx_id=entry.get("licenseId", ""),
            name=entry.get("name", ""),
            osi_approved=entry.get("isOsiApproved", False),
            deprecated=False,
            reference_url=entry.get("reference", ""),
        )

        if fetch_full_text and lic.spdx_id:
            lic.full_text = fetch_license_detail(details_base_url, lic.spdx_id)

        results.append(lic)

        if limit and len(results) >= limit:
            break

    logger.info(f"Parsed {len(results)} SPDX licenses (non-deprecated)")
    return results
