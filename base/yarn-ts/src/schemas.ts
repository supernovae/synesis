import { z } from "zod";

export const RoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
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

export const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(ChatMessageSchema),
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
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
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

export const ClaudeMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(ClaudeMessageSchema),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
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
