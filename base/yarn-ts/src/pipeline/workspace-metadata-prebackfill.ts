import type { ClientMetadata } from "../providers/prefix-optimizer/index.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";

interface ToolCallEvidence {
  toolName: string;
  args: Record<string, unknown> | null;
  resultContent: string;
}

export interface WorkspacePrebackfillSessionState {
  record: { metadata: Record<string, unknown> };
}

export interface WorkspacePrebackfillResult {
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  applied: boolean;
  metadata: ClientMetadata | null;
}

export function mergePathContextWithClientMetadata(
  pathContext: SessionPathHints,
  metadata: ClientMetadata | null | undefined,
): SessionPathHints {
  if (!metadata) return pathContext;
  return {
    ...pathContext,
    projectRoot: pathContext.projectRoot ?? metadata.projectRoot ?? null,
    shellCwd: pathContext.shellCwd ?? metadata.shellCwd ?? null,
    shell: pathContext.shell ?? metadata.shell ?? undefined,
    platform: pathContext.platform ?? metadata.platform ?? undefined,
    osVersion: pathContext.osVersion ?? metadata.osVersion ?? undefined,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join("\n");
  if (!content || typeof content !== "object") return "";
  const row = content as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["text", "content", "message", "output", "error"]) {
    const value = row[key];
    const text = textFromContent(value);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractToolEvidence(messages: unknown[]): ToolCallEvidence[] {
  const toolMetaById = new Map<string, { toolName: string; args: Record<string, unknown> | null }>();
  const evidence: ToolCallEvidence[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    if (row.role === "assistant") {
      const toolCalls = row.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== "object") continue;
          const call = toolCall as Record<string, unknown>;
          const fn = call.function;
          const fnRow = fn && typeof fn === "object" ? fn as Record<string, unknown> : {};
          const id = typeof call.id === "string" ? call.id.trim() : "";
          const toolName = typeof fnRow.name === "string"
            ? fnRow.name.trim()
            : (typeof call.name === "string" ? call.name.trim() : "");
          if (id && toolName) toolMetaById.set(id, { toolName, args: parseToolArgs(fnRow.arguments ?? call.input) });
        }
      }
      if (Array.isArray(row.content)) {
        for (const part of row.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type !== "tool_use") continue;
          const id = typeof p.id === "string" ? p.id.trim() : "";
          const toolName = typeof p.name === "string" ? p.name.trim() : "";
          if (id && toolName) toolMetaById.set(id, { toolName, args: parseToolArgs(p.input) });
        }
      }
      continue;
    }
    if (row.role !== "tool" && row.role !== "tool_result") continue;
    const id = typeof row.tool_call_id === "string" ? row.tool_call_id.trim() : "";
    const fallbackToolName = typeof row.name === "string" ? row.name.trim() : "";
    const meta = id ? toolMetaById.get(id) : undefined;
    const toolName = meta?.toolName ?? fallbackToolName;
    if (!toolName) continue;
    evidence.push({
      toolName,
      args: meta?.args ?? null,
      resultContent: textFromContent(row.content),
    });
  }

  return evidence;
}

function commandFromArgs(args: Record<string, unknown> | null): string {
  if (!args) return "";
  for (const key of ["command", "cmd", "script"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstAbsolutePathLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\/[^\0\r\n]+$/.test(trimmed) && !/\s/.test(trimmed)) return trimmed.replace(/\/+$/g, "");
  }
  return null;
}

function absolutePathsInText(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'=:])((?:\/[A-Za-z0-9._@:+-]+)+\/?)(?=$|[\s"',;:)\]}*])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1].replace(/\/+$/g, ""));
  }
  return out;
}

function inferRootFromDuplicatedAbsolutePath(pathValue: string): string | null {
  const parts = pathValue.split("/").filter(Boolean);
  for (let start = 0; start < parts.length; start += 1) {
    const max = Math.floor((parts.length - start) / 2);
    for (let size = Math.min(max, 4); size >= 2; size -= 1) {
      const left = parts.slice(start, start + size);
      const right = parts.slice(start + size, start + size * 2);
      if (left.length === right.length && left.every((part, idx) => part === right[idx])) {
        return `/${parts.slice(0, start + size).join("/")}`;
      }
    }
  }
  return null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function stripShellTokenQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "\"" || first === "'") && first === last ? trimmed.slice(1, -1) : trimmed;
}

function firstWhitespaceIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) return i;
  }
  return -1;
}

