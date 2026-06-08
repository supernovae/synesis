import { z } from "zod";
import { normalizeToolDescriptions } from "./compat/tool-description-normalizer.js";
import { JsonSchemaContractSchema } from "./json-schema-contract.js";
import { OpenAIResponseFormatSchema, RequestMetadataSchema, type OpenAIChatCompletionRequest } from "./schemas.js";

const MAX_RESPONSES_INPUT_ITEMS = 512;
const MAX_RESPONSES_TOOLS = 128;

const ResponsesTextContentPartSchema = z.object({
  type: z.enum(["input_text", "output_text", "text"]).optional(),
  text: z.string().optional(),
}).strict();

const ResponsesImageContentPartSchema = z.object({
  type: z.enum(["input_image", "image_url"]),
  image_url: z.union([
    z.string(),
    z.object({
      url: z.string(),
      detail: z.string().optional(),
    }).strict(),
  ]).optional(),
  detail: z.string().optional(),
}).strict();

const ResponsesContentPartSchema = z.union([
  ResponsesTextContentPartSchema,
  ResponsesImageContentPartSchema,
]);

const ResponsesFunctionCallSchema = z.object({
  name: z.string().max(256),
  arguments: z.string().optional().default("{}"),
}).strict();

const ResponsesToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional().default("function"),
  function: ResponsesFunctionCallSchema,
}).strict();

const ResponsesInputMessageSchema = z.object({
  type: z.enum(["message", "input_message"]).optional(),
  role: z.enum(["system", "developer", "user", "assistant", "tool"]).optional(),
  content: z.union([
    z.string(),
    z.array(z.union([z.string(), ResponsesContentPartSchema])),
    ResponsesContentPartSchema,
    z.null(),
  ]).optional(),
  name: z.string().max(256).optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ResponsesToolCallSchema).optional(),
}).strict();

const ResponsesFunctionCallOutputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  output: z.unknown().optional(),
}).strict();

const ResponsesFunctionToolSchema = z.object({
  type: z.literal("function"),
  name: z.string().max(256),
  description: z.string().optional(),
  parameters: JsonSchemaContractSchema.optional(),
  strict: z.boolean().optional(),
}).strict();

const ResponsesOpenAIShapeFunctionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().max(256),
    description: z.string().optional(),
    parameters: JsonSchemaContractSchema.optional(),
    strict: z.boolean().optional(),
  }).strict(),
}).strict();

const ResponsesToolSchema = z.union([
  ResponsesFunctionToolSchema,
  ResponsesOpenAIShapeFunctionToolSchema,
]);

const ResponsesToolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  z.object({
    type: z.literal("function"),
    name: z.string().max(256),
  }).strict(),
  z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().max(256),
    }).strict(),
  }).strict(),
]);

const ResponsesTextFormatSchema = z.union([
  z.object({
    type: z.literal("text"),
  }).strict(),
  z.object({
    type: z.literal("json_object"),
  }).strict(),
  z.object({
    type: z.literal("json_schema"),
    name: z.string().optional(),
    description: z.string().optional(),
    schema: JsonSchemaContractSchema.optional(),
    strict: z.boolean().optional(),
  }).strict(),
]);

export const OpenAIResponsesRequestSchema = z.object({
  model: z.string().default("auto"),
  input: z.union([
    z.string(),
    z.array(z.union([ResponsesInputMessageSchema, ResponsesFunctionCallOutputSchema])).max(MAX_RESPONSES_INPUT_ITEMS),
  ]),
  instructions: z.string().optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().optional(),
  max_tokens: z.number().int().optional(),
  max_completion_tokens: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  seed: z.number().int().optional(),
  tools: z.array(ResponsesToolSchema).max(MAX_RESPONSES_TOOLS).optional(),
  tool_choice: ResponsesToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  text: z.object({
    format: ResponsesTextFormatSchema.optional(),
  }).strict().optional(),
  response_format: OpenAIResponseFormatSchema.optional(),
  reasoning: z.object({
    effort: z.string().optional(),
  }).strict().optional(),
  reasoning_effort: z.string().optional(),
  metadata: RequestMetadataSchema.optional(),
  store: z.boolean().optional(),
  user: z.string().optional().nullable(),
  conversation_id: z.string().optional().nullable(),
  service_tier: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  safety_identifier: z.string().optional(),
  verbosity: z.string().optional(),
}).strict();

