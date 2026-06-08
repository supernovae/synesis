import { z } from "zod";
import { ProviderExtraBodySchema } from "./llm/extra-body.js";

function messageContentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.input_text === "string") return record.input_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

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
  content: z.unknown().optional().transform(messageContentToText),
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
  parameters: z.record(z.string(), z.unknown()).optional(),
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
    schema: z.record(z.string(), z.unknown()).optional(),
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
