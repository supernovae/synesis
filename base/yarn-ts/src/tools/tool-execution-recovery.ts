import { parseReadSnapshotEnvelope } from "../reduction/file-snapshot-registry.js";
import { toolDefinitionName } from "./tool-call-availability.js";

export type ToolExecutionFailureObservation = {
  toolName: string;
  toolCallId: string;
  filePath?: string;
  reason: string;
  snippet: string;
};

const TOOL_FAILURE_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: "edit_context_miss", re: /\bfailed to find context\b/i },
  { reason: "edit_context_miss", re: /\bold[_\s-]?string\b.*\bnot found\b/i },
  { reason: "edit_context_miss", re: /\bnot found in file\b/i },
  { reason: "edit_context_miss", re: /\bexactly once\b/i },
  { reason: "edit_context_miss", re: /\bfound \d+ matches\b.*\breplace_all\b.*\bfalse\b/i },
  { reason: "edit_context_miss", re: /\breplace_all is false\b/i },
  { reason: "edit_context_miss", re: /\buniquely identify the instance\b/i },
  { reason: "edit_error", re: /\berror editing file\b/i },
  { reason: "patch_apply_failed", re: /\b(apply\s*patch|patch)\b.*\b(failed|error)\b/i },
  { reason: "write_permission_denied", re: /\b(permission denied|operation not permitted)\b/i },
];
const TOOL_IDEMPOTENT_PATTERNS: RegExp[] = [
  /\balready (?:replaced|exists|present)\b/i,
  /\balready contains\b/i,
  /\bno changes (?:made|needed)\b/i,
  /\bnothing to (?:replace|update)\b/i,
];
const WRITE_ONLY_FAILURE_REASONS = new Set([
  "edit_error",
  "edit_context_miss",
  "patch_apply_failed",
  "write_permission_denied",
  "write_tool_error",
]);

