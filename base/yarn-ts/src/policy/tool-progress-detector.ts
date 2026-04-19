import crypto from "node:crypto";

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
  tool_calls?: Array<{ id?: string; function?: { name?: string }; name?: string }>;
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
  const hash = crypto.createHash("sha256").update(signal).digest("hex");

  const latestToolName = (() => {
    const direct = normalizeToolNameForProgress(latest.name);
    if (direct) return direct;
    const toolCallId = typeof latest.tool_call_id === "string" ? latest.tool_call_id : "";
    return resolveToolNameFromCallId(messages, toolCallId);
  })();

  // Treat successful write/edit outputs as progress even if output text repeats.
  if (WRITE_PROGRESS_TOOL_NAMES.has(latestToolName) && signal && !looksLikeFailure(signal)) {
    session.lastToolSignalHash = hash;
    session.stagnantToolCycles = 0;
    return { state: "progress", signalHash: hash };
  }

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