export type OpenAIResponsesRequest = z.infer<typeof OpenAIResponsesRequestSchema>;

type ChatMessage = OpenAIChatCompletionRequest["messages"][number];

export type OpenAIResponseObject = {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "in_progress" | "failed";
  model: string;
  output: Array<Record<string, unknown>>;
  output_text: string;
  usage?: Record<string, unknown>;
  error: null | Record<string, unknown>;
  incomplete_details: null | Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
};

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentToChatContent(content: unknown): string | Array<unknown> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stableStringify(content);
  const parts: unknown[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const row = part as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type : "";
    if (type === "input_text" || type === "output_text") {
      parts.push({ type: "text", text: stableStringify(row.text ?? "") });
      continue;
    }
    if (type === "input_image" || type === "image_url") {
      parts.push({
        type: "image_url",
        image_url: row.image_url ?? (typeof row.image_url === "string" ? { url: row.image_url } : undefined),
      });
      continue;
    }
    parts.push(row);
  }
  return parts;
}

function responseInputToMessages(input: OpenAIResponsesRequest["input"]): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input } as ChatMessage];
  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: typeof row.call_id === "string" ? row.call_id : undefined,
        content: stableStringify(row.output ?? ""),
      } as ChatMessage);
      continue;
    }
    const rawRole = typeof row.role === "string" ? row.role : "user";
    const role = rawRole === "developer" ? "system" : rawRole;
    if (!["system", "user", "assistant", "tool"].includes(role)) continue;
    messages.push({
      role,
      content: contentToChatContent(row.content ?? ""),
      name: typeof row.name === "string" ? row.name : undefined,
      tool_call_id: typeof row.tool_call_id === "string" ? row.tool_call_id : undefined,
      tool_calls: Array.isArray(row.tool_calls) ? row.tool_calls : undefined,
    } as ChatMessage);
  }
  return messages.length > 0 ? messages : [{ role: "user", content: "" } as ChatMessage];
}

function responsesToolsToChatTools(tools: OpenAIResponsesRequest["tools"]): OpenAIChatCompletionRequest["tools"] {
  if (!tools) return undefined;
  const normalized = normalizeToolDescriptions({ tools }, "responses", "responsesRequestToChatCompletion").body.tools;
  return normalized.map((tool) => {
    if (!tool || typeof tool !== "object") {
      return { type: "function" as const, function: { name: "unknown" } };
    }
    const row = tool as Record<string, unknown>;
    if (row.type === "function" && row.function && typeof row.function === "object") {
      const fn = row.function as Record<string, unknown>;
      return {
        type: "function" as const,
        function: {
          name: typeof fn.name === "string" ? fn.name : "unknown",
          description: typeof fn.description === "string" ? fn.description : undefined,
          parameters: (fn.parameters ?? {}) as Record<string, unknown>,
          strict: typeof fn.strict === "boolean" ? fn.strict : undefined,
        },
      };
    }
    const name = typeof row.name === "string" ? row.name : "unknown";
    return {
      type: "function" as const,
      function: {
        name,
        description: typeof row.description === "string" ? row.description : undefined,
        parameters: (row.parameters ?? {}) as Record<string, unknown>,
        strict: typeof row.strict === "boolean" ? row.strict : undefined,
      },
    };
  });
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return choice;
  const row = choice as Record<string, unknown>;
  if (row.type === "function" && typeof row.name === "string") {
    return { type: "function", function: { name: row.name } };
  }
  return choice;
}

function responsesTextFormatToChat(format: unknown): unknown {
  if (!format || typeof format !== "object") return undefined;
  const row = format as Record<string, unknown>;
  if (row.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: row.name,
        description: row.description,
        schema: row.schema,
        strict: row.strict,
      },
    };
  }
  if (row.type === "json_object") return { type: "json_object" };
  if (row.type === "text") return { type: "text" };
  return undefined;
}

