import { z } from "zod";

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

const MessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.unknown().optional().transform(messageContentToText),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough().transform((message) => ({
  ...message,
  role: message.role === "developer" ? "system" as const : message.role,
}));

const ResponseFormatSchema = z.object({
  type: z.string(),
}).passthrough();

const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
}).passthrough();

const ToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  z.object({ type: z.string() }).passthrough(),
]);

const StringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

export const ChatCompletionRequestSchema = z.object({
  model: z.string().default("Synesis"),
  messages: z.array(MessageSchema).min(1),
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
  tools: z.array(z.unknown()).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  store: z.boolean().optional(),
  modalities: z.array(z.string()).optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  service_tier: z.string().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
