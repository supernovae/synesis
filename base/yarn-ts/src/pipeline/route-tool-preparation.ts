import { type ClientToolCapabilities, enrichToolSchemasForClient } from "../adapters/client-tool-capabilities.js";
import { extractToolSchemaName, pruneToolSchemas, type ToolPruningResult } from "../compat/tool-schema-pruning.js";
import { detectNonGitWorkspaceDiagnostic } from "../governance/non-git-workspace-diagnostic.js";
import { detectPythonRuntimeDiscoveryLoop } from "../governance/python-runtime-discovery-loop.js";
import { detectStdoutCaptureLoop } from "../governance/stdout-capture-loop.js";
import { detectVerificationRerunLoop } from "../governance/verification-rerun-loop.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";
import type { ModelAdapter, RecentToolCall } from "../providers/model-adapter.js";
import { mapToolChoice } from "../tool-mapping.js";

export interface RouteToolPreparationMessage {
  role: string;
  content: unknown;
}

export interface RouteToolPreparationStats {
  requestsConsidered: number;
  requestsPruned: number;
  toolsPrunedTotal: number;
}

export interface RouteToolPreparationLogger {
  info(record: Record<string, unknown>, message: string): void;
}

export type PreparedRouteToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string };

export interface RouteToolPreparationInput {
  rawTools: unknown[];
  adapter: ModelAdapter;
  clientCapabilities: ClientToolCapabilities;
  clientKind: string;
  phase: WorkflowPhase;
  profileToolBudgetCap?: number;
  pruningEnabled: boolean;
  pruningMaxOverride: number;
  toolChoice: unknown;
  latestUserContent?: unknown;
  recentCallMessages: RouteToolPreparationMessage[];
  recoveryMessages: RouteToolPreparationMessage[];
  governanceDisabled: boolean;
  toolLoopSteeringEnabled: boolean;
  harnessTelemetryEnabled: boolean;
  requestId: string;
  stats: RouteToolPreparationStats;
  logger: RouteToolPreparationLogger;
  isWriteCapableToolName(name: string): boolean;
  recordSessionEvent(eventKind: string, component: string, detail: string): void;
}

export interface RouteToolPreparationResult {
  toolBudget: number;
  recentCallsForSteering: RecentToolCall[];
  qwenLoopRisk: boolean;
  prunedTools: ToolPruningResult;
  effectiveTools: unknown[];
  clientToolChoice?: PreparedRouteToolChoice;
  invalidToolChoice: boolean;
}

export function extractRecentToolNames(messages: Array<{ role: string; content: unknown }>): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const toolCalls = row.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = (tc as Record<string, unknown>).function;
        if (fn && typeof fn === "object") {
          const n = (fn as Record<string, unknown>).name;
          if (typeof n === "string" && n.trim()) names.push(n.trim());
        }
      }
    }
  }
  return names;
}

export function extractRecentToolCallDetails(messages: Array<{ role: string; content: unknown }>): RecentToolCall[] {
  const resultByCallId = new Map<string, string>();
  for (const m of messages) {
    if ((m.role !== "tool" && m.role !== "tool_result") || !m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const id = row.tool_call_id;
    if (typeof id !== "string" || !id.trim()) continue;
    const content = row.content;
    resultByCallId.set(id.trim(), typeof content === "string" ? content : JSON.stringify(content ?? ""));
  }

  const calls: RecentToolCall[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const toolCalls = row.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const fn = (tc as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object") continue;
      const name = (fn as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim()) continue;
      let args: Record<string, unknown> | undefined;
      const rawArgs = (fn as Record<string, unknown>).arguments;
      const callId = (tc as Record<string, unknown>).id;
      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          // Ignore malformed historical tool arguments; later validators handle active calls.
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs as Record<string, unknown>;
      }
      const filePath = args?.file_path ?? args?.path ?? args?.filename;
      calls.push({
        toolName: name.trim(),
        filePath: typeof filePath === "string" ? filePath : undefined,
        args,
        resultContent: typeof callId === "string" ? resultByCallId.get(callId.trim()) : undefined,
      });
    }
  }
  return calls;
}