export function responsesRequestToChatCompletion(request: OpenAIResponsesRequest): OpenAIChatCompletionRequest {
  const messages = responseInputToMessages(request.input);
  if (request.instructions?.trim()) {
    messages.unshift({ role: "system", content: request.instructions } as ChatMessage);
  }
  const maxTokens = request.max_output_tokens ?? request.max_completion_tokens ?? request.max_tokens;
  const responseFormat = request.response_format ?? responsesTextFormatToChat(request.text?.format);
  return {
    model: request.model,
    messages,
    stream: false,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: maxTokens,
    max_completion_tokens: maxTokens,
    stop: request.stop,
    seed: request.seed,
    tools: responsesToolsToChatTools(request.tools),
    tool_choice: responsesToolChoiceToChat(request.tool_choice),
    parallel_tool_calls: request.parallel_tool_calls,
    response_format: responseFormat as OpenAIChatCompletionRequest["response_format"],
    reasoning_effort: request.reasoning_effort ?? request.reasoning?.effort,
    metadata: request.metadata,
    store: request.store,
    user: request.user,
    conversation_id: request.conversation_id,
    service_tier: request.service_tier,
    prompt_cache_key: request.prompt_cache_key,
    prompt_cache_retention: request.prompt_cache_retention,
    safety_identifier: request.safety_identifier,
    verbosity: request.verbosity,
  } as OpenAIChatCompletionRequest;
}

function chatUsageToResponsesUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const row = usage as Record<string, unknown>;
  const inputTokens = Number(row.prompt_tokens ?? row.input_tokens ?? 0);
  const outputTokens = Number(row.completion_tokens ?? row.output_tokens ?? 0);
  const totalTokens = Number(row.total_tokens ?? inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    input_tokens_details: row.prompt_tokens_details ?? row.input_tokens_details ?? {},
    output_tokens_details: row.completion_tokens_details ?? row.output_tokens_details ?? {},
  };
}

export function chatCompletionToResponseObject(
  chatCompletion: Record<string, unknown>,
  request: OpenAIResponsesRequest,
): OpenAIResponseObject {
  const id = typeof chatCompletion.id === "string" ? chatCompletion.id : `resp_${Date.now()}`;
  const created = Number(chatCompletion.created ?? Math.floor(Date.now() / 1000));
  const choices = Array.isArray(chatCompletion.choices) ? chatCompletion.choices : [];
  const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = ((firstChoice.message ?? {}) as Record<string, unknown>);
  const output: Array<Record<string, unknown>> = [];
  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    output.push({
      id: `msg_${id}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const row = toolCall as Record<string, unknown>;
    const fn = (row.function ?? {}) as Record<string, unknown>;
    output.push({
      id: typeof row.id === "string" ? row.id : `fc_${Date.now()}`,
      type: "function_call",
      status: "completed",
      call_id: typeof row.id === "string" ? row.id : undefined,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : stableStringify(fn.arguments ?? {}),
    });
  }
  return {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model: typeof chatCompletion.model === "string" ? chatCompletion.model : request.model,
    output,
    output_text: text,
    usage: chatUsageToResponsesUsage(chatCompletion.usage),
    error: null,
    incomplete_details: null,
    metadata: request.metadata,
    parallel_tool_calls: request.parallel_tool_calls,
  };
}

export function responseObjectToSseEvents(response: OpenAIResponseObject): Array<{ event: string; data: Record<string, unknown> }> {
  const inProgress: OpenAIResponseObject = { ...response, status: "in_progress", output: [], output_text: "" };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [
    { event: "response.created", data: { type: "response.created", response: inProgress } },
    { event: "response.in_progress", data: { type: "response.in_progress", response: inProgress } },
  ];
  for (let i = 0; i < response.output.length; i++) {
    const item = response.output[i]!;
    events.push({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: i, item } });
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const firstPart = (content[0] ?? {}) as Record<string, unknown>;
      const text = typeof firstPart.text === "string" ? firstPart.text : "";
      events.push({ event: "response.content_part.added", data: { type: "response.content_part.added", item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } } });
      if (text) {
        events.push({ event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: item.id, output_index: i, content_index: 0, delta: text } });
      }
      events.push({ event: "response.output_text.done", data: { type: "response.output_text.done", item_id: item.id, output_index: i, content_index: 0, text } });
      events.push({ event: "response.content_part.done", data: { type: "response.content_part.done", item_id: item.id, output_index: i, content_index: 0, part: firstPart } });
    }
    events.push({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: i, item } });
  }
  events.push({ event: "response.completed", data: { type: "response.completed", response } });
  return events;
}
