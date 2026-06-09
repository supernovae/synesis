import { z } from "zod";
import { JsonSchemaContractSchema } from "./json-schema-contract.js";
import { ProviderExtraBodySchema } from "./llm/extra-body.js";

const MAX_MESSAGE_CONTENT_CHARS = 2_000_000;
const MAX_CONTENT_PARTS = 512;

function messageContentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.input_text === "string") return record.input_text;
        if (typeof record.output_text === "string") return record.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const TextContentPartSchema = z.object({
  type: z.enum(["text", "input_text", "output_text"]).optional(),
  text: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
}).strict();

const ImageUrlSchema = z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.object({
    url: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    detail: z.string().max(64).optional(),
  }).strict(),
]);

const ImageContentPartSchema = z.object({
  type: z.enum(["image_url", "input_image"]),
  image_url: ImageUrlSchema.optional(),
  detail: z.string().max(64).optional(),
}).strict();

const InputAudioContentPartSchema = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    format: z.string().max(32),
  }).strict(),
}).strict();

const FileContentPartSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    file_data: z.string().max(MAX_MESSAGE_CONTENT_CHARS).optional(),
    file_id: z.string().max(256).optional(),
    filename: z.string().max(1024).optional(),
  }).strict(),
}).strict();

const RefusalContentPartSchema = z.object({
  type: z.literal("refusal"),
  refusal: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
}).strict();

const MessageContentPartSchema = z.union([
  TextContentPartSchema,
  ImageContentPartSchema,
  InputAudioContentPartSchema,
  FileContentPartSchema,
  RefusalContentPartSchema,
]);

const MessageContentSchema = z.union([
  z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  z.array(z.union([z.string().max(MAX_MESSAGE_CONTENT_CHARS), MessageContentPartSchema])).max(MAX_CONTENT_PARTS),
  z.null(),
]);

const FunctionCallSchema = z.object({
  name: z.string().max(256),
  arguments: z.string().optional().default("{}"),
}).strict();

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional().default("function"),
  function: FunctionCallSchema,
}).strict();

const MessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: MessageContentSchema.optional().transform(messageContentToText),
  name: z.string().max(256).optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
}).strict().transform((message) => ({
  ...message,
  role: message.role === "developer" ? "system" as const : message.role,
}));

const ToolFunctionSchema = z.object({
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  parameters: JsonSchemaContractSchema.optional(),
  strict: z.boolean().optional(),
}).strict();

export const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: ToolFunctionSchema,
}).strict();

const ResponseFormatSchema = z.object({
  type: z.string(),
  json_schema: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    schema: JsonSchemaContractSchema.optional(),
    strict: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
}).strict();

function normalizeControlValue(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

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

const SynesisPlannerMetadataSchema = z.object({
  contextMediation: ContextMediationControlSchema.optional(),
  architectureProfile: ArchitectureProfileSourceSchema.optional(),
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
  synesis: SynesisPlannerMetadataSchema.optional(),
  synesis_context_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_mediation: ContextMediationControlSchema.optional(),
  architecture_mediation: ContextMediationControlSchema.optional(),
  synesis_architecture_profile: ArchitectureProfileSourceSchema.optional(),
}).strict();

const ToolChoiceObjectSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().max(256),
  }).strict(),
}).strict();

export const ToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  ToolChoiceObjectSchema,
]);

const PredictionSchema = z.object({
  type: z.literal("content"),
  content: z.union([
    z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    z.array(z.object({
      type: z.literal("text"),
      text: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
    }).strict()).max(MAX_CONTENT_PARTS),
  ]),
}).strict();

const AudioSchema = z.object({
  voice: z.string().trim().min(1).max(64),
  format: z.string().trim().min(1).max(32),
}).strict();

const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;
const MAX_MODEL_CHARS = 256;
const MAX_STOP_SEQUENCES = 16;
const MAX_STOP_SEQUENCE_CHARS = 4096;
const MAX_OUTPUT_TOKENS = 2_000_000;
const MAX_LOGIT_BIAS_KEYS = 2048;
const ProviderIdentifierSchema = z.string().max(256);
const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
const ServiceTierSchema = z.enum(["auto", "flex", "priority", "default"]);
const TemperatureSchema = z.number().min(0).max(2);
const ProbabilitySchema = z.number().min(0).max(1);
const PenaltySchema = z.number().min(-2).max(2);
const RepetitionPenaltySchema = z.number().min(0).max(10);
const TopKSchema = z.number().int().min(0).max(1_000_000);
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

export const ChatCompletionRequestSchema = z.object({
  model: z.string().max(MAX_MODEL_CHARS).default("Synesis"),
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional().default(false),
  stream_options: StreamOptionsSchema.optional(),
  max_tokens: OutputTokenLimitSchema.optional(),
  max_completion_tokens: OutputTokenLimitSchema.optional(),
  temperature: TemperatureSchema.optional(),
  top_p: ProbabilitySchema.optional(),
  top_k: TopKSchema.optional(),
  min_p: ProbabilitySchema.optional(),
  presence_penalty: PenaltySchema.optional(),
  frequency_penalty: PenaltySchema.optional(),
  repetition_penalty: RepetitionPenaltySchema.optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  enable_thinking: z.boolean().optional(),
  stop: StopSchema.optional(),
  seed: z.number().int().optional(),
  logit_bias: LogitBiasSchema.optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  n: z.number().int().min(1).max(128).optional(),
  tools: z.array(ToolDefinitionSchema).max(MAX_TOOLS).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
  extra_body: ProviderExtraBodySchema.optional(),
  user: ProviderIdentifierSchema.optional().nullable(),
  conversation_id: ProviderIdentifierSchema.optional().nullable(),
  metadata: RequestMetadataSchema.optional(),
  store: z.boolean().optional(),
  modalities: ModalitiesSchema.optional(),
  prediction: PredictionSchema.optional(),
  audio: AudioSchema.optional(),
  service_tier: ServiceTierSchema.optional(),
}).strict();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