export function injectGovernorRecoveryMessage(
  messages: RouteToolPreparationMessage[],
  recovery: string,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (
      messages[i].role === "system"
      && typeof messages[i].content === "string"
      && (messages[i].content as string).includes("<SYNESIS_EXECUTION_RECOVERY")
    ) {
      messages.splice(i, 1);
    }
  }
  messages.push({ role: "system", content: recovery });
}

export function detectQwenLoopRisk(recentToolCalls: RecentToolCall[]): boolean {
  const tail = recentToolCalls.slice(-8).map((c) => c.toolName.toLowerCase());
  if (tail.length < 4) return false;
  const readSearch = new Set(["read", "grep", "glob", "find", "rg", "cat", "head", "tail"]);
  let run = 0;
  let maxRun = 0;
  for (const t of tail) {
    if (readSearch.has(t)) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  return maxRun >= 3;
}

export function prioritizeWriteCapableTools(
  tools: unknown[],
  prioritize: boolean,
  isWriteCapableToolName: (name: string) => boolean,
): unknown[] {
  if (!prioritize) return tools;
  const writeLike: unknown[] = [];
  const others: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      others.push(tool);
      continue;
    }
    const row = tool as Record<string, unknown>;
    const openAIName = row.type === "function" && row.function && typeof row.function === "object"
      ? (row.function as Record<string, unknown>).name
      : undefined;
    const directName = row.name;
    const name = typeof openAIName === "string" ? openAIName : (typeof directName === "string" ? directName : "");
    if (name && isWriteCapableToolName(name)) {
      writeLike.push(tool);
    } else {
      others.push(tool);
    }
  }
  return [...writeLike, ...others];
}

export function enrichToolSchemasForAdapter(
  tools: unknown[],
  adapter: ModelAdapter,
): unknown[] {
  if (!adapter.enrichToolDescription || (adapter.family !== "qwen3-coder" && adapter.family !== "minimax")) {
    return tools;
  }
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const t = tool as Record<string, unknown>;
    if (t.type === "function" && t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>;
      const name = fn.name;
      const desc = fn.description;
      if (typeof name === "string" && typeof desc === "string") {
        const enriched = adapter.enrichToolDescription!(name, desc);
        if (enriched !== desc) {
          return { ...t, function: { ...fn, description: enriched } };
        }
      }
      return tool;
    }
    const name = t.name;
    const desc = t.description;
    if (typeof name === "string" && typeof desc === "string") {
      const enriched = adapter.enrichToolDescription!(name, desc);
      if (enriched !== desc) {
        return { ...t, description: enriched };
      }
    }
    return tool;
  });
}

export function extractRequestedToolNames(userText: string, tools: unknown[]): string[] {
  const t = userText.toLowerCase();
  if (!t.trim()) return [];
  const requested: string[] = [];
  for (const tool of tools) {
    const name = extractToolSchemaName(tool);
    if (!name) continue;
    const norm = name.toLowerCase();
    if (t.includes(norm) || t.includes(`tool ${norm}`) || t.includes(`use ${norm}`)) {
      requested.push(name);
    }
  }
  return requested;
}

export function resolveToolSchemaBudget(input: {
  enabled: boolean;
  maxOverride: number;
  adapterMaxEffectiveTools: number | undefined;
  profileToolBudgetCap: number | undefined;
}): number {
  if (!input.enabled) return 0;
  const override = input.maxOverride;
  let adapterLimit = input.adapterMaxEffectiveTools ?? 0;
  if (input.profileToolBudgetCap && input.profileToolBudgetCap > 0) {
    adapterLimit = adapterLimit > 0
      ? Math.min(adapterLimit, input.profileToolBudgetCap)
      : input.profileToolBudgetCap;
  }
  if (override > 0 && adapterLimit > 0) return Math.min(override, adapterLimit);
  if (override > 0) return override;
  return adapterLimit;
}

export function adjustToolSchemaBudgetForSession(
  baseBudget: number,
  phase: WorkflowPhase,
  clientKind: string,
): number {
  if (baseBudget <= 0) return baseBudget;
  const client = clientKind.toLowerCase();
  const codingClient = client.includes("claude-code") || client.includes("cursor");
  if (!codingClient) return baseBudget;

  if (phase === "validation") return Math.max(1, Math.min(baseBudget, 6));
  if (phase === "implementation") return Math.max(1, Math.min(baseBudget, 8));
  if (phase === "planning") return Math.max(1, Math.min(baseBudget, 10));
  return Math.max(1, Math.min(baseBudget, 8));
}

