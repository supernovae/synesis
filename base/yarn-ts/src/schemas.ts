import { z } from "zod";
import { JsonSchemaContractSchema } from "./json-schema-contract.js";
import { SynesisClarificationRoundSchema } from "./validation/clarification-schema.js";

export const RoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

const MAX_MESSAGE_CONTENT_CHARS = 2_000_000;
const MAX_CONTENT_PARTS = 512;
const MAX_JSON_ARRAY_ITEMS = 512;
const MAX_JSON_OBJECT_KEYS = 256;

type BoundedJsonValue =
  | string
  | number
  | boolean
  | null
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

const BoundedJsonValueSchema: z.ZodType<BoundedJsonValue> = z.lazy(() => z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(BoundedJsonValueSchema).max(MAX_JSON_ARRAY_ITEMS),
  z.record(z.string().min(1).max(128), BoundedJsonValueSchema).superRefine((value, ctx) => {
    if (Object.keys(value).length > MAX_JSON_OBJECT_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `Object exceeds ${MAX_JSON_OBJECT_KEYS} keys`,
      });
    }
  }),
]));

const CacheControlSchema = z.object({
  type: z.literal("ephemeral"),
}).strict();

const TextContentPartSchema = z.object({
  type: z.enum(["text", "input_text", "output_text"]).optional(),
  text: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  cache_control: CacheControlSchema.optional(),
}).strict();

const OpenAIImageUrlSchema = z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.object({
    url: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    detail: z.string().max(64).optional(),
  }).strict(),
]);

const OpenAIImageContentPartSchema = z.object({
  type: z.enum(["image_url", "input_image"]),
  image_url: OpenAIImageUrlSchema.optional(),
  detail: z.string().max(64).optional(),
}).strict();

const OpenAIInputAudioContentPartSchema = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    format: z.string().max(32),
  }).strict(),
}).strict();

const OpenAIFileContentPartSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    file_data: z.string().max(MAX_MESSAGE_CONTENT_CHARS).optional(),
    file_id: z.string().max(256).optional(),
    filename: z.string().max(1024).optional(),
  }).strict(),
}).strict();

const OpenAIRefusalContentPartSchema = z.object({
  type: z.literal("refusal"),
  refusal: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
}).strict();

const OpenAIContentPartSchema = z.union([
  TextContentPartSchema,
  OpenAIImageContentPartSchema,
  OpenAIInputAudioContentPartSchema,
  OpenAIFileContentPartSchema,
  OpenAIRefusalContentPartSchema,
]);

const OpenAIMessageContentSchema = z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.array(z.union([z.string().max(MAX_MESSAGE_CONTENT_CHARS), OpenAIContentPartSchema])).max(MAX_CONTENT_PARTS),
  z.null(),
]);

