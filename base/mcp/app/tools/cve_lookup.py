"""CVE/Vulnerability MCP Tool — NVD and OSV integration.

Provides real-time vulnerability lookup for packages, giving coding agents
verifiable security data instead of relying on LLM knowledge cutoffs.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("synesis.mcp.cve")

TOOL_DEFINITION = {
    "name": "synesis_cve_check",
    "description": (
        "Check packages for known CVE vulnerabilities using the OSV.dev API. "
        "Returns a list of known vulnerabilities with severity, affected "
        "versions, and fix information."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "packages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "version": {"type": "string"},
                        "ecosystem": {
                            "type": "string",
                            "description": "Package ecosystem (PyPI, npm, crates.io, Go, Maven)",
                            "default": "PyPI",
                        },
                    },
                    "required": ["name"],
                },
                "description": "Packages to check for vulnerabilities",
            },
        },
        "required": ["packages"],
    },
}

OSV_API = "https://api.osv.dev/v1"


async def handle(args: dict[str, Any]) -> dict[str, Any]:
    """Query OSV.dev for known vulnerabilities."""
    packages = args.get("packages", [])
    results = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for pkg in packages:
            name = pkg.get("name", "")
            version = pkg.get("version", "")
            ecosystem = pkg.get("ecosystem", "PyPI")

            query: dict[str, Any] = {"package": {"name": name, "ecosystem": ecosystem}}
            if version:
                query["version"] = version

            try:
                resp = await client.post(f"{OSV_API}/query", json=query)
                if resp.status_code != 200:
                    results.append(
                        {
                            "package": name,
                            "version": version or "latest",
                            "error": f"OSV API returned {resp.status_code}",
                        }
                    )
                    continue

                data = resp.json()
                vulns = data.get("vulns", [])

                pkg_result: dict[str, Any] = {
                    "package": name,
                    "version": version or "latest",
                    "vulnerability_count": len(vulns),
                    "vulnerabilities": [],
                }

                for vuln in vulns[:10]:
                    severity = "UNKNOWN"
                    score = None
                    for s in vuln.get("severity", []):
                        if s.get("type") == "CVSS_V3":
                            severity = s.get("score", "UNKNOWN")
                        score = s.get("score")

                    fix_version = None
                    for affected in vuln.get("affected", []):
                        for rng in affected.get("ranges", []):
                            for event in rng.get("events", []):
                                if "fixed" in event:
                                    fix_version = event["fixed"]

                    pkg_result["vulnerabilities"].append(
                        {
                            "id": vuln.get("id", ""),
                            "summary": vuln.get("summary", "")[:200],
                            "severity": severity,
                            "cvss_score": score,
                            "fix_version": fix_version,
                            "references": [r.get("url") for r in vuln.get("references", [])[:3]],
                        }
                    )

                results.append(pkg_result)

            except httpx.TimeoutException:
                results.append(
                    {
                        "package": name,
                        "version": version or "latest",
                        "error": "OSV API timeout",
                    }
                )
            except Exception as e:
                logger.warning("CVE lookup failed for %s: %s", name, e)
                results.append(
                    {
                        "package": name,
                        "version": version or "latest",
                        "error": str(e),
                    }
                )

    total_vulns = sum(r.get("vulnerability_count", 0) for r in results)
    return {
        "packages_checked": len(packages),
        "total_vulnerabilities": total_vulns,
        "results": results,
    }
