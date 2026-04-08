import { suggestScopedVerificationCommand } from "../verification/test-scope-selector.js";

export interface GovernorInputMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
}

export interface ExecutionGovernorDecision {
  pause: boolean;
  reason: string;
  suggestedNextStep?: string;
  matchedRules: string[];
  telemetry: {
    repeatedTestCommands: number;
    repeatedReadSearchCalls: number;
    broadTestRepeat: boolean;
    noEditEvidence: boolean;
  };
}

function normalizeString(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return "";
}

function parseArgsToCommand(args: unknown): string {
  if (typeof args === "string") {
    const t = args.trim();
    if (t.startsWith("{")) {
      try {
        const row = JSON.parse(t) as Record<string, unknown>;
        return parseArgsToCommand(row);
      } catch {
        return normalizeString(args);
      }
    }
    return normalizeString(args);
  }
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  for (const k of ["command", "cmd", "script"]) {
    if (typeof row[k] === "string") return normalizeString(row[k]);
  }
  return "";
}

function extractCommandEvents(messages: GovernorInputMessage[]): Array<{ command: string; toolName: string }> {
  const callById = new Map<string, { command: string; toolName: string }>();
  const out: Array<{ command: string; toolName: string }> = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const id = normalizeString(call.id);
        if (!id) continue;
        const toolName = normalizeString(call.function?.name ?? call.name).toLowerCase();
        const command = parseArgsToCommand(call.function?.arguments ?? call.input);
        if (!command) continue;
        callById.set(id, { command, toolName });
      }
      continue;
    }
    if (msg.role !== "tool" && msg.role !== "tool_result") continue;
    const id = normalizeString(msg.tool_call_id);
    if (!id) continue;
    const item = callById.get(id);
    if (!item) continue;
    out.push(item);
  }
  return out;
}

function extractChangedFileHints(messages: GovernorInputMessage[]): string[] {
  const hints = new Set<string>();
  const joined = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n");
  const rx = /([a-zA-Z0-9_\-./]+?\.(?:go|ts|tsx|js|jsx|py|rs|java|kt|yaml|yml|json|md))/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(joined)) !== null) {
    hints.add(match[1]);
    if (hints.size >= 20) break;
  }
  return [...hints];
}

export function evaluateExecutionGovernor(messages: GovernorInputMessage[]): ExecutionGovernorDecision {
  const events = extractCommandEvents(messages);
  const changedFiles = extractChangedFileHints(messages);
  let repeatedTestCommands = 0;
  let repeatedReadSearchCalls = 0;
  let broadTestRepeat = false;
  const noEditEvidence = changedFiles.length === 0;
  const matchedRules: string[] = [];

  for (let i = 1; i < events.length; i += 1) {
    if (events[i].command !== events[i - 1].command) continue;
    const tool = events[i].toolName;
    if (tool.includes("run_test") || /\b(go test|npm test|pnpm test|yarn test)\b/i.test(events[i].command)) {
      repeatedTestCommands += 1;
      if (/go test \.\/\.\.\.|^npm test$|^pnpm test$|^yarn test$/i.test(events[i].command)) {
        broadTestRepeat = true;
      }
    }
    if (tool.includes("search") || tool.includes("read")) {
      repeatedReadSearchCalls += 1;
    }
  }

  if (broadTestRepeat) matchedRules.push("broad_to_narrow_verification");
  if (repeatedTestCommands >= 2) matchedRules.push("edit_before_retest");
  if (broadTestRepeat && repeatedTestCommands >= 1 && noEditEvidence) matchedRules.push("no_repeat_without_change");
  if (repeatedReadSearchCalls >= 3) matchedRules.push("bounded_exploration_budget");

  if (matchedRules.length === 0) {
    return {
      pause: false,
      reason: "ok",
      matchedRules: ["allow"],
      telemetry: { repeatedTestCommands, repeatedReadSearchCalls, broadTestRepeat, noEditEvidence },
    };
  }

  const latestTest = [...events]
    .reverse()
    .find((e) => /\b(go test|npm test|pnpm test|yarn test)\b/i.test(e.command));
  const scoped = latestTest
    ? suggestScopedVerificationCommand(latestTest.command, changedFiles)
    : { suggestedCommand: null };
  const suggestedNextStep = scoped.suggestedCommand
    ?? (noEditEvidence
      ? "Apply one focused code change for a single root-cause hypothesis, then run one narrow verification command."
      : "State one root-cause hypothesis and run one narrow verification command.");

  return {
    pause: true,
    reason: "Execution governor detected low-yield repetition. Pivot to a narrower, hypothesis-driven step.",
    suggestedNextStep,
    matchedRules,
    telemetry: { repeatedTestCommands, repeatedReadSearchCalls, broadTestRepeat, noEditEvidence },
  };
}

export function executionGovernorSoftFailMessage(decision: ExecutionGovernorDecision): string {
  return [
    "I paused to avoid a low-yield loop (repeating broad checks without enough new signal).",
    `Matched rules: ${decision.matchedRules.join(", ")}.`,
    `Next step: ${decision.suggestedNextStep ?? "pick one narrow verification step before continuing."}`,
  ].join(" ");
}
