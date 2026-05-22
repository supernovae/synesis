import crypto from "node:crypto";

export interface WorkspaceContextInfo {
  cwd: string;
  projectRoot: string;
  shell?: string;
  os?: string;
  arch?: string;
}

/** Stored workspace hints from session metadata (handshake or packet backfill); either path may be absent. */
export interface SessionPathMetadataHints {
  cwd: string | null;
  projectRoot: string | null;
  shell?: string;
  os?: string;
  arch?: string;
}

const MARKER = "SYNESIS_WORKSPACE_CONTEXT_V1";

export function makeWorkspaceHandshakeToolCallId(): string {
  return `synesis_workspace_ctx_${crypto.randomUUID()}`;
}

export function buildWorkspaceHandshakeBashCommand(): string {
  return [
    "cwd=\"$(pwd 2>/dev/null || true)\"",
    "root=\"$(git rev-parse --show-toplevel 2>/dev/null || true)\"",
    "shell=\"${SHELL:-${ComSpec:-${COMSPEC:-}}}\"",
    "os=\"$(uname -s 2>/dev/null || echo unknown)\"",
    "arch=\"$(uname -m 2>/dev/null || echo unknown)\"",
    "[ -z \"$root\" ] && root=\"$cwd\"",
    `printf '${MARKER}\\ncwd=%s\\nproject_root=%s\\nshell=%s\\nos=%s\\narch=%s\\n' "$cwd" "$root" "$shell" "$os" "$arch"`,
  ].join("; ");
}

export function hasBashTool(tools: unknown[] | undefined): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const row = t as Record<string, unknown>;
    const name = row.name;
    const fnName = (row.function as Record<string, unknown> | undefined)?.name;
    return name === "Bash" || fnName === "Bash";
  });
}

export function parseWorkspaceContextOutput(raw: string): WorkspaceContextInfo | null {
  const text = String(raw ?? "");
  const idx = text.indexOf(MARKER);
  if (idx < 0) return null;
  const lines = text
    .slice(idx + MARKER.length)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const kv: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    kv[key] = val;
  }
  const cwd = normalizePath(kv.cwd);
  const root = normalizePath(kv.project_root) || cwd;
  if (!cwd || !root) return null;
  const shell = sanitize(kv.shell, 200);
  const os = sanitize(kv.os, 80);
  const arch = sanitize(kv.arch, 80);
  return {
    cwd,
    projectRoot: root,
    ...(shell ? { shell } : {}),
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
  };
}

export function extractOpenAIToolResult(
  messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>,
  toolCallId: string,
): string | null {
  const row = [...messages].reverse().find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
  if (!row) return null;
  if (typeof row.content === "string") return row.content;
  if (Array.isArray(row.content)) {
    return row.content.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n");
  }
  if (row.content == null) return "";
  return JSON.stringify(row.content);
}

/**
 * Most recent `tool_use_id` from Claude-style user content blocks (for policy / progress keys).
 * Walks messages newest-first so a trailing user text message does not hide the latest tool result.
 */
export function lastToolUseIdFromClaudeMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<Record<string, unknown>>;
    for (let j = blocks.length - 1; j >= 0; j -= 1) {
      const b = blocks[j];
      if (!b || typeof b !== "object") continue;
      if (b.type !== "tool_result") continue;
      const id = b.tool_use_id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return "";
}

export function extractClaudeToolResult(
  messages: Array<{ role: string; content: unknown }>,
  toolCallId: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "tool_result") continue;
      if (String(block.tool_use_id ?? "") !== toolCallId) continue;
      const c = block.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
              return String((part as Record<string, unknown>).text);
            }
            return JSON.stringify(part);
          })
          .join("\n");
      }
      if (c == null) return "";
      return JSON.stringify(c);
    }
  }
  return null;
}

export function contextFromSessionMetadata(meta: Record<string, unknown>): SessionPathMetadataHints | null {
  const cwd = normalizePath(String(meta.workspace_context_cwd ?? ""));
  const projectRoot = normalizePath(String(meta.workspace_context_project_root ?? ""));
  if (!cwd && !projectRoot) return null;
  const shell = sanitize(String(meta.workspace_context_shell ?? ""), 200);
  const os = sanitize(String(meta.workspace_context_os ?? ""), 80);
  const arch = sanitize(String(meta.workspace_context_arch ?? ""), 80);
  return {
    cwd: cwd || null,
    projectRoot: projectRoot || null,
    ...(shell ? { shell } : {}),
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
  };
}

function normalizePath(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t.replace(/\0/g, "").slice(0, 2000);
}

function sanitize(raw: string, max: number): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
