import { z } from "zod";

export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(z.any())]),
  name: z.string().optional(),
  tool_call_id: z.string().optional()
});

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
  repetition_penalty: z.number().optional(),
  enable_thinking: z.boolean().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).passthrough().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  user: z.string().optional(),
  conversation_id: z.string().optional()
}).passthrough();

export const ClaudeMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.any()
});

export const ClaudeMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(ClaudeMessageSchema),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  thinking: z.any().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  min_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  enable_thinking: z.boolean().optional(),
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