function normalizeControlValue(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

const PipelineModeSchema = z.string().trim().max(32).transform(normalizeControlValue).pipe(
  z.enum(["raw", "compat", "optimized", "governed", "workflow"]),
);

const PlanningBooleanControlSchema = z.union([
  z.boolean(),
  z.string().trim().max(32).transform(normalizeControlValue).pipe(
    z.enum(["true", "false", "yes", "no", "1", "0", "on", "off"]),
  ),
]);

const ContextMediationControlSchema = z.string().trim().max(64).transform(normalizeControlValue).pipe(
  z.enum([
    "off",
    "none",
    "disabled",
    "disable",
    "hands_off",
    "passthrough",
    "observe",
    "observer",
    "diagnostic",
    "diagnostics",
    "trace",
    "report",
    "safe",
    "guarded",
    "conservative",
    "adapt",
    "adaptive",
    "auto",
    "default",
    "enabled",
    "on",
    "aggressive",
    "strict",
    "strong",
    "enforced",
    "assertive",
    "always",
  ]),
);

const ArchitectureProfileSourceSchema = z.string().trim().max(64)
  .transform((value) => {
    const normalized = normalizeControlValue(value);
    return normalized === "model_registry" ? "model-registry" : normalized;
  })
  .pipe(z.enum(["raw", "none", "passthrough", "auto", "infer", "inferred", "model-registry"]));

const SynesisExtraBodySchema = z.object({
  contextMediation: ContextMediationControlSchema.optional(),
  architectureProfile: ArchitectureProfileSourceSchema.optional(),
}).strict();

const SynesisRuntimeMetadataSchema = z.object({
  platform: z.string().max(64).optional(),
  os_version: z.string().max(128).optional(),
  shell: z.string().max(128).optional(),
}).strict();

const SynesisAcpSessionMetadataSchema = z.object({
  additional_directory_count: z.number().int().min(0).max(256).optional(),
  mcp_server_count: z.number().int().min(0).max(256).optional(),
}).strict();

export const RequestMetadataSchema = z.object({
  session: z.string().max(256).optional(),
  session_id: z.string().max(256).optional(),
  conversation_id: z.string().max(256).optional(),
  synesis_conversation_id: z.string().max(256).optional(),
  thread_id: z.string().max(256).optional(),
  chat_id: z.string().max(256).optional(),
  trace: z.string().max(256).optional(),
  trace_id: z.string().max(256).optional(),
  request_id: z.string().max(256).optional(),
  user_id: z.string().max(256).optional(),
  synesis_client: z.string().max(128).optional(),
  client: z.string().max(128).optional(),
  workspace: z.string().max(2048).optional(),
  synesis_mode: PipelineModeSchema.optional(),
  synesis: SynesisExtraBodySchema.optional(),
  synesis_planning_override: PlanningBooleanControlSchema.optional(),
  synesis_plan_mode: PlanningBooleanControlSchema.optional(),
  synesis_custom_style: z.string().max(2000).optional(),
  custom_style: z.string().max(2000).optional(),
  synesis_context_mediation: ContextMediationControlSchema.optional(),
  synesis_memory: ContextMediationControlSchema.optional(),
  synesis_work_packet: ContextMediationControlSchema.optional(),
  synesis_memory_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_mediation: ContextMediationControlSchema.optional(),
  architecture_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_profile: ArchitectureProfileSourceSchema.optional(),
  synesis_project_root: z.string().max(2048).optional(),
  synesis_shell_cwd: z.string().max(2048).optional(),
  synesis_runtime: SynesisRuntimeMetadataSchema.optional(),
  synesis_git_summary: z.string().max(4096).optional(),
  synesis_git_is_repo: z.boolean().optional(),
  synesis_git_branch: z.string().max(256).optional(),
  synesis_git_dirty: z.boolean().optional(),
  synesis_git_has_untracked: z.boolean().optional(),
  synesis_git_ahead: z.number().int().min(0).max(1_000_000).optional(),
  synesis_git_behind: z.number().int().min(0).max(1_000_000).optional(),
  synesis_client_model_label: z.string().max(256).optional(),
  synesis_knowledge_cutoff: z.string().max(128).optional(),
  synesis_acp_client_name: z.string().max(128).optional(),
  synesis_acp_client_version: z.string().max(64).optional(),
  synesis_acp_session: SynesisAcpSessionMetadataSchema.optional(),
  synesis_acp_initialize_meta_json: z.string().max(4096).optional(),
  synesis_acp_new_session_meta_json: z.string().max(4096).optional(),
  synesis_clarification_round: z.union([SynesisClarificationRoundSchema, z.string().max(4096)]).optional(),
}).strict();

const OpenAIExtraBodySchema = z.object({
  top_k: z.number().int().min(0).optional(),
  min_p: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().min(0).optional(),
  enable_thinking: z.boolean().optional(),
  enable_prefix_caching: z.boolean().optional(),
  synesis: SynesisExtraBodySchema.optional(),
  synesis_planning_override: PlanningBooleanControlSchema.optional(),
  planning_override: PlanningBooleanControlSchema.optional(),
  synesis_plan_mode: PlanningBooleanControlSchema.optional(),
  plan_mode: PlanningBooleanControlSchema.optional(),
  synesis_custom_style: z.string().max(2000).optional(),
  custom_style: z.string().max(2000).optional(),
  synesis_context_mediation: ContextMediationControlSchema.optional(),
  synesis_memory: ContextMediationControlSchema.optional(),
  synesis_work_packet: ContextMediationControlSchema.optional(),
  synesis_memory_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_mediation: ContextMediationControlSchema.optional(),
  architecture_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_profile: ArchitectureProfileSourceSchema.optional(),
}).strict();

const FunctionCallSchema = z.object({
  name: z.string().max(256),
  arguments: z.string().optional().default("{}"),
}).strict();

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional().default("function"),
  function: FunctionCallSchema,
}).strict();

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: OpenAIMessageContentSchema.optional(),
  name: z.string().max(256).optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
}).strict().transform((message) => ({
  ...message,
  role: message.role === "developer" ? "system" as const : message.role,
}));

