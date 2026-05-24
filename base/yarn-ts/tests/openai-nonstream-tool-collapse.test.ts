import { describe, expect, it, vi } from "vitest";
import { maybeRewriteOpenAINonStreamCollapsedToolCalls } from "../src/pipeline/openai-nonstream-tool-collapse.js";
import type { GuardrailToolCall } from "../src/tools/tool-call-availability.js";

describe("maybeRewriteOpenAINonStreamCollapsedToolCalls", () => {
  it("leaves calls unchanged unless non-stream collapse is explicitly requested", async () => {
    const calls: GuardrailToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "b.ts" } },
    ];
    const logger = { info: vi.fn() };

    const result = await maybeRewriteOpenAINonStreamCollapsedToolCalls({
      calls,
      enabled: true,
      rewriteNonStream: true,
      collapseHeader: undefined,
      workspaceRoot: "/tmp/synesis-tool-collapse-test",
      shellAllowlistEnv: "",
      logger,
      requestId: "req-1",
    });

    expect(result).toBe(calls);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "tool_collapse_rewrite_non_stream",
    );
  });

  it("rewrites collapsible calls to synthetic tool calls", async () => {
    const calls: GuardrailToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "b.ts" } },
    ];
    const logger = { info: vi.fn() };

    const result = await maybeRewriteOpenAINonStreamCollapsedToolCalls({
      calls,
      enabled: true,
      rewriteNonStream: true,
      collapseHeader: "apply",
      workspaceRoot: "/tmp/synesis-tool-collapse-test",
      shellAllowlistEnv: "",
      logger,
      requestId: "req-1",
    });

    expect(result).toEqual([
      expect.objectContaining({
        toolCallId: "a",
        toolName: "synesis_batch_read",
        input: expect.objectContaining({
          paths: ["a.ts", "b.ts"],
          _synesis_read_semantics: "full_file_per_unique_path",
        }),
      }),
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { from: 2, to: 1, reqId: "req-1" },
      "tool_collapse_rewrite_non_stream",
    );
  });
});
