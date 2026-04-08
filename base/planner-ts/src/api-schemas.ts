import { z } from "zod";

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().default("")
});

const ResponseFormatSchema = z.object({
  type: z.string(),
}).passthrough();

const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
}).passthrough();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().default("Synesis"),
  messages: z.array(MessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  stream_options: StreamOptionsSchema.optional(),
  max_tokens: z.number().int().optional(),
  max_completion_tokens: z.number().int().optional(),
  response_format: ResponseFormatSchema.optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable()
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
