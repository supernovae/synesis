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
});

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

const ToolDefinitionSchema = z.object({
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

const SynesisPlannerMetadataSchema = z.object({
  contextMediation: z.string().max(64).optional(),
  architectureProfile: z.string().max(64).optional(),
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
  synesis_context_mediation: z.string().max(64).optional(),
  synesis_architecture_mediation: z.string().max(64).optional(),
  architecture_mediation: z.string().max(64).optional(),
  synesis_architecture_profile: z.string().max(64).optional(),
}).strict();

const ToolChoiceObjectSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().max(256),
  }).strict(),
}).strict();

const ToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  ToolChoiceObjectSchema,
]);

const StringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;

export const ChatCompletionRequestSchema = z.object({
  model: z.string().default("Synesis"),
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().optional().default(false),
  stream_options: StreamOptionsSchema.optional(),
  max_tokens: z.number().int().optional(),
  max_completion_tokens: z.number().int().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  min_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  reasoning_effort: z.string().optional(),
  enable_thinking: z.boolean().optional(),
  stop: StringOrStringArraySchema.optional(),
  seed: z.number().int().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  n: z.number().int().optional(),
  tools: z.array(ToolDefinitionSchema).max(MAX_TOOLS).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
  extra_body: ProviderExtraBodySchema.optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  metadata: RequestMetadataSchema.optional(),
  store: z.boolean().optional(),
  modalities: z.array(z.string()).optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  service_tier: z.string().optional(),
}).strict();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
