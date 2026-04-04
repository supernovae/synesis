import type { ServerResponse } from "node:http";

export interface StatusEventPayload {
  description: string;
  done: boolean;
  node?: string;
  authz_trace_id?: string;
}

export function isSseWritable(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed;
}

export function initSse(response: ServerResponse): void {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

export function writeSseData(response: ServerResponse, payload: unknown): boolean {
  try {
    if (!isSseWritable(response)) return false;
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch { return false; }
}

export function writeStatusEvent(response: ServerResponse, payload: StatusEventPayload): void {
  writeSseData(response, { event: payload });
}

export function writeContentDelta(
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
    choices: [{ index: 0, delta: { content: payload.content }, finish_reason: null }],
  });
}

export function writeReasoningDelta(
  response: ServerResponse,
  payload: {
    id: string;
    created: number;
    model: string;
    reasoning_content: string;
  }
): void {
  writeSseData(response, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: { reasoning_content: payload.reasoning_content }, finish_reason: null }],
  });
}

/** @deprecated Use writeContentDelta instead */
export function writeCompletionChunk(
  response: ServerResponse,
  payload: {
    id: string;
    created: number;
    model: string;
    content: string;
  }
): void {
  writeContentDelta(response, payload);
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
    run_id?: string;
    authz_trace_id?: string;
  }
): void {
  const body: Record<string, unknown> = {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: payload.usage
  };
  if (payload.run_id) body.run_id = payload.run_id;
  if (payload.authz_trace_id) body.authz_trace_id = payload.authz_trace_id;
  writeSseData(response, body);
}

export function endSse(response: ServerResponse): void {
  try {
    if (!isSseWritable(response)) return;
    response.write("data: [DONE]\n\n");
    response.end();
  } catch { /* client already gone */ }
}
