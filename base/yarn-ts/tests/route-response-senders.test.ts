import { describe, expect, it, vi } from "vitest";
import {
  policyRejectClaudeBody,
  policyRejectOpenAIBody,
  sendClaudeSoftFail,
  sendClaudeWorkspaceHandshake,
  sendOpenAISoftFail,
  sendOpenAIWorkspaceHandshake,
} from "../src/protocol/route-response-senders.js";
import type { PolicyDecision } from "../src/policy/deterministic-policy-engine.js";

function fakeReply() {
  const chunks: string[] = [];
  const headers: Array<{ statusCode: number; headers?: Record<string, string> }> = [];
  const reply = {
    sent: undefined as unknown,
    raw: {
      destroyed: false,
      write: vi.fn((data: string) => {
        chunks.push(data);
        return true;
      }),
      end: vi.fn(),
      writeHead: vi.fn((statusCode: number, h?: Record<string, string>) => {
        headers.push({ statusCode, headers: h });
      }),
    },
    send: vi.fn((body: unknown) => {
      reply.sent = body;
      return reply;
    }),
  };
  return { reply, chunks, headers };
}

function policyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    allow: false,
    rejectReason: "blocked",
    matchedRules: [],
    ...overrides,
  };
}

describe("route response senders", () => {
  it("builds OpenAI and Claude policy rejection bodies", () => {
    const openai = policyRejectOpenAIBody(policyDecision({ matchedRules: ["repeat_loop_hard_reject"] }));
    const claude = policyRejectClaudeBody(policyDecision({ matchedRules: ["session_budget_exceeded"] }));

    expect(openai.error.type).toBe("invalid_request_error");
    expect(openai.error.message).toBe("blocked");
    expect(openai.error.synesis?.code).toBe("repeat_loop_hard_reject");
    expect(claude.type).toBe("error");
    expect(claude.error.synesis?.code).toBe("session_token_budget");
  });

  it("sends OpenAI non-stream soft-fail body with optional pause envelope", () => {
    const { reply } = fakeReply();

    sendOpenAISoftFail(reply as never, "req-1", "model-a", "pause", false, { reason: "x" } as never);

    expect(reply.send).toHaveBeenCalledOnce();
    expect(reply.sent).toMatchObject({
      id: "req-1",
      object: "chat.completion",
      model: "model-a",
      choices: [{ message: { role: "assistant", content: "pause" }, finish_reason: "stop" }],
      synesis_governor_pause: { reason: "x" },
    });
  });

  it("sends OpenAI stream soft-fail chunks preserving SSE completion shape", () => {
    const { reply, chunks, headers } = fakeReply();

    sendOpenAISoftFail(reply as never, "req-1", "model-a", "pause", true);

    expect(headers[0]).toMatchObject({
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    expect(chunks.join("")).toContain('"delta":{"role":"assistant"}');
    expect(chunks.join("")).toContain('"delta":{"content":"pause"}');
    expect(chunks.join("")).toContain('"finish_reason":"stop"');
    expect(chunks[chunks.length - 1]).toBe("data: [DONE]\n\n");
    expect(reply.raw.end).toHaveBeenCalledOnce();
  });

  it("sends Claude non-stream soft-fail body", () => {
    const { reply } = fakeReply();

    sendClaudeSoftFail(reply as never, "claude-model", "pause", false);

    expect(reply.sent).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-model",
      content: [{ type: "text", text: "pause" }],
      stop_reason: "end_turn",
    });
  });

  it("sends workspace handshake responses for both protocols", () => {
    const openai = fakeReply();
    const claude = fakeReply();

    sendOpenAIWorkspaceHandshake(openai.reply as never, "req-1", "model-a", false, "tool-1", "bash");
    sendClaudeWorkspaceHandshake(claude.reply as never, "claude-model", true, "tool-2", "bash");

    expect(openai.reply.sent).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { tool_calls: [{ id: "tool-1", function: { name: "bash" } }] }, finish_reason: "tool_calls" }],
    });
    expect(claude.chunks.join("")).toContain("content_block_start");
    expect(claude.chunks.join("")).toContain('"name":"bash"');
    expect(claude.chunks.join("")).toContain("message_stop");
  });
});