export function prepareRouteTools(input: RouteToolPreparationInput): RouteToolPreparationResult {
  const toolBudget = adjustToolSchemaBudgetForSession(
    resolveToolSchemaBudget({
      enabled: input.pruningEnabled,
      maxOverride: input.pruningMaxOverride,
      adapterMaxEffectiveTools: input.adapter.maxEffectiveTools,
      profileToolBudgetCap: input.profileToolBudgetCap,
    }),
    input.phase,
    input.clientKind,
  );
  const recentCallsForSteering = extractRecentToolCallDetails(input.recentCallMessages);

  if (!input.governanceDisabled) {
    const captureLoop = detectStdoutCaptureLoop(recentCallsForSteering);
    if (captureLoop) {
      injectGovernorRecoveryMessage(input.recoveryMessages, captureLoop.guidance);
      input.recordSessionEvent(
        "stdout_capture_loop_detected",
        "governor",
        `base_cmd=${captureLoop.baseCommand.slice(0, 80)} retries=${captureLoop.retryCount}`,
      );
      if (input.harnessTelemetryEnabled) {
        input.logger.info(
          {
            reqId: input.requestId,
            baseCommand: captureLoop.baseCommand.slice(0, 120),
            retryCount: captureLoop.retryCount,
          },
          "yarn_harness_stdout_capture_loop",
        );
      }
    }

    const rerunLoop = detectVerificationRerunLoop(recentCallsForSteering);
    if (rerunLoop) {
      injectGovernorRecoveryMessage(input.recoveryMessages, rerunLoop.guidance);
      input.recordSessionEvent(
        "verification_rerun_loop_detected",
        "governor",
        `fingerprint=${rerunLoop.fingerprint.slice(0, 120)} repeats=${rerunLoop.repeatCount}`,
      );
    }

    const nonGitWorkspace = detectNonGitWorkspaceDiagnostic(recentCallsForSteering);
    if (nonGitWorkspace) {
      injectGovernorRecoveryMessage(input.recoveryMessages, nonGitWorkspace.guidance);
      input.recordSessionEvent(
        "non_git_workspace_diagnostic",
        "governor",
        `source=${nonGitWorkspace.source}`,
      );
    }

    const pyRuntimeLoop = detectPythonRuntimeDiscoveryLoop(recentCallsForSteering);
    if (pyRuntimeLoop) {
      injectGovernorRecoveryMessage(input.recoveryMessages, pyRuntimeLoop.guidance);
      input.recordSessionEvent(
        "python_runtime_discovery_loop_detected",
        "governor",
        `attempts=${pyRuntimeLoop.attempts} variants=${pyRuntimeLoop.runtimeVariants.join(",")}`,
      );
    }
  }

  const qwenLoopRisk = input.toolLoopSteeringEnabled && detectQwenLoopRisk(recentCallsForSteering);
  const prunedTools = pruneToolSchemas(
    input.rawTools,
    toolBudget,
    extractRecentToolNames(input.recentCallMessages),
    extractRequestedToolNames(String(input.latestUserContent ?? ""), input.rawTools),
  );
  input.stats.requestsConsidered += 1;
  if (prunedTools.pruned) {
    input.stats.requestsPruned += 1;
    input.stats.toolsPrunedTotal += prunedTools.prunedCount;
  }

  const prioritizedTools = prioritizeWriteCapableTools(
    prunedTools.tools,
    qwenLoopRisk,
    input.isWriteCapableToolName,
  );
  const adapterEnrichedTools = enrichToolSchemasForAdapter(prioritizedTools, input.adapter);
  const effectiveTools = enrichToolSchemasForClient(adapterEnrichedTools as unknown[], input.clientCapabilities);
  const clientToolChoice = mapToolChoice(input.toolChoice);

  return {
    toolBudget,
    recentCallsForSteering,
    qwenLoopRisk,
    prunedTools,
    effectiveTools,
    clientToolChoice,
    invalidToolChoice: input.toolChoice !== undefined && clientToolChoice === undefined,
  };
}
