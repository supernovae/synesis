/**
 * MCP tool: synesis_patch_integrity — deterministic code safety checks.
 */

import {
  runAllChecks,
  type PatchOpInput,
  IntegrityReport,
} from "../integrity/core.js";
import type { McpToolDefinition } from "../tool-registry.js";

const TOOL_DESCRIPTION =
  "Deterministic safety check for proposed code or patches. " +
  "Validates for secrets, network egress, dangerous commands, " +
  "path traversal, untrusted imports, and size limits. " +
  "Returns pass/fail with categories and remediations.";

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "The code or script to validate",
    },
    language: {
      type: "string",
      description: "Programming language (python, bash, javascript, typescript)",
      default: "python",
    },
    patch_ops: {
      type: "array",
      description: "Optional list of patch operations [{path, op, text}]",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          op: { type: "string", enum: ["add", "modify", "delete"] },
          text: { type: "string" },
        },
      },
      default: [],
    },
    files_touched: {
      type: "array",
      items: { type: "string" },
      description: "List of file paths being modified",
      default: [],
    },
    target_workspace: {
      type: "string",
      description: "Workspace root path for boundary checks",
      default: "",
    },
    commands: {
      type: "array",
      items: { type: "string" },
      description: "Optional experiment/build commands to validate",
      default: [],
    },
  },
  required: ["code"],
};

function reportToDict(report: IntegrityReport): Record<string, unknown> {
  return {
    passed: report.passed,
    failures: report.failures.map((f) => ({
      category: f.category,
      evidence: f.evidence,
      remediation: f.remediation,
    })),
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asPatchOps(v: unknown): PatchOpInput[] {
  if (!Array.isArray(v)) return [];
  const out: PatchOpInput[] = [];
  for (const item of v) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      out.push({
        path: typeof o.path === "string" ? o.path : undefined,
        op: typeof o.op === "string" ? o.op : undefined,
        text: typeof o.text === "string" ? o.text : undefined,
        content: typeof o.content === "string" ? o.content : undefined,
      });
    }
  }
  return out;
}

export function createPatchIntegrityTool(): McpToolDefinition {
  return {
    name: "synesis_patch_integrity",
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    handler: async (args: Record<string, unknown>) => {
      const code = typeof args.code === "string" ? args.code : "";
      const language = typeof args.language === "string" ? args.language : "python";
      const patchOps = asPatchOps(args.patch_ops);
      const filesTouched = asStringArray(args.files_touched);
      const targetWorkspace = typeof args.target_workspace === "string" ? args.target_workspace : "";
      const commands = asStringArray(args.commands);

      const report = runAllChecks(
        code,
        language,
        patchOps,
        filesTouched,
        targetWorkspace,
        commands,
      );
      return reportToDict(report);
    },
  };
}
