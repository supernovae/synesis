import { z } from "zod";
export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export const ChatMessageSchema = z.object({
    role: RoleSchema,
    content: z.union([z.string(), z.array(z.any())]),
    name: z.string().optional(),
    tool_call_id: z.string().optional()
});
export const OpenAIChatCompletionRequestSchema = z.object({
    model: z.string().default("synesis-core"),
    messages: z.array(ChatMessageSchema),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
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
    stream: z.boolean().optional().default(false),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    thinking: z.any().optional()
}).passthrough();
