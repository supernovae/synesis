import type { McpToolDefinition } from "../tool-registry.js";

/** Same sets as `base/mcp/app/tools/license_compliance.py` */
const _PERMISSIVE = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
]);

const _WEAK_COPYLEFT = new Set([
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-2.0",
]);

const _STRONG_COPYLEFT = new Set([
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0-only",
]);

const _COMPATIBLE_WITH: Record<string, Set<string>> = {
  MIT: _PERMISSIVE,
  "Apache-2.0": new Set([..._PERMISSIVE, "Apache-2.0"]),
  "BSD-3-Clause": _PERMISSIVE,
  "LGPL-3.0-only": new Set([..._PERMISSIVE, ..._WEAK_COPYLEFT, "Apache-2.0"]),
  "GPL-3.0-only": new Set([..._PERMISSIVE, ..._WEAK_COPYLEFT, ..._STRONG_COPYLEFT, "Apache-2.0"]),
  "AGPL-3.0-only": new Set([
    ..._PERMISSIVE,
    ..._WEAK_COPYLEFT,
    ..._STRONG_COPYLEFT,
    "Apache-2.0",
    "AGPL-3.0-only",
  ]),
};

export function createLicenseCheckTool(): McpToolDefinition {
  return {
    name: "synesis_license_check",
    description:
      "Check open-source license compatibility. Given package SPDX licenses, returns per-package compatibility and conflicts against a target license.",
    inputSchema: {
      type: "object",
      properties: {
        packages: {
          type: "array",
          description: "List of packages with their SPDX license identifiers",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              license: { type: "string", description: "SPDX identifier" },
            },
            required: ["name", "license"],
          },
        },
        target_license: {
          type: "string",
          description: "Target project license (SPDX identifier)",
          default: "Apache-2.0",
        },
      },
      required: ["packages"],
    },
    handler: async (args) => {
      try {
        const rawPackages = Array.isArray(args.packages) ? args.packages : [];
        const target =
          args.target_license === undefined || args.target_license === null
            ? "Apache-2.0"
            : String(args.target_license);

        const compatibleSet = _COMPATIBLE_WITH[target] ?? new Set([..._PERMISSIVE, target]);

        const details: Record<string, unknown>[] = [];
        const conflicts: Record<string, unknown>[] = [];

        for (const raw of rawPackages) {
          const pkg = raw as Record<string, unknown>;
          const name = pkg.name === undefined || pkg.name === null ? "unknown" : String(pkg.name);
          const lic =
            pkg.license === undefined || pkg.license === null ? "UNKNOWN" : String(pkg.license);

          const isCompatible = compatibleSet.has(lic) || lic === target;
          const entry: Record<string, unknown> = {
            package: name,
            license: lic,
            compatible: isCompatible,
          };

          if (!isCompatible) {
            entry.reason = `${lic} is not compatible with ${target}`;
            if (_STRONG_COPYLEFT.has(lic)) {
              entry.severity = "blocking";
              entry.suggestion = `Replace ${name} or change project to GPL-compatible license`;
            } else if (lic === "UNKNOWN") {
              entry.severity = "warning";
              entry.suggestion = `Determine actual license for ${name} before distribution`;
            } else {
              entry.severity = "review";
              entry.suggestion = `Verify ${lic} compatibility with ${target} (not in known matrix)`;
            }
            conflicts.push(entry);
          }
          details.push(entry);
        }

        return {
          target_license: target,
          packages_checked: rawPackages.length,
          conflicts: conflicts.length,
          all_compatible: conflicts.length === 0,
          details,
        };
      } catch (e) {
        return {
          error: "license_check_failed",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
