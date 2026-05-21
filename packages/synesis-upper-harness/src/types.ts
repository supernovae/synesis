import { z } from "zod";

export const HARNESS_CARD_SCHEMA_VERSION = "synesis_harness_card_v1";
export const MASTER_HARNESS_POLICY_SCHEMA_VERSION = "synesis_master_harness_policy_v1";
export const UPPER_HARNESS_DECISION_SCHEMA_VERSION = "synesis_upper_harness_decision_v1";

export const DEFAULT_BLOCKED_PATH_PREFIXES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/private/etc",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/system",
  "/usr/bin",
  "/usr/sbin",
  "/var/db",
  "~/.ssh",
  "c:\\program files",
  "c:\\windows",
] as const;

const RatioSchema = z.number().min(0).max(1);

export const MasterHarnessPolicyV1Schema = z.object({
  schema_version: z.literal(MASTER_HARNESS_POLICY_SCHEMA_VERSION),
  id: z.string().min(1),
  mode: z.enum(["shadow", "opt_in", "enforced"]).default("shadow"),
  token_budget: z.object({
    ceiling_tokens: z.number().int().positive(),
    output_reserve_tokens: z.number().int().nonnegative().default(10_000),
    soft_ratio: RatioSchema.default(0.85),
    heavy_ratio: RatioSchema.default(0.95),
    emergency_ratio: RatioSchema.default(0.97),
    hard_ratio: RatioSchema.default(0.99),
  }),
  safety: z.object({
    block_dangerous_shell: z.boolean().default(true),
    enforce_path_sandbox: z.boolean().default(true),
    block_parent_path_traversal: z.boolean().default(true),
    blocked_path_prefixes: z.array(z.string().min(1)).default([...DEFAULT_BLOCKED_PATH_PREFIXES]),
    block_write_capable_tools: z.boolean().default(false),
  }).default({
    block_dangerous_shell: true,
    enforce_path_sandbox: true,
    block_parent_path_traversal: true,
    blocked_path_prefixes: [...DEFAULT_BLOCKED_PATH_PREFIXES],
    block_write_capable_tools: false,
  }),
  tracing: z.object({
    emit_harness_decision_event: z.boolean().default(true),
    include_raw_rules: z.boolean().default(true),
  }).default({
    emit_harness_decision_event: true,
    include_raw_rules: true,
  }),
});

export type MasterHarnessPolicyV1 = z.infer<typeof MasterHarnessPolicyV1Schema>;

export const ToolAliasMapSchema = z.record(z.string(), z.record(z.string(), z.string()));

export const HarnessCardV1Schema = z.object({
  schema_version: z.literal(HARNESS_CARD_SCHEMA_VERSION),
  id: z.string().min(1),
  display_name: z.string().min(1),
  model_match: z.object({
    exact_models: z.array(z.string()).default([]),
    family_prefixes: z.array(z.string()).default([]),
    model_substrings: z.array(z.string()).default([]),
    provider_hints: z.array(z.string()).default([]),
  }).default({
    exact_models: [],
    family_prefixes: [],
    model_substrings: [],
    provider_hints: [],
  }),
  capabilities: z.object({
    supports_thinking: z.boolean().default(false),
    native_tool_parser: z.boolean().default(false),
    max_effective_tools: z.number().int().positive().optional(),
    strict_json: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
    strict_tool_args: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
  }).default({
    supports_thinking: false,
    native_tool_parser: false,
    strict_json: "unknown",
    strict_tool_args: "unknown",
  }),
  repairs: z.object({
    argument_aliases: ToolAliasMapSchema.default({}),
    empty_arguments: z.enum(["preserve", "normalize_to_empty_object"]).default("preserve"),
    malformed_json: z.enum(["none", "conservative"]).default("none"),
  }).default({
    argument_aliases: {},
    empty_arguments: "preserve",
    malformed_json: "none",
  }),
  loop_controls: z.object({
    repeated_tool_dampening: z.boolean().default(false),
    plan_no_action_limit: z.number().int().positive().optional(),
    edit_retry_limit: z.number().int().positive().optional(),
  }).default({
    repeated_tool_dampening: false,
  }),
  sampling_defaults: z.object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
  }).default({}),
  plugin_id: z.string().min(1).optional(),
});

export type HarnessCardV1 = z.infer<typeof HarnessCardV1Schema>;

export type HarnessDecisionAction = "allow" | "repair" | "nudge" | "block";
export type HarnessDecisionDomain = "master" | "model_card" | "plugin";
export type TokenBudgetZone = "green" | "soft" | "heavy" | "emergency" | "reject";

export interface HarnessToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface TokenBudgetInput {
  estimatedInputTokens: number;
}

export interface BudgetDecision {
  zone: TokenBudgetZone;
  estimatedInputTokens: number;
  ceilingTokens: number;
  outputReserveTokens: number;
  hardLimitTokens: number;
  emergencyTokens: number;
  heavyTokens: number;
  softTokens: number;
  headroomTokens: number;
  matchedRules: string[];
}

export interface SafetyDecision {
  action: "allow" | "block";
  reason?: string;
  matchedRules: string[];
}

export interface ToolRepairDecision {
  input: Record<string, unknown>;
  repaired: boolean;
  matchedRules: string[];
}

export interface HarnessDecisionEvent {
  domain: HarnessDecisionDomain;
  action: HarnessDecisionAction;
  reason: string;
  matched_rules: string[];
}

export interface UpperHarnessDecision {
  schema_version: typeof UPPER_HARNESS_DECISION_SCHEMA_VERSION;
  action: HarnessDecisionAction;
  master_policy_id: string;
  master_policy_mode: MasterHarnessPolicyV1["mode"];
  harness_card_id: string;
  harness_card_display_name: string;
  model_id: string;
  provider?: string;
  events: HarnessDecisionEvent[];
  repaired_tool_call?: HarnessToolCall;
  budget?: BudgetDecision;
  safety?: SafetyDecision;
  trace: {
    event_kind: "upper_harness_decision_v1";
    systemic_rules: string[];
    model_rules: string[];
    plugin_rules: string[];
  };
}

export interface HarnessPluginContext {
  modelId: string;
  provider?: string;
  card: HarnessCardV1;
}

export interface HarnessPlugin {
  readonly id: string;
  normalizeToolArgs?(
    toolCall: HarnessToolCall,
    context: HarnessPluginContext,
  ): ToolRepairDecision;
  detectLoopRisk?(
    recentToolNames: string[],
    context: HarnessPluginContext,
  ): HarnessDecisionEvent | null;
}

export interface UpperHarnessInput {
  modelId: string;
  provider?: string;
  family?: string;
  cards?: HarnessCardV1[];
  masterPolicy?: MasterHarnessPolicyV1;
  pluginRegistry?: ReadonlyMap<string, HarnessPlugin>;
  tokenBudget?: TokenBudgetInput;
  toolCall?: HarnessToolCall;
  recentToolNames?: string[];
}
