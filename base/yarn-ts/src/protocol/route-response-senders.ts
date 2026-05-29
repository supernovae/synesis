import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import type { GovernorPauseEnvelope } from "../governance/execution-governor.js";
import type { PolicyDecision } from "../policy/deterministic-policy-engine.js";
import { synesisPolicyErrorExtension } from "../policy/policy-error-extension.js";
import { buildWorkspaceHandshakeBashCommand } from "../session/workspace-context-handshake.js";

type WritableRaw = NodeJS.WritableStream & {
  destroyed?: boolean;
  writeHead?: (statusCode: number, headers?: Record<string, string>) => unknown;
};

function safeWrite(raw: WritableRaw, data: string): boolean {
  if (raw.destroyed) return false;
  try {
    return raw.write(data);
  } catch {
    return false;
  }
}

function safeSse(reply: { raw: WritableRaw }, event: string, data: unknown): boolean {
  return safeWrite(reply.raw, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeEnd(raw: WritableRaw): void {
  if (raw.destroyed) return;
  try {
    raw.end();
  } catch {
    // ignore
  }
}

function writeEventStreamHead(raw: WritableRaw): void {
  raw.writeHead?.(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

export function policyRejectOpenAIBody(decision: PolicyDecision) {
  const message = decision.rejectReason ?? "Policy rejected request.";
  const synesis = synesisPolicyErrorExtension(decision.matchedRules);
  return {
    error: {
      type: "invalid_request_error" as const,
      message,
      ...(synesis ? { synesis } : {}),
    },
  };
}

export function policyRejectClaudeBody(decision: PolicyDecision) {
  const message = decision.rejectReason ?? "Policy rejected request.";
  const synesis = synesisPolicyErrorExtension(decision.matchedRules);
  return {
    type: "error" as const,
    error: {
      type: "invalid_request_error" as const,
      message,
      ...(synesis ? { synesis } : {}),
    },
  };
}

export function sendOpenAIWorkspaceHandshake(
  reply: FastifyReply,
  requestId: string,
  model: string,
  stream: boolean,
  toolCallId: string,
  toolName = "Bash",
): FastifyReply {
  const input = {
    command: buildWorkspaceHandshakeBashCommand(),
    description: "Initializing workspace context (read-only): cwd/project root/shell/os",
  };
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: toolCallId,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(input) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
  }

  const ts = Math.floor(Date.now() / 1000);
  writeEventStreamHead(reply.raw as WritableRaw);
  safeWrite(reply.raw as WritableRaw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: JSON.stringify(input) } }] }, finish_reason: null }],
  })}\n\n`);
  safeWrite(reply.raw as WritableRaw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`);
  safeWrite(reply.raw as WritableRaw, "data: [DONE]\n\n");
  safeEnd(reply.raw as WritableRaw);
  return reply;
}

export function sendClaudeWorkspaceHandshake(
  reply: FastifyReply,
  model: string,
  stream: boolean,
  toolCallId: string,
  toolName = "Bash",
): FastifyReply {
  const input = {
    command: buildWorkspaceHandshakeBashCommand(),
    description: "Initializing workspace context (read-only): cwd/project root/shell/os",
  };
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id: toolCallId, name: toolName, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  const msgId = `msg_${crypto.randomUUID()}`;
  writeEventStreamHead(reply.raw as WritableRaw);
  safeSse(reply as { raw: WritableRaw }, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: toolCallId, name: toolName },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_stop", { type: "content_block_stop", index: 0 });
  safeSse(reply as { raw: WritableRaw }, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  safeSse(reply as { raw: WritableRaw }, "message_stop", { type: "message_stop" });
  safeEnd(reply.raw as WritableRaw);
  return reply;
}

export function sendOpenAISoftFail(
  reply: FastifyReply,
  requestId: string,
  model: string,
  content: string,
  stream: boolean,
  pauseEnvelope?: GovernorPauseEnvelope,
): FastifyReply {
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
    });
  }

  const ts = Math.floor(Date.now() / 1000);
  writeEventStreamHead(reply.raw as WritableRaw);
  safeWrite(reply.raw as WritableRaw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
  })}\n\n`);
  safeWrite(reply.raw as WritableRaw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
  })}\n\n`);
  safeWrite(reply.raw as WritableRaw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
  })}\n\n`);
  safeWrite(reply.raw as WritableRaw, "data: [DONE]\n\n");
  safeEnd(reply.raw as WritableRaw);
  return reply;
}

export function sendClaudeSoftFail(
  reply: FastifyReply,
  model: string,
  content: string,
  stream: boolean,
  pauseEnvelope?: GovernorPauseEnvelope,
): FastifyReply {
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
    });
  }

  const msgId = `msg_${crypto.randomUUID()}`;
  writeEventStreamHead(reply.raw as WritableRaw);
  safeSse(reply as { raw: WritableRaw }, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: content },
  });
  safeSse(reply as { raw: WritableRaw }, "content_block_stop", { type: "content_block_stop", index: 0 });
  safeSse(reply as { raw: WritableRaw }, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  if (pauseEnvelope) {
    safeSse(reply as { raw: WritableRaw }, "synesis_governor_pause", {
      type: "synesis_governor_pause",
      pause: pauseEnvelope,
    });
  }
  safeSse(reply as { raw: WritableRaw }, "message_stop", { type: "message_stop" });
  safeEnd(reply.raw as WritableRaw);
  return reply;
}
