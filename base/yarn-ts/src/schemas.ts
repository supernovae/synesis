import { z } from "zod";

export const RoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

const SynesisExtraBodySchema = z.object({
  contextMediation: z.string().max(64).optional(),
  architectureProfile: z.string().max(64).optional(),
}).strict();

const OpenAIExtraBodySchema = z.object({
  top_k: z.number().int().min(0).optional(),
  min_p: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().min(0).optional(),
  enable_thinking: z.boolean().optional(),
  enable_prefix_caching: z.boolean().optional(),
  synesis: SynesisExtraBodySchema.optional(),
  synesis_planning_override: z.union([z.boolean(), z.string().max(32)]).optional(),
  planning_override: z.union([z.boolean(), z.string().max(32)]).optional(),
  synesis_plan_mode: z.union([z.boolean(), z.string().max(32)]).optional(),
  plan_mode: z.union([z.boolean(), z.string().max(32)]).optional(),
  synesis_custom_style: z.string().max(2000).optional(),
  custom_style: z.string().max(2000).optional(),
  synesis_context_mediation: z.string().max(64).optional(),
  synesis_memory: z.string().max(64).optional(),
  synesis_work_packet: z.string().max(64).optional(),
  synesis_memory_mediation: z.string().max(64).optional(),
  synesis_architecture_mediation: z.string().max(64).optional(),
  architecture_mediation: z.string().max(64).optional(),
  synesis_architecture_profile: z.string().max(64).optional(),
}).strict();

const FunctionCallSchema = z.object({
  name: z.string().max(256),
  arguments: z.string().optional().default("{}"),
});

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional().default("function"),
  function: FunctionCallSchema,
}).passthrough();

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  name: z.string().max(256).optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
}).passthrough().transform((message) => ({
  ...message,
  role: message.role === "developer" ? "system" as const : message.role,
}));

export const OpenAIResponseFormatSchema = z.union([
  z.object({
    type: z.literal("text"),
  }).passthrough(),
  z.object({
    type: z.literal("json_object"),
  }).passthrough(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().optional(),
    }).passthrough(),
  }).passthrough(),
]);

const ToolFunctionSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
}).passthrough();

const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: ToolFunctionSchema,
}).passthrough();

const ToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  z.object({ type: z.string() }).passthrough(),
]);

const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;

export const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  min_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  seed: z.number().int().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  n: z.number().int().optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).passthrough().optional(),
  tools: z.array(ToolDefinitionSchema).max(MAX_TOOLS).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  extra_body: OpenAIExtraBodySchema.optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  store: z.boolean().optional(),
  modalities: z.array(z.string()).optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  service_tier: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  safety_identifier: z.string().optional(),
  verbosity: z.string().optional(),
}).passthrough();

export const ClaudeMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.unknown()
});

const ClaudeToolSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ClaudeToolChoiceSchema = z.union([
  z.object({ type: z.literal("auto") }),
  z.object({ type: z.literal("any") }),
  z.object({ type: z.literal("tool"), name: z.string() }),
]);

export const ClaudeMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(ClaudeMessageSchema).min(1).max(MAX_MESSAGES),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ClaudeToolSchema).max(MAX_TOOLS).optional(),
  tool_choice: ClaudeToolChoiceSchema.optional(),
  thinking: z.unknown().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  min_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).passthrough();

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

export const ClaudeCommandExecuteRequestSchema = z.object({
  command: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  session_id: z.string().trim().optional(),
  conversation_id: z.string().trim().optional(),
  model: z.string().trim().optional(),
}).passthrough();

export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;
export type ClaudeMessagesRequest = z.infer<typeof ClaudeMessagesRequestSchema>;
export type ClaudeBootstrapPreset = z.infer<typeof ClaudeBootstrapPresetSchema>;
export type ClaudeBootstrapQuery = z.infer<typeof ClaudeBootstrapQuerySchema>;
export type ClaudeModelResolutionQuery = z.infer<typeof ClaudeModelResolutionQuerySchema>;
export type ClaudeCommandExecuteRequest = z.infer<typeof ClaudeCommandExecuteRequestSchema>;
