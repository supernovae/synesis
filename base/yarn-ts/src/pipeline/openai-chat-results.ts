export type OpenAIChatPipelineResult =
  | {
      kind: "json";
      statusCode?: number;
      headers?: Record<string, string>;
      body: unknown;
    }
  | {
      kind: "error";
      statusCode: number;
      headers?: Record<string, string>;
      body: unknown;
    }
  | {
      kind: "workspaceHandshake";
      statusCode?: number;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | {
      kind: "streamStarted";
    };

export interface OpenAIChatReplyAdapter {
  header(name: string, value: string): unknown;
  code(statusCode: number): { send(body: unknown): unknown };
  send(body: unknown): unknown;
}

function applyResultHeaders(reply: OpenAIChatReplyAdapter, headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}

export function sendOpenAIChatPipelineResult(
  reply: OpenAIChatReplyAdapter,
  result: OpenAIChatPipelineResult,
): unknown {
  if (result.kind === "streamStarted") {
    return reply;
  }

  applyResultHeaders(reply, result.headers);
  const statusCode = result.statusCode ?? 200;
  if (result.kind === "workspaceHandshake" && result.body === undefined) {
    return reply;
  }
  return reply.code(statusCode).send(result.body);
}
