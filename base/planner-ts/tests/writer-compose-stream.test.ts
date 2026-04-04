import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCompletionStreamMock = vi.fn();

vi.mock("../src/llm/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/client.js")>("../src/llm/client.js");
  return {
    ...actual,
    isLlmAvailable: () => true,
    chatCompletionStream: (...args: unknown[]) => chatCompletionStreamMock(...args),
  };
});

import { composeWriterDraftStream } from "../src/nodes/writer-compose.js";
import type { GraphState } from "../src/state/types.js";
import { ZERO_USAGE } from "../src/llm/client.js";

describe("composeWriterDraftStream mermaid guard", () => {
  const baseState: GraphState = {
    task_description: "Explain",
    messages: [{ role: "user", content: "Explain" }],
  };

  beforeEach(() => {
    chatCompletionStreamMock.mockReset();
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED;
  });

  it("buffers the LLM stream and emits guarded mermaid (quoted labels) in chunks", async () => {
    const raw = [
      "```mermaid",
      "graph TD",
      "B --> C[Model Server (vLLM, TGI)]",
      "```",
    ].join("\n");

    chatCompletionStreamMock.mockImplementation(
      async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
        onDelta({ content: raw });
        return {
          content: raw,
          usage: { ...ZERO_USAGE },
        };
      },
    );

    const deltas: string[] = [];
    const result = await composeWriterDraftStream(baseState, (d) => {
      if (d.content) deltas.push(d.content);
    });

    expect(result.content).toContain('C["Model Server (vLLM, TGI)"]');
    expect(result.content).not.toContain("C[Model Server (vLLM, TGI)]");
    expect(deltas.join("")).toBe(result.content);
  });

  it("passes through raw deltas when mermaid guard is disabled", async () => {
    process.env.SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED = "false";

    const raw = "Hello world";
    chatCompletionStreamMock.mockImplementation(
      async (_req: unknown, onDelta: (d: { content?: string }) => void) => {
        onDelta({ content: raw });
        return {
          content: raw,
          usage: { ...ZERO_USAGE },
        };
      },
    );

    const deltas: string[] = [];
    const result = await composeWriterDraftStream(baseState, (d) => {
      if (d.content) deltas.push(d.content);
    });

    expect(deltas.join("")).toBe(raw);
    expect(result.content).toBe(raw);
  });
});
