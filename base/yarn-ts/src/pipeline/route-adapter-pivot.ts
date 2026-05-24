import type { ModelAdapter, RecentToolCall } from "../providers/model-adapter.js";

export interface RouteAdapterPivotLogger {
  info(record: Record<string, unknown>, message: string): void;
  warn(record: Record<string, unknown>, message: string): void;
}

export interface RouteAdapterPivotMessage {
  role: string;
  content?: unknown;
}

export interface RouteAdapterPivotInput<TMessage extends RouteAdapterPivotMessage> {
  surface: "openai" | "claude";
  adapter: ModelAdapter;
  sessionKey: string;
  requestId: string;
  modelMessages: TMessage[];
  normalizedMessages: Array<{ role: string; content: unknown }>;
  recentCalls: RecentToolCall[];
  recentUserPrompt?: string | null;
  governanceDisabled: boolean;
  toolLoopSteeringEnabled: boolean;
  governanceRecoveryActive: boolean;
  harnessTelemetryEnabled: boolean;
  skipTelemetry: Record<string, unknown>;
  cooldownTurns: number;
  stagnationWindow: number;
  stagnationThreshold: number;
  planNoActionLimit: number;
  editRetryLimit: number;
  dampeningLogEvent: string;
  logger: RouteAdapterPivotLogger;
  appendSystemMessageAndNormalize(messages: TMessage[], content: string): TMessage[];
  recordSessionEvent(eventKind: string, component: string, detail: string): void;
}

export interface RouteAdapterPivotResult<TMessage extends RouteAdapterPivotMessage> {
  modelMessages: TMessage[];
  recoveryActive: boolean;
  applied: boolean;
}

interface QwenPivotState {
  lastTurnMarker: number;
  /** How many consecutive pivots the model has ignored (same pattern fires again). */
  consecutiveIgnored: number;
}

const qwenInterventionBySession = new Map<string, Map<string, QwenPivotState>>();
const qwenInterventionTurnBySession = new Map<string, number>();

export function resetQwenInterventionOnUserTurn(sessionKey: string): void {
  qwenInterventionBySession.delete(sessionKey);
  qwenInterventionTurnBySession.delete(sessionKey);
}

function shouldSuppressQwenIntervention(
  sessionKey: string,
  turnMarker: number,
  pivotKind: string,
  cooldownTurnsRaw: number,
): "allow" | "suppress" | "hard_stop" {
  const byKind = qwenInterventionBySession.get(sessionKey);
  if (!byKind) return "allow";
  const state = byKind.get(pivotKind);
  if (!state) return "allow";

  if (state.consecutiveIgnored >= 5) {
    return "hard_stop";
  }

  const gap = turnMarker - state.lastTurnMarker;
  const cooldownTurns = Math.max(0, cooldownTurnsRaw);

  if (gap <= cooldownTurns && state.consecutiveIgnored === 0) {
    return "suppress";
  }

  return "allow";
}

function markQwenIntervention(sessionKey: string, turnMarker: number, pivotKind: string): void {
  let byKind = qwenInterventionBySession.get(sessionKey);
  if (!byKind) {
    byKind = new Map();
    qwenInterventionBySession.set(sessionKey, byKind);
  }
  const state = byKind.get(pivotKind);
  if (state) {
    state.consecutiveIgnored += 1;
    state.lastTurnMarker = turnMarker;
  } else {
    byKind.set(pivotKind, { lastTurnMarker: turnMarker, consecutiveIgnored: 0 });
  }
}

function nextQwenInterventionTurn(sessionKey: string): number {
  const next = (qwenInterventionTurnBySession.get(sessionKey) ?? 0) + 1;
  qwenInterventionTurnBySession.set(sessionKey, next);
  return next;
}

export function classifyQwenPivotEvent(
  prompt: string,
  recentToolCalls: RecentToolCall[],
  source: "early" | "dampening" = "early",
): string {
  if (source === "dampening") return "adapter_qwen_dampening";
  const tail = recentToolCalls.slice(-8);
  let consecutiveEditSameFile = 0;
  let lastEditPath = "";
  let readLikeCount = 0;
  let gitInspectionCount = 0;
  const sigCounts = new Map<string, number>();
  for (const call of tail) {
    const tool = call.toolName.trim().toLowerCase();
    const filePath = (call.filePath ?? "").trim();
    const sig = `${tool}:${filePath}`;
    sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
    if (tool === "edit" || tool === "update") {
      if (filePath && (lastEditPath === "" || lastEditPath === filePath)) {
        consecutiveEditSameFile += 1;
      } else {
        consecutiveEditSameFile = 1;
      }
      lastEditPath = filePath;
    }
    if (tool === "read" || tool === "cat" || tool === "head" || tool === "tail") {
      readLikeCount += 1;
    }
    if (tool === "bash") {
      const cmd = typeof call.args?.command === "string" ? call.args.command.toLowerCase() : "";
      if (
        /\bgit\s+status\b/.test(cmd)
        || /\bgit\s+diff\b/.test(cmd)
        || /\bgit\s+log\b/.test(cmd)
        || /\bgit\s+show\b/.test(cmd)
      ) {
        gitInspectionCount += 1;
      }
    }
  }
  if (consecutiveEditSameFile >= 3) return "adapter_qwen_edit_retry";
  if (gitInspectionCount >= 4) return "adapter_qwen_git_introspection";
  if (readLikeCount >= 3) return "adapter_qwen_read_loop";
  if ([...sigCounts.values()].some((v) => v >= 3)) return "adapter_qwen_repeated_intent";
  const p = prompt.toLowerCase();
  if (p.includes("implementation plan")) return "adapter_qwen_plan_no_action";
  if (p.includes("repeating the same intent")) return "adapter_qwen_repeated_intent";
  if (p.includes("attempted to edit")) return "adapter_qwen_edit_retry";
  if (p.includes("you have read")) return "adapter_qwen_read_loop";
  return "adapter_qwen_early_pivot";
}

