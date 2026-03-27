import type { ServerResponse } from "node:http";

export interface StatusEventPayload {
  description: string;
  done: boolean;
  node?: string;
  authz_trace_id?: string;
}

export function initSse(response: ServerResponse): void {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

export function writeSseData(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeStatusEvent(response: ServerResponse, payload: StatusEventPayload): void {
  writeSseData(response, { event: payload });
}

export function writeCompletionChunk(
  response: ServerResponse,
  payload: {
    id: string;
    created: number;
    model: string;
    content: string;
  }
): void {
  writeSseData(response, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: { content: payload.content }, finish_reason: null }]
  });
}

export function writeFinalChunk(
  response: ServerResponse,
  payload: {
    id: string;
    created: number;
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cached_prompt_tokens: number;
      estimated_cost_usd?: number;
      actual_cost_usd?: number;
    };
  }
): void {
  writeSseData(response, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: payload.usage
  });
}

export function endSse(response: ServerResponse): void {
  response.write("data: [DONE]\n\n");
  response.end();
}
