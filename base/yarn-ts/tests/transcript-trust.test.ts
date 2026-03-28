import { describe, expect, it } from "vitest";
import { applyTrustPackets } from "../src/security/transcript-trust.js";
import type { AppConfig } from "../src/config.js";
import type { SecurityIngestConfig } from "@synesis/context-trust";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SYNESIS_YARN_TRUST_PACKET_ENABLED: true,
    SYNESIS_YARN_INJECTION_SCAN_ENABLED: false,
    SYNESIS_YARN_INJECTION_SCAN_ACTION: "log",
    SYNESIS_YARN_SECURITY_INGEST_ENABLED: false,
    ...overrides,
  } as AppConfig;
}

const CTX = { requestId: "req-1", sessionKey: "sess-1", userId: "u1", orgId: "o1" };
const INGEST: SecurityIngestConfig = { enabled: false, endpoint: "", authToken: "" };

describe("applyTrustPackets", () => {
  describe("assistant messages with tool_calls", () => {
    it("passes assistant messages through unchanged to avoid model mimicking JSON envelope", () => {
      const toolCalls = [
        { id: "call_1", type: "function" as const, function: { name: "bash", arguments: '{"cmd":"ls"}' } },
      ];
      const messages = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "List files" },
        { role: "assistant", content: "Let me check.", tool_calls: toolCalls },
        { role: "tool", content: "file1.txt\nfile2.txt", tool_call_id: "call_1", name: "bash" },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      expect(result.blocked).toBe(false);

      const assistantMsg = result.messages[2] as Record<string, unknown>;
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.tool_calls).toEqual(toolCalls);
      expect(assistantMsg.content).toBe("Let me check.");
    });

    it("preserves tool_calls when assistant text is only whitespace", () => {
      const toolCalls = [
        { id: "call_2", type: "function" as const, function: { name: "read_file", arguments: '{"path":"x"}' } },
      ];
      const messages = [
        { role: "assistant", content: "\n\n\n\n", tool_calls: toolCalls },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const assistantMsg = result.messages[0] as Record<string, unknown>;
      expect(assistantMsg.tool_calls).toEqual(toolCalls);
    });

    it("passes through assistant with only tool_calls and no text", () => {
      const toolCalls = [
        { id: "call_3", type: "function" as const, function: { name: "bash", arguments: "{}" } },
      ];
      const messages = [
        { role: "assistant", content: "", tool_calls: toolCalls },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const assistantMsg = result.messages[0] as Record<string, unknown>;
      expect(assistantMsg.tool_calls).toEqual(toolCalls);
      expect(assistantMsg.content).toBe("");
    });
  });

  describe("tool messages preserve structural fields", () => {
    it("preserves tool_call_id and name when trust wraps tool content", () => {
      const messages = [
        { role: "tool", content: "output from command", tool_call_id: "call_abc", name: "bash" },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const toolMsg = result.messages[0] as Record<string, unknown>;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.tool_call_id).toBe("call_abc");
      expect(toolMsg.name).toBe("bash");
      expect(typeof toolMsg.content).toBe("string");
      expect(String(toolMsg.content)).toContain('"source_type":"tool_result"');
    });

    it("passes through tool with empty content without wrapping", () => {
      const messages = [
        { role: "tool", content: "", tool_call_id: "call_xyz", name: "bash" },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const toolMsg = result.messages[0] as Record<string, unknown>;
      expect(toolMsg.tool_call_id).toBe("call_xyz");
      expect(toolMsg.name).toBe("bash");
      expect(toolMsg.content).toBe("");
    });
  });

  describe("full tool-call round-trip sequence", () => {
    it("maintains valid OpenAI tool sequence after wrapping", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Run ls and cat README" },
        {
          role: "assistant",
          content: "I'll run both commands.",
          tool_calls: [
            { id: "call_a", type: "function" as const, function: { name: "bash", arguments: '{"cmd":"ls"}' } },
            { id: "call_b", type: "function" as const, function: { name: "bash", arguments: '{"cmd":"cat README"}' } },
          ],
        },
        { role: "tool", content: "file1\nfile2", tool_call_id: "call_a", name: "bash" },
        { role: "tool", content: "# README\nHello", tool_call_id: "call_b", name: "bash" },
        { role: "assistant", content: "Here are the results..." },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      expect(result.blocked).toBe(false);
      expect(result.messages).toHaveLength(6);

      const assistantWithTools = result.messages[2] as Record<string, unknown>;
      expect(assistantWithTools.tool_calls).toHaveLength(2);
      expect((assistantWithTools.tool_calls as Array<{ id: string }>)[0].id).toBe("call_a");
      expect((assistantWithTools.tool_calls as Array<{ id: string }>)[1].id).toBe("call_b");

      const tool1 = result.messages[3] as Record<string, unknown>;
      expect(tool1.tool_call_id).toBe("call_a");
      expect(tool1.name).toBe("bash");

      const tool2 = result.messages[4] as Record<string, unknown>;
      expect(tool2.tool_call_id).toBe("call_b");
      expect(tool2.name).toBe("bash");

      const finalAssistant = result.messages[5] as Record<string, unknown>;
      expect(finalAssistant.tool_calls).toBeUndefined();
    });
  });

  describe("trust disabled passthrough", () => {
    it("passes all messages through unchanged when trust is disabled", () => {
      const toolCalls = [
        { id: "call_1", type: "function" as const, function: { name: "bash", arguments: "{}" } },
      ];
      const messages = [
        { role: "system", content: "System." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Running tool", tool_calls: toolCalls },
        { role: "tool", content: "done", tool_call_id: "call_1", name: "bash" },
      ];

      const config = makeConfig({ SYNESIS_YARN_TRUST_PACKET_ENABLED: false });
      const result = applyTrustPackets(messages as never, config, CTX, INGEST);

      expect(result.messages[2]).toBe(messages[2]);
      expect(result.messages[3]).toBe(messages[3]);
    });
  });

  describe("system message trust policy injection", () => {
    it("injects trust policy into first system message only", () => {
      const messages = [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "Additional context." },
      ];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      expect(result.messages[0].content).toContain("TRUST POLICY");
      expect(result.messages[0].content).toContain("You are helpful.");
      expect(result.messages[1].content).toBe("Additional context.");
    });
  });

  describe("user message wrapping", () => {
    it("wraps user content in untrusted envelope", () => {
      const messages = [{ role: "user", content: "Hello world" }];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const userMsg = result.messages[0] as Record<string, unknown>;
      expect(typeof userMsg.content).toBe("string");
      expect(String(userMsg.content)).toContain('"trust_level":"untrusted"');
      expect(String(userMsg.content)).toContain('"source_type":"user_message"');
      expect(String(userMsg.content)).toContain("Hello world");
    });

    it("preserves name field on user messages", () => {
      const messages = [{ role: "user", content: "Hello", name: "bymiller" }];

      const result = applyTrustPackets(messages as never, makeConfig(), CTX, INGEST);
      const userMsg = result.messages[0] as Record<string, unknown>;
      expect(userMsg.name).toBe("bymiller");
    });
  });
});
