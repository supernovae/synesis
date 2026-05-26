import crypto from "node:crypto";
import { normalizeCommandOutputForComparison } from "../reduction/output-normalization.js";

export type ToolLoopMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
};

export type CommandLoopSignal = {
  commandSignatureHash: string;
  commandRepeatCount: number;
  failureSignatureHash: string;
  broadDiscoveryRepeatCount: number;
};

const LOOP_TRACKED_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "terminal",
  "run_command",
  "run_terminal_command",
  "execute_command",
  "run_bash",
  "glob",
  "list_files",
  "read_dir",
  "read_directory",
]);

export function normalizeForSignal(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? "";
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeForSignal(v));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) out[key] = normalizeForSignal((value as Record<string, unknown>)[key]);
  return out;
}

export function stableSignalString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  return JSON.stringify(normalizeForSignal(value));
}

export function hashTextSignal(value: unknown): string {
  const text = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : stableSignalString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text.slice(0, 4000)).digest("hex");
}

function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
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

function commandFromArgs(args: unknown): string {
  if (typeof args === "string") {
    const parsed = parseJsonObjectLoose(args);
    if (parsed) {
      return commandFromArgs(parsed);
    }
    return args.replace(/\s+/g, " ").trim().slice(0, 512);
  }
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) {
      return v.replace(/\s+/g, " ").trim().slice(0, 512);
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

function isBroadDiscoveryLoopCall(toolName: string, command: string): boolean {
  const tool = toolName.toLowerCase();
  const cmd = command.toLowerCase();
  if (tool === "glob") {
    return cmd === "glob:*" || cmd === "glob:**/*" || cmd.startsWith("glob:**/");
  }
  return (tool === "list_files" || tool === "read_dir" || tool === "read_directory")
    && (cmd === "path:." || cmd === "path:/" || cmd === "path:");
}

export function normalizedToolOutputSignal(content: unknown): string {
  if (typeof content === "string") {
    return normalizeCommandOutputForComparison(content).slice(0, 1600);
  }
  return normalizeCommandOutputForComparison(stableSignalString(content)).slice(0, 1600);
}

export function looksLikeFailureSignal(value: string): boolean {
  if (!value) return false;
  return /(fail|error|panic|traceback|exception|not found|undefined|cannot|fatal|exit code)/i.test(value);
}

export function analyzeRecentCommandLoop(messages: ToolLoopMessage[]): CommandLoopSignal {
  const callMap = new Map<string, { command: string; toolName: string }>();
  const history: Array<{ command: string; toolName: string; failureHash: string }> = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = typeof call.id === "string" ? call.id : "";
        if (!id) continue;
        const toolName = String(call.function?.name ?? call.name ?? "").toLowerCase();
        if (!LOOP_TRACKED_TOOL_NAMES.has(toolName)) continue;
        const command = commandFromArgs(call.function?.arguments ?? call.input);
        if (!command) continue;
        callMap.set(id, { command, toolName });
      }
      continue;
    }
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    if (!toolCallId) continue;
    const call = callMap.get(toolCallId);
    if (!call) continue;
    const out = normalizedToolOutputSignal(message.content);
    const failureHash = looksLikeFailureSignal(out) ? hashTextSignal(out) : "";
    history.push({ command: call.command, toolName: call.toolName, failureHash });
  }
  if (history.length === 0) {
    return {
      commandSignatureHash: "",
      commandRepeatCount: 0,
      failureSignatureHash: "",
      broadDiscoveryRepeatCount: 0,
    };
  }

  const latest = history[history.length - 1];
  let commandRepeatCount = 0;
  let failureRepeatCount = 0;
  let broadDiscoveryRepeatCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].command !== latest.command) break;
    commandRepeatCount += 1;
    if (isBroadDiscoveryLoopCall(history[i].toolName, history[i].command)) {
      broadDiscoveryRepeatCount += 1;
    }
    if (latest.failureHash && history[i].failureHash === latest.failureHash) {
      failureRepeatCount += 1;
    }
  }

  return {
    commandSignatureHash: hashTextSignal(latest.command),
    commandRepeatCount,
    failureSignatureHash: failureRepeatCount >= 2 ? latest.failureHash : "",
    broadDiscoveryRepeatCount,
  };
}
