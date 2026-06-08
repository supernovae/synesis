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

const SynesisExtraBodySchema = z.object({
  contextMediation: z.string().max(64).optional(),
  architectureProfile: z.string().max(64).optional(),
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
  synesis_mode: z.string().max(32).optional(),
  synesis: SynesisExtraBodySchema.optional(),
  synesis_planning_override: z.union([z.boolean(), z.string().max(32)]).optional(),
  synesis_plan_mode: z.union([z.boolean(), z.string().max(32)]).optional(),
  synesis_custom_style: z.string().max(2000).optional(),
  custom_style: z.string().max(2000).optional(),
  synesis_context_mediation: z.string().max(64).optional(),
  synesis_memory: z.string().max(64).optional(),
  synesis_work_packet: z.string().max(64).optional(),
  synesis_memory_mediation: z.string().max(64).optional(),
  synesis_architecture_mediation: z.string().max(64).optional(),
  architecture_mediation: z.string().max(64).optional(),
  synesis_architecture_profile: z.string().max(64).optional(),
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
  }).strict().optional(),
  tools: z.array(ToolDefinitionSchema).max(MAX_TOOLS).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  extra_body: OpenAIExtraBodySchema.optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  metadata: RequestMetadataSchema.optional(),
  store: z.boolean().optional(),
  modalities: z.array(z.string()).optional(),
  prediction: OpenAIPredictionSchema.optional(),
  audio: OpenAIAudioSchema.optional(),
  service_tier: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  safety_identifier: z.string().optional(),
  verbosity: z.string().optional(),
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
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(ClaudeMessageSchema).min(1).max(MAX_MESSAGES),
  system: z.union([
    z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    z.array(TextContentPartSchema).max(MAX_CONTENT_PARTS),
  ]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ClaudeToolSchema).max(MAX_TOOLS).optional(),
  tool_choice: ClaudeToolChoiceSchema.optional(),
  thinking: ClaudeThinkingSchema.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  min_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
  stop_sequences: z.array(z.string()).optional(),
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
export type ClaudeMessagesRequest = z.infer<typeof ClaudeMessagesRequestSchema>;
export type ClaudeBootstrapPreset = z.infer<typeof ClaudeBootstrapPresetSchema>;
export type ClaudeBootstrapQuery = z.infer<typeof ClaudeBootstrapQuerySchema>;
export type ClaudeModelResolutionQuery = z.infer<typeof ClaudeModelResolutionQuerySchema>;
export type ClaudeCommandExecuteRequest = z.infer<typeof ClaudeCommandExecuteRequestSchema>;
