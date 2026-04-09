/**
 * Tool Canonicalizer
 *
 * Makes the tool definition list deterministic across requests.
 * Different IDE clients may serialize tools in different orders or with
 * varying whitespace — this module normalizes everything so the toolset
 * hash is stable when the logical tool set hasn't changed.
 */

import crypto from "node:crypto";
import { sortObjectKeys, stableJsonStringify } from "../../compat/sorted-tools.js";
import type { ToolDefinition } from "./types.js";

/**
 * Normalize a tool description: collapse whitespace, trim.
 */
function normalizeDescription(desc: string | undefined): string | undefined {
  if (!desc) return desc;
  return desc.replace(/\s+/g, " ").trim();
}

/**
 * Strip dynamic content from tool descriptions that might vary per-turn.
 * Removes session IDs, timestamps, absolute paths with user-specific prefixes.
 */
function stripDynamicContent(desc: string | undefined): string | undefined {
  if (!desc) return desc;
  return desc
    .replace(/\/Users\/[^\s/]+/g, "/Users/<user>")
    .replace(/\/home\/[^\s/]+/g, "/home/<user>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, "<timestamp>");
}

/**
 * Canonicalize a single tool definition.
 */
function canonicalizeTool(tool: ToolDefinition): ToolDefinition {
  const fn = { ...tool.function };
  fn.description = stripDynamicContent(normalizeDescription(fn.description));
  if (fn.parameters) {
    fn.parameters = sortObjectKeys(fn.parameters) as Record<string, unknown>;
  }
  return {
    type: tool.type,
    function: sortObjectKeys(fn) as ToolDefinition["function"],
  };
}

export interface CanonicalizedTools {
  tools: ToolDefinition[];
  hash: string;
}

/**
 * Canonicalize a tool definitions array for deterministic serialization and hashing.
 *
 * - Sorts tools by function.name (lexicographic)
 * - Sorts all JSON schema keys recursively
 * - Normalizes descriptions (whitespace, dynamic content)
 * - Computes a SHA-256 hash of the canonical representation
 */
export function canonicalizeTools(tools: ToolDefinition[] | undefined): CanonicalizedTools {
  if (!tools || tools.length === 0) {
    return { tools: [], hash: "empty" };
  }

  const canonical = tools
    .map(canonicalizeTool)
    .sort((a, b) => a.function.name.localeCompare(b.function.name));

  const serialized = stableJsonStringify(canonical);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16);

  return { tools: canonical, hash };
}
