import { normalizeToolAlias } from "../tool-aliases.js";

export interface GuardrailToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface DiscoveryGuardrailRedirect {
  toolCallId: string;
  toolName: string;
  reason: string;
  originalPattern: string;
  redirectedPattern: string;
}

export interface DiscoveryGuardrailDecision {
  calls: GuardrailToolCall[];
  blocked: Array<{ toolCallId: string; toolName: string; reason: string; message: string }>;
  redirected: DiscoveryGuardrailRedirect[];
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
    "Read README.md or package.json first, then target a specific subtree (for example `src/*` or `tests/**/*.ts`).",
  ].join(" ");
}

export function emptyGlobPatternGuidanceMessage(): string {
  return [
    "Error: Empty glob patterns are not allowed. Do NOT retry this call.",
    "Read README.md or package.json first to learn the directory layout, then use a scoped pattern such as `src/*` or `pkg/**/*_test.go`.",
  ].join(" ");
}

const DEFAULT_REDIRECT_PATTERN = ".";

function rewriteGlobInput(input: unknown, newPattern: string): unknown {
  const row = asRecord(input);
  const patternKey = Object.prototype.hasOwnProperty.call(row, "glob_pattern") ? "glob_pattern"
    : Object.prototype.hasOwnProperty.call(row, "pattern") ? "pattern"
    : Object.prototype.hasOwnProperty.call(row, "glob") ? "glob"
    : Object.prototype.hasOwnProperty.call(row, "query") ? "query"
    : "glob_pattern";
  return { ...row, [patternKey]: newPattern };
}

export function applyDiscoveryGuardrails(
  calls: GuardrailToolCall[],
  topLevelDirs?: string[],
): DiscoveryGuardrailDecision {
  const blocked: DiscoveryGuardrailDecision["blocked"] = [];
  const redirected: DiscoveryGuardrailRedirect[] = [];
  const collapsed: DiscoveryGuardrailDecision["collapsed"] = [];
  const out: GuardrailToolCall[] = [];
  const seenBySignature = new Map<string, string>();

  const preferredDirs = ["src", "lib", "app", "pkg", "cmd"];
  const dirSet = new Set(topLevelDirs ?? []);
  const scopedTarget = preferredDirs.find((d) => dirSet.has(d))
    ?? topLevelDirs?.[0]
    ?? null;
  const redirectPattern = scopedTarget ? `${scopedTarget}/*` : DEFAULT_REDIRECT_PATTERN;

  for (const call of calls) {
    const emptyGlob = isEmptyGlobPatternCall(call.toolName, call.input);
    const rootWildcard = !emptyGlob && isRootWildcardGlobCall(call.toolName, call.input);

    if (emptyGlob || rootWildcard) {
      const originalPattern = emptyGlob ? "" : "*";
      const reason = emptyGlob ? "empty_glob_pattern_redirected" : "root_wildcard_glob_redirected";

      redirected.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        reason,
        originalPattern,
        redirectedPattern: redirectPattern,
      });
      out.push({
        ...call,
        input: rewriteGlobInput(call.input, redirectPattern),
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

  return { calls: out, blocked, redirected, collapsed };
}
