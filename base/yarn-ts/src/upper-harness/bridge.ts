import {
  DEFAULT_MASTER_HARNESS_POLICY,
  evaluateUpperHarness,
  type MasterHarnessPolicyV1,
  type UpperHarnessDecision,
} from "@synesis/upper-harness";
import type { ModelAdapter } from "../providers/model-adapter.js";

export type { UpperHarnessDecision } from "@synesis/upper-harness";

export type YarnUpperHarnessSurface = "openai" | "claude" | "acp";

export interface YarnUpperHarnessContext {
  surface: YarnUpperHarnessSurface;
  modelId: string;
  provider?: string;
  family?: string;
}

export interface BuildYarnUpperHarnessContextOptions {
  surface: YarnUpperHarnessSurface;
  modelId: string;
  requestedModel?: string;
  adapter?: ModelAdapter;
  baseUrl?: string | null;
  provider?: string | null;
}

export interface UpperHarnessToolResult {
  toolName: string;
  input: Record<string, unknown>;
  decision: UpperHarnessDecision;
  repaired: boolean;
  blocked: boolean;
}

export interface UpperHarnessBudgetResult {
  decision: UpperHarnessDecision;
  blocked: boolean;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function inferProvider(baseUrl: string | null | undefined, explicitProvider?: string | null): string | undefined {
  const explicit = clean(explicitProvider);
  if (explicit) return explicit;
  const lower = String(baseUrl ?? "").toLowerCase();
  if (!lower) return undefined;
  if (lower.includes("dashscope")) return "dashscope";
  if (lower.includes("moonshot") || lower.includes("kimi")) return "moonshot";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("openrouter")) return "openrouter";
  if (lower.includes("vllm")) return "vllm";
  if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes(".svc.cluster.local")) return "vllm";
  return undefined;
}

function modelIdForCardMatching(options: BuildYarnUpperHarnessContextOptions): string {
  return clean(options.modelId) ?? clean(options.requestedModel) ?? "unknown";
}

export function buildYarnUpperHarnessContext(
  options: BuildYarnUpperHarnessContextOptions,
): YarnUpperHarnessContext {
  return {
    surface: options.surface,
    modelId: modelIdForCardMatching(options),
    provider: inferProvider(options.baseUrl, options.provider),
    family: clean(options.adapter?.family),
  };
}

export function applyUpperHarnessToolCall(options: {
  context: YarnUpperHarnessContext;
  toolName: string;
  input: Record<string, unknown>;
  recentToolNames?: string[];
}): UpperHarnessToolResult {
  const decision = evaluateUpperHarness({
    modelId: options.context.modelId,
    provider: options.context.provider,
    family: options.context.family,
    toolCall: {
      toolName: options.toolName,
      input: options.input,
    },
    recentToolNames: options.recentToolNames,
  });
  const repaired = decision.repaired_tool_call;
  return {
    toolName: repaired?.toolName ?? options.toolName,
    input: repaired?.input ?? options.input,
    decision,
    repaired: Boolean(repaired),
    blocked: decision.action === "block",
  };
}

export function buildUpperHarnessBudgetPolicy(options: {
  surface: YarnUpperHarnessSurface;
  ceilingTokens: number;
  outputReserveTokens: number;
}): MasterHarnessPolicyV1 {
  return {
    ...DEFAULT_MASTER_HARNESS_POLICY,
    id: `synesis-master-${options.surface}`,
    token_budget: {
      ...DEFAULT_MASTER_HARNESS_POLICY.token_budget,
      ceiling_tokens: Math.max(1, Math.trunc(options.ceilingTokens)),
      output_reserve_tokens: Math.max(0, Math.trunc(options.outputReserveTokens)),
    },
  };
}

export function evaluateUpperHarnessBudget(options: {
  context: YarnUpperHarnessContext;
  estimatedInputTokens: number;
  ceilingTokens: number;
  outputReserveTokens: number;
}): UpperHarnessBudgetResult {
  const decision = evaluateUpperHarness({
    modelId: options.context.modelId,
    provider: options.context.provider,
    family: options.context.family,
    masterPolicy: buildUpperHarnessBudgetPolicy({
      surface: options.context.surface,
      ceilingTokens: options.ceilingTokens,
      outputReserveTokens: options.outputReserveTokens,
    }),
    tokenBudget: {
      estimatedInputTokens: Math.max(0, Math.trunc(options.estimatedInputTokens)),
    },
  });
  return {
    decision,
    blocked: decision.action === "block",
  };
}

export function upperHarnessBlockPayload(
  decision: UpperHarnessDecision,
  originalToolName: string,
): Record<string, unknown> {
  const blockedEvent = decision.events.find((event) => event.action === "block");
  const reason = decision.safety?.reason ?? blockedEvent?.reason ?? "tool call blocked by upper harness";
  return {
    synesis_error: true,
    schema_version: 1,
    category: "upper_harness",
    reason: "upper_harness_blocked",
    original_tool: originalToolName,
    message: `Synesis upper harness blocked ${originalToolName}: ${reason}`,
    retryable: decision.safety?.matchedRules.includes("safety.shell.rm_rf") ? false : true,
    matched_rules: blockedEvent?.matched_rules ?? decision.safety?.matchedRules ?? [],
    harness_card_id: decision.harness_card_id,
    master_policy_id: decision.master_policy_id,
  };
}

export function formatUpperHarnessDecisionSummary(decision: UpperHarnessDecision): string {
  const budget = decision.budget
    ? ` budget=${decision.budget.zone} estimated=${decision.budget.estimatedInputTokens} headroom=${decision.budget.headroomTokens}`
    : "";
  const events = decision.events
    .filter((event) => event.action !== "allow")
    .map((event) => `${event.domain}:${event.action}:${event.matched_rules.join("|")}`)
    .join(",");
  return `action=${decision.action} card=${decision.harness_card_id} policy=${decision.master_policy_id}${budget}${events ? ` events=${events}` : ""}`;
}
