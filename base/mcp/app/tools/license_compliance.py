"""License Compliance MCP Tool — SPDX lookup and compatibility matrix.

Provides verifiable license data to coding agents, eliminating hallucination
on license questions. Backed by the SPDX license list and a hardcoded
compatibility matrix for common OSS licenses.
"""

from __future__ import annotations

from typing import Any

TOOL_DEFINITION = {
    "name": "synesis_license_check",
    "description": (
        "Check open-source license compatibility. Given a list of package "
        "licenses, determine if they are compatible with a target license "
        "(e.g., Apache-2.0, MIT, GPL-3.0). Returns compatibility verdict "
        "and any conflicts."
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
                        "license": {"type": "string", "description": "SPDX identifier"},
                    },
                    "required": ["name", "license"],
                },
                "description": "List of packages with their SPDX license identifiers",
            },
            "target_license": {
                "type": "string",
                "description": "Target project license (SPDX identifier)",
                "default": "Apache-2.0",
            },
        },
        "required": ["packages"],
    },
}

# Simplified compatibility matrix: target -> set of compatible source licenses.
# A more complete version would use the SPDX license expression parser.
_PERMISSIVE = {"MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0"}
_WEAK_COPYLEFT = {"LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MPL-2.0"}
_STRONG_COPYLEFT = {"GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only"}

_COMPATIBLE_WITH: dict[str, set[str]] = {
    "MIT": _PERMISSIVE,
    "Apache-2.0": _PERMISSIVE | {"Apache-2.0"},
    "BSD-3-Clause": _PERMISSIVE,
    "LGPL-3.0-only": _PERMISSIVE | _WEAK_COPYLEFT | {"Apache-2.0"},
    "GPL-3.0-only": _PERMISSIVE | _WEAK_COPYLEFT | _STRONG_COPYLEFT | {"Apache-2.0"},
    "AGPL-3.0-only": _PERMISSIVE | _WEAK_COPYLEFT | _STRONG_COPYLEFT | {"Apache-2.0", "AGPL-3.0-only"},
}


async def handle(args: dict[str, Any]) -> dict[str, Any]:
    """Check license compatibility."""
    packages = args.get("packages", [])
    target = args.get("target_license", "Apache-2.0")

    compatible_set = _COMPATIBLE_WITH.get(target, _PERMISSIVE | {target})

    results = []
    conflicts = []
    for pkg in packages:
        name = pkg.get("name", "unknown")
        lic = pkg.get("license", "UNKNOWN")
        is_compatible = lic in compatible_set or lic == target
        entry = {
            "package": name,
            "license": lic,
            "compatible": is_compatible,
        }
        if not is_compatible:
            entry["reason"] = f"{lic} is not compatible with {target}"
            if lic in _STRONG_COPYLEFT:
                entry["severity"] = "blocking"
                entry["suggestion"] = f"Replace {name} or change project to GPL-compatible license"
            elif lic == "UNKNOWN":
                entry["severity"] = "warning"
                entry["suggestion"] = f"Determine actual license for {name} before distribution"
            else:
                entry["severity"] = "review"
                entry["suggestion"] = f"Verify {lic} compatibility with {target} (not in known matrix)"
            conflicts.append(entry)
        results.append(entry)

    return {
        "target_license": target,
        "packages_checked": len(packages),
        "conflicts": len(conflicts),
        "all_compatible": len(conflicts) == 0,
        "details": results,
    }
