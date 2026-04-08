import { normalizeToolAlias } from "../tool-aliases.js";

export interface GuardrailToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface DiscoveryGuardrailDecision {
  calls: GuardrailToolCall[];
  blocked: Array<{ toolCallId: string; toolName: string; reason: string; message: string }>;
  collapsed: Array<{ duplicateToolCallId: string; canonicalToolCallId: string; signature: string }>;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function normalizePattern(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, "");
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, "");
}

export function isRootWildcardGlobCall(toolName: string, input: unknown): boolean {
  const n = normalizeToolAlias(toolName);
  if (n !== "glob" && n !== "glob_file_search") return false;
  const row = asRecord(input);
  const pattern = normalizePattern(row.glob_pattern ?? row.pattern ?? row.glob ?? row.query);
  return pattern === "*" || pattern === "**/*" || pattern === "**";
}

export function isEmptyGlobPatternCall(toolName: string, input: unknown): boolean {
  const n = normalizeToolAlias(toolName);
  if (n !== "glob" && n !== "glob_file_search") return false;
  const row = asRecord(input);
  const hasPatternKey =
    Object.prototype.hasOwnProperty.call(row, "glob_pattern")
    || Object.prototype.hasOwnProperty.call(row, "pattern")
    || Object.prototype.hasOwnProperty.call(row, "glob")
    || Object.prototype.hasOwnProperty.call(row, "query");
  if (!hasPatternKey) return false;
  const pattern = normalizePattern(row.glob_pattern ?? row.pattern ?? row.glob ?? row.query);
  return pattern.length === 0;
}

export function broadDiscoverySignature(toolName: string, input: unknown): string | null {
  const n = normalizeToolAlias(toolName);
  const row = asRecord(input);
  if (n === "glob" || n === "glob_file_search") {
    const pattern = normalizePattern(row.glob_pattern ?? row.pattern ?? row.glob ?? row.query);
    if (!pattern) return null;
    return `glob:${pattern}`;
  }
  if (n === "list_files" || n === "list_dir" || n === "read_dir" || n === "read_directory") {
    const p = normalizePath(row.path ?? row.dir ?? row.directory);
    if (!p) return null;
    return `list:${p}`;
  }
  return null;
}

export function rootWildcardGuidanceMessage(): string {
  return [
    "Error: Root-level wildcard globs are disabled for performance.",
    "Use `list_dir` or `ls -F` for top-level discovery, then target a specific subtree (for example `src/*` or `tests/**/*.ts`).",
  ].join(" ");
}

export function emptyGlobPatternGuidanceMessage(): string {
  return [
    "Error: Empty glob patterns are not allowed.",
    "Use a specific pattern such as `src/*`, `pkg/**/*_test.go`, or call `list_dir` first and then scope the glob.",
  ].join(" ");
}

export function applyDiscoveryGuardrails(calls: GuardrailToolCall[]): DiscoveryGuardrailDecision {
  const blocked: DiscoveryGuardrailDecision["blocked"] = [];
  const collapsed: DiscoveryGuardrailDecision["collapsed"] = [];
  const out: GuardrailToolCall[] = [];
  const seenBySignature = new Map<string, string>();

  for (const call of calls) {
    if (isEmptyGlobPatternCall(call.toolName, call.input)) {
      blocked.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        reason: "empty_glob_pattern_blocked",
        message: emptyGlobPatternGuidanceMessage(),
      });
      continue;
    }
    if (isRootWildcardGlobCall(call.toolName, call.input)) {
      blocked.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        reason: "root_wildcard_glob_blocked",
        message: rootWildcardGuidanceMessage(),
      });
      continue;
    }
    const signature = broadDiscoverySignature(call.toolName, call.input);
    if (signature) {
      const existing = seenBySignature.get(signature);
      if (existing) {
        collapsed.push({
          duplicateToolCallId: call.toolCallId,
          canonicalToolCallId: existing,
          signature,
        });
        continue;
      }
      seenBySignature.set(signature, call.toolCallId);
    }
    out.push(call);
  }

  return { calls: out, blocked, collapsed };
}