export function collectToolExecutionFailureObservations(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
): ToolExecutionFailureObservation[] {
  const toolMetaById = new Map<string, { toolName: string; filePath?: string }>();
  const latestWritePathByToolName = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id.trim() : "";
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (id && name) toolMetaById.set(id, { toolName: name, filePath });
      if (name && filePath && isWriteCapableToolName(name)) {
        latestWritePathByToolName.set(name.toLowerCase(), filePath);
      }
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (id && name) toolMetaById.set(id, { toolName: name, filePath });
      if (name && filePath && isWriteCapableToolName(name)) {
        latestWritePathByToolName.set(name.toLowerCase(), filePath);
      }
    }
  }

  const observations: ToolExecutionFailureObservation[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;

    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const mappedMeta = toolCallId ? (toolMetaById.get(toolCallId) ?? null) : null;
    const mappedName = mappedMeta?.toolName ?? "";
    const toolName = (typeof message.name === "string" ? message.name : mappedName).trim() || "unknown_tool";
    const fallbackFilePath = latestWritePathByToolName.get(toolName.toLowerCase());
    const observedFilePath = mappedMeta?.filePath ?? fallbackFilePath;
    const writeCapableTool = isWriteCapableToolName(toolName);
    const lower = rawText.toLowerCase();
    let reason = "";
    for (const candidate of TOOL_FAILURE_PATTERNS) {
      if (WRITE_ONLY_FAILURE_REASONS.has(candidate.reason) && !writeCapableTool) continue;
      if (candidate.re.test(lower)) {
        reason = candidate.reason;
        break;
      }
    }
    if (!reason && writeCapableTool && TOOL_IDEMPOTENT_PATTERNS.some((re) => re.test(lower))) {
      reason = "edit_already_applied";
    }
    if (!reason && writeCapableTool && /\b(error|failed|invalid)\b/i.test(rawText)) {
      reason = "write_tool_error";
    }
    if (!reason) continue;

    const snippet = rawText.replace(/\s+/g, " ").slice(0, 220);
    const key = `${toolName}|${toolCallId}|${reason}|${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({ toolName, toolCallId, filePath: observedFilePath, reason, snippet });
    if (observations.length >= 3) break;
  }
  return observations;
}

export function findLastUserPromptIdx(messages: Array<{ role?: string; content?: unknown }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (Array.isArray(m.content) && m.content.length > 0
      && (m.content as Array<{ type?: string }>).every((b) => b?.type === "tool_result")) continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text && !Array.isArray(m.content)) continue;
    return i;
  }
  return -1;
}

export function isToolResultOnlyUserContent(content: unknown): boolean {
  return Array.isArray(content)
    && content.length > 0
    && (content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
}

export function hasGenuineUserTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: string; text?: unknown }>).some((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.type !== "text") return false;
    return typeof b.text === "string" && b.text.trim().length > 0;
  });
}

export function isGenuineUserPromptMessage(message: { role?: string; content?: unknown } | undefined): boolean {
  if (!message || message.role !== "user") return false;
  if (isToolResultOnlyUserContent(message.content)) return false;
  return hasGenuineUserTextContent(message.content);
}

export function sliceMessagesSinceLastUserPrompt<T extends { role?: string; content?: unknown }>(messages: T[]): T[] {
  const boundary = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  return boundary >= 0 ? messages.slice(boundary + 1) : messages;
}

export type EditContextMissGuardState = {
  active: boolean;
  filePath: string;
  missCount: number;
};

export function deriveEditContextMissGuardState(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
): EditContextMissGuardState | null {
  const turnBoundaryIdx = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  const turnMessages = turnBoundaryIdx >= 0 ? messages.slice(turnBoundaryIdx + 1) : messages;
  const toolMetaById = buildToolCallMetaById(turnMessages);
  const latestWritePathByToolName = buildLatestWritePathByToolName(turnMessages);
  const states = new Map<string, {
    filePath: string;
    misses: number;
    missesSinceRead: number;
    lastReadIdx: number;
    lastMissIdx: number;
  }>();
  let selected: { filePath: string; misses: number; lastMissIdx: number } | null = null;

  for (let i = 0; i < turnMessages.length; i += 1) {
    const message = turnMessages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const meta = toolCallId ? toolMetaById.get(toolCallId) : undefined;
    const explicitToolName = typeof message.name === "string" ? message.name.trim() : "";
    const toolName = (explicitToolName || meta?.toolName || "").toLowerCase();
    const fallbackFilePath = latestWritePathByToolName.get(toolName);
    const filePath = canonicalizeToolPath(meta?.filePath ?? fallbackFilePath ?? "");
    if (!toolName || !filePath) continue;

    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;

    if (isReadToolName(toolName) && isResolvableReadResult(message.content, rawText)) {
      const prev = states.get(filePath);
      states.set(filePath, {
        filePath,
        misses: prev?.misses ?? 0,
        missesSinceRead: 0,
        lastReadIdx: i,
        lastMissIdx: prev?.lastMissIdx ?? -1,
      });
      continue;
    }

    if (!isWriteCapableToolName(toolName) || !isEditContextMissText(rawText)) continue;
    const prev = states.get(filePath);
    const nextMisses = prev ? prev.misses + 1 : 1;
    const nextMissesSinceRead = prev ? prev.missesSinceRead + 1 : 1;
    const nextState = {
      filePath,
      misses: nextMisses,
      missesSinceRead: nextMissesSinceRead,
      lastReadIdx: prev?.lastReadIdx ?? -1,
      lastMissIdx: i,
    };
    states.set(filePath, nextState);
    if (nextState.missesSinceRead >= 1 && nextState.lastMissIdx > nextState.lastReadIdx) {
      if (!selected || nextState.lastMissIdx >= selected.lastMissIdx) {
        selected = {
          filePath: nextState.filePath,
          misses: nextState.misses,
          lastMissIdx: nextState.lastMissIdx,
        };
      }
    }
  }

  if (!selected) return null;
  return {
    active: true,
    filePath: selected.filePath,
    missCount: selected.misses,
  };
}

export function applyEditContextMissReadGate(
  tools: unknown[] | undefined,
): { tools: unknown[] | undefined; removed: string[]; forcedReadToolName?: string } {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, removed: [] };
  }
  const removed: string[] = [];
  const readOnly: unknown[] = [];
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const row = tool as Record<string, unknown>;
    const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
    const rawName = (typeof row.name === "string" ? row.name : "")
      || (nested && typeof nested.name === "string" ? nested.name : "");
    const name = rawName.trim();
    if (!name) return true;
    const lowered = name.toLowerCase();
    if (isReadToolName(lowered)) {
      readOnly.push(tool);
      return true;
    }
    if (isWriteCapableToolName(lowered)) {
      removed.push(name);
      return false;
    }
    removed.push(name);
    return false;
  });
  const forcedReadToolName = findPreferredReadToolName(readOnly.length > 0 ? readOnly : filtered);
  return {
    tools: readOnly.length > 0 ? readOnly : filtered,
    removed,
    forcedReadToolName,
  };
}

export function buildEditContextMissGuardPrompt(filePath: string, missCount: number): string {
  const lines = [
    `EDIT RECOVERY REQUIRED: ${missCount} recent edit-context misses were detected for \`${filePath}\`.`,
    "Before any Edit/Write/Patch tool call, issue exactly one Read tool call for this same file path to refresh anchors.",
    "Read a substantial block (for example 20-60 lines around the target, or the full file if small) so the next anchor is unambiguous.",
    "Use that fresh content to prepare a new exact anchor, then apply one focused edit.",
    "Do not repeat the same old_string/anchor without a fresh read.",
    "If the editor reports multiple matches (for example replace_all=false with many matches), choose a smaller unique anchor first instead of retrying the same broad replacement.",
    "If the error says 'Found 2 matches' (or a small fixed number) and BOTH occurrences need the same change, set replace_all to true, OR expand old_string with enough surrounding lines to match exactly once, OR use Write/ApplyPatch for a whole contiguous block.",
    "Never use a whole-file old_string anchor for retries.",
  ];
  if (missCount >= 2) {
    lines.push(
      "If the refreshed file still does not match your expected anchor, stop retrying the same replacement.",
      "Pivot to verification of existing behavior and tests, or choose a different exact anchor before the next edit.",
    );
  }
  return lines.join("\n");
}

