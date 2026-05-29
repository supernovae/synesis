import crypto from "node:crypto";
import { isShellWriteCommand } from "../governance/shell-write-command.js";

export type ToolProgressState = "stagnant" | "progress" | "unknown";

export type ToolProgressSessionState = {
  lastToolSignalHash: string;
  stagnantToolCycles: number;
};

export type ToolProgressMessage = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown }; name?: string; input?: unknown }>;
};

export interface ToolProgressDetectorOptions {
  normalizeSignal?: (content: unknown) => string;
  looksLikeFailure?: (signal: string) => boolean;
}

const WRITE_PROGRESS_TOOL_NAMES = new Set([
  "write",
  "writefile",
  "write_file",
  "filewrite",
  "edit",
  "update",
  "applypatch",
  "apply_patch",
  "strreplace",
  "str_replace",
  "replace",
  "multi_edit",
  "multiedit",
]);

function defaultNormalizeSignal(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

function defaultLooksLikeFailure(value: string): boolean {
  if (!value) return false;
  return /(fail|error|panic|traceback|exception|not found|undefined|cannot|fatal|exit code)/i.test(value);
}

function normalizeToolNameForProgress(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function resolveToolNameFromCallId(messages: ToolProgressMessage[], toolCallId: string): string {
  if (!toolCallId) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find((c) => typeof c?.id === "string" && c.id === toolCallId);
    if (!call) continue;
    const toolName = normalizeToolNameForProgress(call.function?.name ?? call.name);
    if (toolName) return toolName;
  }
  return "";
}

function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function commandFromToolInput(input: unknown): string {
  if (typeof input === "string") {
    const parsed = parseJsonObjectLoose(input);
    if (parsed) return commandFromToolInput(parsed);
    return input.replace(/\s+/g, " ").trim().slice(0, 512);
  }
  if (!input || typeof input !== "object") return "";
  const row = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, 512);
    }
  }
  const globPattern = row.glob_pattern;
  if (typeof globPattern === "string" && globPattern.trim()) {
    return `glob:${globPattern.replace(/\s+/g, " ").trim().slice(0, 256)}`;
  }
  const path = row.path ?? row.dir ?? row.directory;
  if (typeof path === "string" && path.trim()) {
    return `path:${path.replace(/\s+/g, " ").trim().slice(0, 256)}`;
  }
  return "";
}

function resolveToolCommandFromCallId(messages: ToolProgressMessage[], toolCallId: string): string {
  if (!toolCallId) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find((c) => typeof c?.id === "string" && c.id === toolCallId);
    if (!call) continue;
    const fromFunctionArgs = commandFromToolInput(call.function?.arguments);
    if (fromFunctionArgs) return fromFunctionArgs;
    const fromInput = commandFromToolInput(call.input);
    if (fromInput) return fromInput;
  }
  return "";
}

export function detectToolProgress(
  session: ToolProgressSessionState,
  messages: ToolProgressMessage[],
  options?: ToolProgressDetectorOptions,
): { state: ToolProgressState; signalHash: string | null } {
  const normalizeSignal = options?.normalizeSignal ?? defaultNormalizeSignal;
  const looksLikeFailure = options?.looksLikeFailure ?? defaultLooksLikeFailure;

  const toolMessages = [...messages].reverse().filter((m) => m.role === "tool" || m.role === "tool_result");
  if (toolMessages.length === 0) {
    return { state: "unknown", signalHash: null };
  }
  const latest = toolMessages[0];
  const signal = normalizeSignal(latest.content).slice(0, 4000);
  const failureSignal = looksLikeFailure(signal);

  const latestToolName = (() => {
    const direct = normalizeToolNameForProgress(latest.name);
    if (direct) return direct;
    const toolCallId = typeof latest.tool_call_id === "string" ? latest.tool_call_id : "";
    return resolveToolNameFromCallId(messages, toolCallId);
  })();
  const latestToolCallId = typeof latest.tool_call_id === "string" ? latest.tool_call_id : "";
  const latestToolCommand = resolveToolCommandFromCallId(messages, latestToolCallId);
  const isWriteProgressTool = WRITE_PROGRESS_TOOL_NAMES.has(latestToolName);
  const isShellWriteProgressTool = latestToolName === "bash" && isShellWriteCommand(latestToolCommand);

  // Treat successful write/edit outputs as progress even if output text repeats.
  if ((isWriteProgressTool || isShellWriteProgressTool) && !failureSignal && (signal || latestToolCommand)) {
    const hash = crypto.createHash("sha256").update(isShellWriteProgressTool ? latestToolCommand : signal).digest("hex");
    session.lastToolSignalHash = hash;
    session.stagnantToolCycles = 0;
    return { state: "progress", signalHash: hash };
  }

  const hashSource = failureSignal
    ? isWriteProgressTool
      ? `failure:${latestToolName || "unknown_tool"}`
      : `failure:${latestToolName || "unknown_tool"}:${latestToolCommand || "unknown_command"}:${signal.slice(0, 1200)}`
    : signal;
  const hash = crypto.createHash("sha256").update(hashSource).digest("hex");

  if (!session.lastToolSignalHash) {
    session.lastToolSignalHash = hash;
    session.stagnantToolCycles = 0;
    return { state: "progress", signalHash: hash };
  }
  if (session.lastToolSignalHash === hash) {
    session.stagnantToolCycles += 1;
    return { state: "stagnant", signalHash: hash };
  }
  session.lastToolSignalHash = hash;
  session.stagnantToolCycles = 0;
  return { state: "progress", signalHash: hash };
}
