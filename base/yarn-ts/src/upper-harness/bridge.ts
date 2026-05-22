import {
  DEFAULT_MASTER_HARNESS_POLICY,
  buildPromptIntakeSystemBlock,
  evaluatePromptIntake,
  evaluateUpperHarness,
  type MasterHarnessPolicyV1,
  type PromptIntakeDecision,
  type UpperHarnessDecision,
} from "@synesis/upper-harness";
import type { ModelAdapter } from "../providers/model-adapter.js";
import { isPlanModePrompt, type ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";

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

export interface YarnPromptIntakeResult {
  decision: PromptIntakeDecision;
  systemBlock?: string;
  shouldAppend: boolean;
  metadataSnapshot: Record<string, unknown>;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function cleanStyle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return /^(true|1|yes|on)$/i.test(value.trim());
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstStyle(...records: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const record of records) {
    const style = cleanStyle(record?.synesis_custom_style ?? record?.custom_style);
    if (style) return style;
  }
  return undefined;
}

export function readPromptIntakeRequestOptions(options: {
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
}): { planningOverride: boolean; customStyle?: string; planModeRequested: boolean } {
  const metadata = objectOrUndefined(options.metadata);
  const extraBody = objectOrUndefined(options.extraBody);
  return {
    planningOverride: truthy(metadata?.synesis_planning_override)
      || truthy(metadata?.planning_override)
      || truthy(extraBody?.synesis_planning_override)
      || truthy(extraBody?.planning_override),
    planModeRequested: truthy(metadata?.synesis_plan_mode)
      || truthy(metadata?.plan_mode)
      || truthy(extraBody?.synesis_plan_mode)
      || truthy(extraBody?.plan_mode),
    customStyle: firstStyle(metadata, extraBody),
  };
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

export function evaluateYarnPromptIntakeSteer(options: {
  enabled: boolean;
  latestUserPrompt: string | undefined;
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  clientToolCapabilities?: ClientToolCapabilities | null;
}): YarnPromptIntakeResult {
  const requestOptions = readPromptIntakeRequestOptions({
    metadata: options.metadata,
    extraBody: options.extraBody,
  });
  const planModeRequested = requestOptions.planModeRequested
    || isPlanModePrompt(options.latestUserPrompt)
    || options.clientToolCapabilities?.planModeRequested === true;
  const decision = evaluatePromptIntake({
    prompt: options.latestUserPrompt ?? "",
    planningOverride: requestOptions.planningOverride,
    customStyle: requestOptions.customStyle,
  });
  const systemBlock = options.enabled
    ? buildYarnPromptIntakeSystemBlock(decision, options.clientToolCapabilities ?? null, planModeRequested) ?? undefined
    : undefined;
  return {
    decision,
    systemBlock,
    shouldAppend: Boolean(systemBlock),
    metadataSnapshot: {
      schema_version: decision.schema_version,
      scope: decision.scope,
      action: decision.action,
      planning_steered: Boolean(systemBlock),
      override: decision.override,
      plan_mode_requested: planModeRequested,
      source_hash: decision.source_hash,
      reasons: decision.reasons,
      enabled: options.enabled,
      ...(options.clientToolCapabilities?.hasTodoTool ? { task_tool: options.clientToolCapabilities.todoToolName } : {}),
      ...(options.clientToolCapabilities?.hasQuestionTool ? { question_tool: options.clientToolCapabilities.questionToolName } : {}),
      ...(decision.custom_style ? { custom_style_present: true } : {}),
    },
  };
}

function buildYarnPromptIntakeSystemBlock(
  decision: PromptIntakeDecision,
  capabilities: ClientToolCapabilities | null,
  planModeRequested: boolean,
): string | null {
  const base = buildPromptIntakeSystemBlock(decision);
  if (!planModeRequested && !base) return null;

  const taskTool = capabilities?.hasTodoTool && capabilities.todoToolName ? capabilities.todoToolName : "";
  const questionTool = capabilities?.hasQuestionTool && capabilities.questionToolName ? capabilities.questionToolName : "";
  const action = planModeRequested ? "plan_mode_requested" : "planning_suggested";
  const lines = [
    `<synesis_prompt_intake scope="${decision.scope}" action="${action}" source_hash="${decision.source_hash}">`,
  ];

  if (planModeRequested) {
    lines.push("The user explicitly requested plan mode. Do not perform implementation edits in this turn unless the user explicitly also requested execution.");
    lines.push("Produce or record a concise plan, then stop after the plan/todos or after asking required clarification questions.");
  } else {
    lines.push("This request appears broader than a micro edit. Before coding, suggest creating or approving a short plan, task list, or todos.");
    lines.push("Keep this advisory: do not claim planning is mandatory, do not block progress, and if the user declines or explicitly says to proceed, continue normally with small scoped steps.");
  }

  if (questionTool) {
    lines.push(`If key requirements are ambiguous, prefer calling ${questionTool} with concise options before creating todos or editing.`);
  }
  if (taskTool) {
    lines.push(`If no clarification is needed, prefer calling ${taskTool} with 3-7 concrete todos before implementation, then update todo statuses as work progresses.`);
  } else {
    lines.push("Prefer durable task tracking when the client supports it; otherwise keep the plan concise in the response.");
  }
  if (capabilities?.hasApplyPatchTool && capabilities.applyPatchToolName) {
    lines.push(`When execution later begins, prefer ${capabilities.applyPatchToolName} or targeted edit for existing files after reading context.`);
  }
  const reasons = decision.reasons.slice(0, 6).join(",");
  lines.push(`classifier_reasons=${reasons || "macro"}`);
  if (decision.custom_style) {
    lines.push(`User style preference: ${decision.custom_style}`);
  }
  lines.push("</synesis_prompt_intake>");
  return lines.join("\n");
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