export type LatestReadRefreshSignal = {
  hasRecentReadSuccess: boolean;
  toolName: string;
  toolCallId: string;
  filePath: string;
  snippet: string;
};

export function classifyLatestReadRefresh(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
): LatestReadRefreshSignal {
  const turnBoundaryIdx = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  const turnMessages = turnBoundaryIdx >= 0 ? messages.slice(turnBoundaryIdx + 1) : messages;
  const toolMetaById = buildToolCallMetaById(turnMessages);
  for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
    const message = turnMessages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const mappedMeta = toolCallId ? (toolMetaById.get(toolCallId) ?? null) : null;
    const mappedName = mappedMeta?.toolName ?? "";
    const toolName = (typeof message.name === "string" ? message.name : mappedName).trim();
    if (!toolName || !isReadToolName(toolName)) continue;
    return {
      hasRecentReadSuccess: isResolvableReadResult(message.content, rawText),
      toolName,
      toolCallId,
      filePath: canonicalizeToolPath(mappedMeta?.filePath ?? ""),
      snippet: rawText.replace(/\s+/g, " ").slice(0, 220),
    };
  }
  return {
    hasRecentReadSuccess: false,
    toolName: "",
    toolCallId: "",
    filePath: "",
    snippet: "",
  };
}

export function buildEditContextMissForcedReadPrompt(filePath?: string): string {
  const target = filePath && filePath.trim()
    ? `for \`${filePath.trim()}\``
    : "for the file you are trying to edit";
  return [
    "TOKEN-SAVING RECOVERY MODE: repeated edit anchor failures are still active.",
    `Your next action MUST be exactly one Read tool call ${target}.`,
    "Do not run Edit/Write/Test/Search tools in this turn.",
    "After that single Read result, perform one anchored edit in the next turn.",
  ].join("\n");
}

export function buildStateRegroundReadPrompt(path: string, reasons: string[]): string {
  const safePath = path.trim() || "<unknown>";
  const reasonLine = reasons.length > 0
    ? `State confidence was low due to: ${reasons.slice(0, 5).join(", ")}.`
    : "State confidence was low and requires one deterministic refresh step.";
  return [
    "STATE REGROUND REQUIRED:",
    reasonLine,
    `Your next action MUST be exactly one Read tool call for \`${safePath}\`.`,
    "Do not run Edit/Write/Test/Search tools in this turn.",
    "After this single Read result, continue with one focused implementation action in the next turn.",
  ].join("\n");
}

