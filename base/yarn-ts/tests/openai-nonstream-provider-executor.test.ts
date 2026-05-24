import { describe, expect, it, vi } from "vitest";
import {
  createOpenAINonStreamProviderExecutorInput,
  createOpenAINonStreamServerSideToolResolvers,
  executeOpenAINonStreamProviderLoop,
  type OpenAINonStreamProviderResultLike,
} from "../src/pipeline/openai-nonstream-provider-executor.js";

type Message = { role: string; content?: unknown };

function baseInput(
  overrides: Partial<Parameters<typeof executeOpenAINonStreamProviderLoop<Message, OpenAINonStreamProviderResultLike, { messages: Message[] }>>[0]> = {},
): Parameters<typeof executeOpenAINonStreamProviderLoop<Message, OpenAINonStreamProviderResultLike, { messages: Message[] }>>[0] {
  return {
    initialMessages: [{ role: "user", content: "hello" }],
    model: "model",
    orchestrationMaxOutputTokens: 128,
    phasePolicy: { active: false },
    governorPhase: "edit",
    clampMaxOutputTokens: (tokens) => tokens,
    generateText: async () => ({ text: "done", usage: { inputTokens: 1, outputTokens: 2 } }),
    readUsage: () => ({ inputTokens: 1, outputTokens: 2, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
    captureForensics: (messages) => ({ messages }),
    finalizeForensics: (forensics) => forensics ? {
      schemaVersion: "request_forensics_v1",
      providerModel: "model",
      path: "/v1/chat/completions",
      requestId: "req",
      timestamp: 1,
      stream: false,
      breakdown: {
        systemChars: 0,
        userChars: 0,
        assistantChars: 0,
        toolChars: 0,
        toolSchemaChars: 0,
        toolChoiceChars: 0,
        providerOptionsChars: 0,
        envelopeChars: 0,
        totalChars: 0,
        totalBytes: 0,
      },
      tokenEstimate: forensics.messages.length,
      lcpChars: 0,
      lcpRatio: 0,
      firstChangedIndex: -1,
      firstChangedSection: "unknown",
      summary: `messages=${forensics.messages.length}`,
    } : undefined,
    recordSessionEvent: () => undefined,
    serverSideToolResolvers: {
      artifactToolName: "artifact",
      knowledgeToolName: "knowledge",
      devDocsToolName: "dev_docs",
      webSearchToolName: "web_search",
      webSearchToolAlias: "web",
      retrieveArtifact: async () => "artifact-result",
      resolveKnowledge: async () => ({ answer: "knowledge-result" }),
      resolveDevDocs: async () => ({ answer: "dev-docs-result" }),
      resolveWebSearch: async () => ({ answer: "web-result" }),
    },
    ...overrides,
  };
}

describe("executeOpenAINonStreamProviderLoop", () => {
  it("runs a single provider call and finalizes request forensics", async () => {
    const calls: unknown[] = [];
    const result = await executeOpenAINonStreamProviderLoop(baseInput({
      generateText: async (options) => {
        calls.push(options);
        return { text: "ok", usage: {} };
      },
    }));

    expect(calls).toHaveLength(1);
    expect(result.result.text).toBe("ok");
    expect(result.requestForensicsDone?.summary).toBe("messages=1");
  });

  it("replays server-side tool calls before returning the final result", async () => {
    const seenMessages: Message[][] = [];
    let count = 0;
    const result = await executeOpenAINonStreamProviderLoop(baseInput({
      generateText: async (options) => {
        const messages = options.messages as Message[];
        seenMessages.push(messages);
        count += 1;
        if (count === 1) {
          return {
            text: "searching",
            usage: {},
            toolCalls: [{ toolCallId: "call_1", toolName: "knowledge", input: { query: "cache" } }],
          };
        }
        return { text: "final", usage: {} };
      },
    }));

    expect(result.result.text).toBe("final");
    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[1]).toHaveLength(3);
    expect(seenMessages[1][1]).toMatchObject({ role: "assistant" });
    expect(seenMessages[1][2]).toMatchObject({ role: "tool" });
  });
});

describe("createOpenAINonStreamProviderExecutorInput", () => {
  it("binds route scope and request forensics callbacks", () => {
    const recordEvent = vi.fn();
    const capture = vi.fn((context) => ({ context }));
    const finalize = vi.fn(() => undefined);
    const input = createOpenAINonStreamProviderExecutorInput<Message, OpenAINonStreamProviderResultLike, { context: unknown }>({
      ...baseInput(),
      scope: {
        sessionKey: "session_1",
        requestId: "req_1",
        recordEvent,
      },
      resolvedModelId: "openai-test",
      forensics: {
        path: "/v1/chat/completions",
        stream: false,
        tools: [{ type: "function", function: { name: "Read" } }],
        phasePolicy: { active: false },
        capabilityMatrix: { tools: [] },
        capture,
        finalize,
      },
    });

    input.recordSessionEvent({
      eventKind: "phase_required_validation_retry",
      component: "execution-governor",
      detail: "reasons=missing",
    });
    const forensics = input.captureForensics([{ role: "user", content: "hello" }], "auto" as never);
    input.finalizeForensics(forensics, { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 });

    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "phase_required_validation_retry",
      component: "execution-governor",
      detail: "reasons=missing",
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_1",
      requestId: "req_1",
      path: "/v1/chat/completions",
      resolvedModelId: "openai-test",
      stream: false,
      providerOptions: input.providerOptions,
    }));
    expect(finalize).toHaveBeenCalledWith(
      forensics,
      { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      {
        sessionKey: "session_1",
        requestId: "req_1",
        resolvedModelId: "openai-test",
      },
    );
  });
});

describe("createOpenAINonStreamServerSideToolResolvers", () => {
  it("normalizes artifact lookup arguments and returns artifact content", async () => {
    const retrieveArtifact = vi.fn(async () => ({ content: "artifact-result" }));
    const resolvers = createOpenAINonStreamServerSideToolResolvers({
      artifactToolName: "artifact",
      knowledgeToolName: "knowledge",
      devDocsToolName: "dev_docs",
      webSearchToolName: "web_search",
      webSearchToolAlias: "web",
      retrieveArtifact,
      resolveKnowledge: vi.fn(),
      resolveDevDocs: vi.fn(),
      resolveWebSearch: vi.fn(),
    });

    await expect(resolvers.retrieveArtifact({
      artifact_handle: "artifact://1",
      query: "needle",
    })).resolves.toBe("artifact-result");
    await expect(resolvers.retrieveArtifact({
      artifact_handle: 42,
    })).resolves.toBe("artifact-result");

    expect(retrieveArtifact).toHaveBeenNthCalledWith(1, "artifact://1", "needle");
    expect(retrieveArtifact).toHaveBeenNthCalledWith(2, "", undefined);
    expect(resolvers.webSearchToolAlias).toBe("web");
  });
});