function firstCdAbsolutePathBeforeSeparator(command: string): string | null {
  for (const chunk of command.split(";")) {
    for (const segment of chunk.split("&&")) {
      const trimmed = segment.trim();
      if (!trimmed.startsWith("cd ")) continue;
      const rest = trimmed.slice(3).trim();
      const whitespace = firstWhitespaceIndex(rest);
      const token = stripShellTokenQuotes(whitespace >= 0 ? rest.slice(0, whitespace) : rest);
      if (token.startsWith("/")) return trimTrailingSlashes(token);
    }
  }
  return null;
}

function inferWorkspaceRootFromToolEvidence(messages: unknown[]): string | null {
  const evidence = extractToolEvidence(messages);
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const item = evidence[i];
    const tool = item.toolName.toLowerCase();
    const command = commandFromArgs(item.args);
    const lowerResult = item.resultContent.toLowerCase();
    if ((tool === "bash" || tool === "shell" || tool.includes("bash")) && /\bpwd\b/.test(command)) {
      const cwd = firstAbsolutePathLine(item.resultContent);
      if (cwd) return cwd;
    }
    if ((tool === "bash" || tool === "shell" || tool.includes("bash")) && !/no such file|cannot access|not found/.test(lowerResult)) {
      const cdPath = firstCdAbsolutePathBeforeSeparator(command);
      if (cdPath) return cdPath;
    }
    if (/file not found|no such file|cannot access|does not exist/.test(lowerResult)) {
      for (const candidate of absolutePathsInText(item.resultContent)) {
        const inferred = inferRootFromDuplicatedAbsolutePath(candidate);
        if (inferred) return inferred;
      }
    }
  }
  return null;
}

export function applyWorkspaceMetadataPrebackfill<TSession extends WorkspacePrebackfillSessionState>(input: {
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  messages: unknown[];
  session: TSession;
  requestId: string;
  extractMetadataFromMessages: (messages: unknown[]) => ClientMetadata;
  buildAdapterBlock: (pathContext: SessionPathHints) => string | undefined;
  setWorkspaceContext: (
    session: TSession,
    status: "ready",
    requestId: string,
    details: { reason: string; projectRoot?: string; cwd?: string; shell?: string; os?: string; arch?: string },
  ) => void;
  logInfo?: (record: Record<string, unknown>, message: string) => void;
  logSessionKey?: string;
}): WorkspacePrebackfillResult {
  if (input.pathContext.projectRoot && input.pathContext.shellCwd) {
    return {
      pathContext: input.pathContext,
      adapterBlock: input.adapterBlock,
      applied: false,
      metadata: null,
    };
  }

  const metadata = input.extractMetadataFromMessages(input.messages);
  const inferredRoot = inferWorkspaceRootFromToolEvidence(input.messages);
  if (!metadata.projectRoot && !metadata.shellCwd && !inferredRoot) {
    return {
      pathContext: input.pathContext,
      adapterBlock: input.adapterBlock,
      applied: false,
      metadata,
    };
  }

  const metadataWithInferredRoot: ClientMetadata = inferredRoot && !metadata.projectRoot && !metadata.shellCwd
    ? { ...metadata, projectRoot: inferredRoot, shellCwd: inferredRoot }
    : metadata;
  const pathContext = mergePathContextWithClientMetadata(input.pathContext, metadataWithInferredRoot);
  const adapterBlock = input.buildAdapterBlock(pathContext);

  input.setWorkspaceContext(input.session, "ready", input.requestId, {
    reason: inferredRoot && !metadata.projectRoot && !metadata.shellCwd
      ? "Inferred from prior tool execution evidence (pre-enrich)"
      : "Extracted from client system message (pre-enrich)",
    projectRoot: metadata.projectRoot ?? inferredRoot ?? undefined,
    cwd: metadata.shellCwd ?? inferredRoot ?? undefined,
    shell: metadata.shell ?? undefined,
    os: metadata.platform ?? undefined,
    arch: metadata.osVersion ?? undefined,
  });
  input.logInfo?.(
    {
      sessionKey: input.logSessionKey,
      projectRoot: metadata.projectRoot,
      shellCwd: metadata.shellCwd,
      inferredRoot,
      shell: metadata.shell,
      platform: metadata.platform,
    },
    "prefix_optimizer_metadata_prebackfill",
  );

  return {
    pathContext,
    adapterBlock,
    applied: true,
    metadata,
  };
}