export function buildToolCallMetaById(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
): Map<string, { toolName: string; filePath?: string }> {
  const out = new Map<string, { toolName: string; filePath?: string }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id.trim() : "";
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (id && name) out.set(id, { toolName: name, filePath });
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (id && name) out.set(id, { toolName: name, filePath });
    }
  }
  return out;
}

export function buildLatestWritePathByToolName(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (name && filePath && isWriteCapableToolName(name)) {
        out.set(name.toLowerCase(), filePath);
      }
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (name && filePath && isWriteCapableToolName(name)) {
        out.set(name.toLowerCase(), filePath);
      }
    }
  }
  return out;
}

export function readFilePathFromToolCallArgs(rawArgs: string): string | undefined {
  if (!rawArgs) return undefined;
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    return readFilePathFromUnknownInput(parsed);
  } catch {
    return undefined;
  }
}

export function readFilePathFromUnknownInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "file"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function canonicalizeToolPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\\/g, "/");
}

export function isEditContextMissText(rawText: string): boolean {
  for (const candidate of TOOL_FAILURE_PATTERNS) {
    if (candidate.reason !== "edit_context_miss") continue;
    if (candidate.re.test(rawText)) return true;
  }
  return false;
}

export function isReadToolName(toolName: string): boolean {
  const lowered = toolName.trim().toLowerCase();
  return lowered === "read" || lowered === "read_file" || lowered === "readfile" || lowered === "file_read";
}

export function findReadToolDefinition(tools: unknown[] | undefined): unknown | undefined {
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (name && isReadToolName(name)) return tool;
  }
  return undefined;
}

export function isResolvableReadResult(content: unknown, rawText: string): boolean {
  const direct = typeof content === "string" ? content.trim() : "";
  if (direct.startsWith("{")) {
    const envelope = parseReadSnapshotEnvelope(direct);
    if (envelope) {
      const hasContent = typeof envelope.content === "string" && envelope.content.trim().length > 0;
      if (envelope.status === "ok/full_content" || envelope.status === "ok/replayed_snapshot") {
        return hasContent;
      }
      if (envelope.status === "ok/unchanged_snapshot_still_visible") {
        return hasContent;
      }
      return false;
    }
  }
  if (/unchanged since last read/i.test(rawText)) return false;
  if (/already read|already in memory|already in context|already loaded|cached/i.test(rawText)) return false;
  return rawText.length > 0;
}

export function findPreferredReadToolName(tools: unknown[]): string | undefined {
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (!name) continue;
    if (isReadToolName(name)) return name;
  }
  return undefined;
}

export function ensureReadToolAvailabilityForEditMissGuard(
  tools: unknown[] | undefined,
  fallbackTools: unknown[] | undefined,
): { tools: unknown[] | undefined; readToolName?: string; rehydrated: boolean; available: boolean } {
  const current = Array.isArray(tools) ? [...tools] : [];
  const existing = findPreferredReadToolName(current);
  if (existing) {
    return { tools: current, readToolName: existing, rehydrated: false, available: true };
  }
  const fallbackRead = findReadToolDefinition(fallbackTools);
  if (!fallbackRead) {
    return { tools: current, rehydrated: false, available: false };
  }
  const fallbackName = toolDefinitionName(fallbackRead) || findPreferredReadToolName([fallbackRead]) || "Read";
  return {
    tools: [...current, fallbackRead],
    readToolName: fallbackName,
    rehydrated: true,
    available: true,
  };
}

export function collectToolResultTextChunks(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || value === null || value === undefined || out.length >= 12) return out;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) out.push(t);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolResultTextChunks(item, depth + 1, out);
      if (out.length >= 12) break;
    }
    return out;
  }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const directText = typeof row.text === "string" ? row.text.trim() : "";
  if (directText) out.push(directText);
  const nestedKeys = ["message", "error", "stderr", "stdout", "summary", "content", "result", "data", "payload", "output"];
  for (const key of nestedKeys) {
    if (!(key in row)) continue;
    collectToolResultTextChunks(row[key], depth + 1, out);
    if (out.length >= 12) break;
  }
  return out;
}

export function isWriteCapableToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "write"
    || n === "edit"
    || n === "update"
    || n === "write_file"
    || n === "str_replace"
    || n === "git_add_guarded"
    || n === "git_commit_guarded"
    || n === "format_code";
}