export function extractRecentAssistantText(messages: Array<{ role: string; content: unknown }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const row = part as Record<string, unknown>;
          return typeof row.text === "string" ? row.text : "";
        })
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

export function extractRecentToolResultText(messages: Array<{ role: string; content: unknown }>): string | null {
  const chunks: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" && m.role !== "tool_result") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) {
      chunks.push(content.trim());
    } else if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const row = part as Record<string, unknown>;
          return typeof row.text === "string" ? row.text : "";
        })
        .join("\n")
        .trim();
      if (text) chunks.push(text);
    }
    if (chunks.length >= 4) break;
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n").slice(0, 6000);
}

function applyPivotPrompt<TMessage extends RouteAdapterPivotMessage>(
  input: RouteAdapterPivotInput<TMessage>,
  prompt: string,
  recentCalls: RecentToolCall[],
  turnMarker: number,
  source: "early" | "dampening",
): { modelMessages: TMessage[]; applied: boolean } {
  const pivotKind = classifyQwenPivotEvent(prompt, recentCalls, source);
  const decision = shouldSuppressQwenIntervention(
    input.sessionKey,
    turnMarker,
    pivotKind,
    input.cooldownTurns,
  );
  if (decision === "hard_stop") {
    input.logger.warn(
      { sessionKey: input.sessionKey, family: input.adapter.family, turnMarker, pivotKind },
      "adapter_qwen_ignored_pivot_hard_stop",
    );
    const forcedRecovery = `${prompt}\nCRITICAL: Do not ask the user for guidance. Continue autonomously by taking exactly one concrete action now: apply one focused Edit/Write that advances the requested task, then run one narrow verification command.`;
    const modelMessages = input.appendSystemMessageAndNormalize(input.modelMessages, forcedRecovery);
    markQwenIntervention(input.sessionKey, turnMarker, pivotKind);
    input.recordSessionEvent(
      "adapter_pivot_auto_recover",
      "adapter",
      source === "dampening"
        ? "dampening: forced continue after ignored pivots"
        : `${pivotKind}: forced continue after ignored pivots`,
    );
    return { modelMessages, applied: true };
  }
  if (decision === "suppress") {
    input.logger.info(
      { sessionKey: input.sessionKey, family: input.adapter.family, turnMarker },
      "adapter_qwen_cooldown_suppressed",
    );
    return { modelMessages: input.modelMessages, applied: false };
  }

  const modelMessages = input.appendSystemMessageAndNormalize(input.modelMessages, prompt);
  markQwenIntervention(input.sessionKey, turnMarker, pivotKind);
  if (source === "dampening") {
    input.logger.info(
      { sessionKey: input.sessionKey, family: input.adapter.family, dampenLen: prompt.length },
      input.dampeningLogEvent,
    );
  } else {
    input.logger.info(
      { sessionKey: input.sessionKey, family: input.adapter.family, pivotLen: prompt.length },
      pivotKind,
    );
  }
  return { modelMessages, applied: true };
}

export function applyRouteAdapterPivot<TMessage extends RouteAdapterPivotMessage>(
  input: RouteAdapterPivotInput<TMessage>,
): RouteAdapterPivotResult<TMessage> {
  let modelMessages = input.modelMessages;
  if (
    !input.governanceDisabled
    && input.toolLoopSteeringEnabled
    && input.governanceRecoveryActive
    && input.harnessTelemetryEnabled
  ) {
    input.logger.info(
      {
        reqId: input.requestId,
        ...input.skipTelemetry,
      },
      "yarn_harness_adapter_pivot_skipped",
    );
  }

  if (input.governanceDisabled || input.governanceRecoveryActive || !input.toolLoopSteeringEnabled) {
    return { modelMessages, recoveryActive: input.governanceRecoveryActive, applied: false };
  }

  const turnMarker = nextQwenInterventionTurn(input.sessionKey);
  let applied = false;
  const recentAssistantText = extractRecentAssistantText(input.normalizedMessages);
  const recentToolResultText = extractRecentToolResultText(input.normalizedMessages);

  if (input.adapter.getEarlyPivotPrompt) {
    const earlyPivot = input.adapter.getEarlyPivotPrompt(input.recentCalls, {
      recentAssistantText,
      recentUserPrompt: input.recentUserPrompt,
      recentToolResultText,
      stagnationWindow: input.stagnationWindow,
      stagnationThreshold: input.stagnationThreshold,
      planNoActionLimit: input.planNoActionLimit,
      editRetryLimit: input.editRetryLimit,
    });
    if (earlyPivot) {
      const result = applyPivotPrompt(
        { ...input, modelMessages },
        earlyPivot,
        input.recentCalls,
        turnMarker,
        "early",
      );
      modelMessages = result.modelMessages;
      applied = applied || result.applied;
    }
  }

  if (input.adapter.dampenConsecutiveSameTools) {
    const toolNames = input.recentCalls.map((c) => c.toolName);
    const dampening = input.adapter.dampenConsecutiveSameTools(toolNames);
    if (dampening) {
      const result = applyPivotPrompt(
        { ...input, modelMessages },
        dampening,
        input.recentCalls,
        turnMarker,
        "dampening",
      );
      modelMessages = result.modelMessages;
      applied = applied || result.applied;
    }
  }

  return { modelMessages, recoveryActive: input.governanceRecoveryActive, applied };
}