export const OpenAIResponseFormatSchema = z.union([
  z.object({
    type: z.literal("text"),
  }).strict(),
  z.object({
    type: z.literal("json_object"),
  }).strict(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      schema: JsonSchemaContractSchema.optional(),
      strict: z.boolean().optional(),
    }).strict(),
  }).strict(),
]);

const ToolFunctionSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  parameters: JsonSchemaContractSchema.optional(),
  strict: z.boolean().optional(),
}).strict();

const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: ToolFunctionSchema,
}).strict();

const OpenAIToolChoiceObjectSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().max(256),
  }).strict(),
}).strict();

const ToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  OpenAIToolChoiceObjectSchema,
]);

const OpenAIPredictionSchema = z.object({
  type: z.literal("content"),
  content: z.union([
    z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    z.array(z.object({
      type: z.literal("text"),
      text: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    }).strict()).max(MAX_CONTENT_PARTS),
  ]),
}).strict();

const OpenAIAudioSchema = z.object({
  voice: z.string().trim().min(1).max(64),
  format: z.string().trim().min(1).max(32),
}).strict();

const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;
const MAX_STOP_SEQUENCES = 16;
const MAX_STOP_SEQUENCE_CHARS = 4096;
const MAX_MODEL_CHARS = 256;
const MAX_OUTPUT_TOKENS = 2_000_000;
const MAX_LOGIT_BIAS_KEYS = 2048;
const ProviderIdentifierSchema = z.string().max(256);
const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
const ServiceTierSchema = z.enum(["auto", "flex", "priority", "default"]);
const PromptCacheRetentionSchema = z.enum(["in_memory", "24h"]);
const TextVerbositySchema = z.enum(["low", "medium", "high"]);
const TemperatureSchema = z.number().min(0).max(2);
const ProbabilitySchema = z.number().min(0).max(1);
const PenaltySchema = z.number().min(-2).max(2);
const RepetitionPenaltySchema = z.number().min(0).max(10);
const TopKSchema = z.number().min(0).max(1_000_000);
const OutputTokenLimitSchema = z.number().int().min(1).max(MAX_OUTPUT_TOKENS);
const StopSchema = z.union([
  z.string().max(MAX_STOP_SEQUENCE_CHARS),
  z.array(z.string().max(MAX_STOP_SEQUENCE_CHARS)).max(MAX_STOP_SEQUENCES),
]);
const LogitBiasSchema = z.record(z.string().min(1).max(128), z.number().min(-100).max(100))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > MAX_LOGIT_BIAS_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `logit_bias exceeds ${MAX_LOGIT_BIAS_KEYS} entries`,
      });
    }
  });
const ModalitiesSchema = z.array(z.enum(["text", "audio"])).max(2);

export const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string().max(MAX_MODEL_CHARS).default("auto"),
  messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional().default(false),
  temperature: TemperatureSchema.optional(),
  top_p: ProbabilitySchema.optional(),
  top_k: TopKSchema.optional(),
  min_p: ProbabilitySchema.optional(),
  presence_penalty: PenaltySchema.optional(),
  frequency_penalty: PenaltySchema.optional(),
  repetition_penalty: RepetitionPenaltySchema.optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  max_tokens: OutputTokenLimitSchema.optional(),
  max_completion_tokens: OutputTokenLimitSchema.optional(),
  stop: StopSchema.optional(),
  seed: z.number().int().optional(),
  logit_bias: LogitBiasSchema.optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  n: z.number().int().min(1).max(128).optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).strict().optional(),
  tools: z.array(ToolDefinitionSchema).max(MAX_TOOLS).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  extra_body: OpenAIExtraBodySchema.optional(),
  user: ProviderIdentifierSchema.optional().nullable(),
  conversation_id: ProviderIdentifierSchema.optional().nullable(),
  metadata: RequestMetadataSchema.optional(),
  store: z.boolean().optional(),
  modalities: ModalitiesSchema.optional(),
  prediction: OpenAIPredictionSchema.optional(),
  audio: OpenAIAudioSchema.optional(),
  service_tier: ServiceTierSchema.optional(),
  prompt_cache_key: ProviderIdentifierSchema.optional(),
  prompt_cache_retention: PromptCacheRetentionSchema.optional(),
  safety_identifier: ProviderIdentifierSchema.optional(),
  verbosity: TextVerbositySchema.optional(),
}).strict();

const ClaudeImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.string().max(128),
      data: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    }).strict(),
    z.object({
      type: z.literal("url"),
      url: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    }).strict(),
  ]),
  cache_control: CacheControlSchema.optional(),
}).strict();

const ClaudeToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().max(256).optional(),
  name: z.string().max(256),
  input: z.record(z.string().min(1).max(128), BoundedJsonValueSchema).optional().default({}),
  cache_control: CacheControlSchema.optional(),
}).strict();

const ClaudeToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().max(256).optional(),
  content: z.union([
    z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    BoundedJsonValueSchema,
    z.array(BoundedJsonValueSchema).max(MAX_JSON_ARRAY_ITEMS),
  ]).optional(),
  is_error: z.boolean().optional(),
  cache_control: CacheControlSchema.optional(),
}).strict();

const ClaudeContentBlockSchema = z.union([
  TextContentPartSchema,
  ClaudeImageBlockSchema,
  ClaudeToolUseBlockSchema,
  ClaudeToolResultBlockSchema,
]);

const ClaudeMessageContentSchema = z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.array(ClaudeContentBlockSchema).max(MAX_CONTENT_PARTS),
]);

export const ClaudeMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: ClaudeMessageContentSchema,
}).strict();

const ClaudeToolSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  input_schema: JsonSchemaContractSchema.optional(),
}).strict();

const ClaudeToolChoiceSchema = z.union([
  z.object({ type: z.literal("auto") }).strict(),
  z.object({ type: z.literal("any") }).strict(),
  z.object({ type: z.literal("tool"), name: z.string() }).strict(),
]);

const ClaudeThinkingSchema = z.union([
  z.object({
    type: z.literal("enabled"),
    budget_tokens: z.number().int().min(1).max(2_000_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("disabled"),
  }).strict(),
]);

export const ClaudeMessagesRequestSchema = z.object({
  model: z.string().max(MAX_MODEL_CHARS),
  max_tokens: OutputTokenLimitSchema,
  messages: z.array(ClaudeMessageSchema).min(1).max(MAX_MESSAGES),
  system: z.union([
    z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    z.array(TextContentPartSchema).max(MAX_CONTENT_PARTS),
  ]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ClaudeToolSchema).max(MAX_TOOLS).optional(),
  tool_choice: ClaudeToolChoiceSchema.optional(),
  thinking: ClaudeThinkingSchema.optional(),
  temperature: TemperatureSchema.optional(),
  top_p: ProbabilitySchema.optional(),
  top_k: TopKSchema.optional(),
  min_p: ProbabilitySchema.optional(),
  presence_penalty: PenaltySchema.optional(),
  repetition_penalty: RepetitionPenaltySchema.optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  stop_sequences: z.array(z.string().max(MAX_STOP_SEQUENCE_CHARS)).max(MAX_STOP_SEQUENCES).optional(),
  metadata: RequestMetadataSchema.optional()
}).strict();

export const ClaudeBootstrapPresetSchema = z.enum([
  "default",
  "go-strict",
  "ts-strict",
  "python-strict",
]);

export const ClaudeBootstrapQuerySchema = z.object({
  preset: ClaudeBootstrapPresetSchema.optional().default("default"),
});

export const ClaudeModelResolutionQuerySchema = z.object({
  model: z.string().trim().min(1),
});

const ClaudeCommandArgsSchema = z.object({
  reason: z.string().trim().max(512).optional(),
}).strict();

export const ClaudeCommandExecuteRequestSchema = z.object({
  command: z.string().trim().min(1),
  args: ClaudeCommandArgsSchema.optional(),
  session_id: z.string().trim().optional(),
  conversation_id: z.string().trim().optional(),
  model: z.string().trim().optional(),
}).strict();

export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;
export type ClaudeMessagesRequest = z.infer<typeof ClaudeMessagesRequestSchema>;
export type ClaudeBootstrapPreset = z.infer<typeof ClaudeBootstrapPresetSchema>;
export type ClaudeBootstrapQuery = z.infer<typeof ClaudeBootstrapQuerySchema>;
export type ClaudeModelResolutionQuery = z.infer<typeof ClaudeModelResolutionQuerySchema>;
export type ClaudeCommandExecuteRequest = z.infer<typeof ClaudeCommandExecuteRequestSchema>;
