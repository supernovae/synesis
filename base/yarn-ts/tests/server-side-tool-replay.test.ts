import { describe, expect, it, vi } from "vitest";
import {
  buildAssistantReplayParts,
  resolveServerSideToolResults,
  serverSideToolNameSet,
  splitServerSideToolCalls,
} from "../src/providers/server-side-tool-replay.js";

const names = {
  artifactToolName: "synesis_artifact_retrieve",
  knowledgeToolName: "synesis_knowledge_search",
  devDocsToolName: "search_developer_docs",
  webSearchToolName: "synesis_web_search",
  webSearchToolAlias: "web_search",
};

describe("server-side tool replay helpers", () => {
  it("splits server-side and client tool calls", () => {
    const split = splitServerSideToolCalls([
      { toolCallId: "a", toolName: "synesis_knowledge_search", input: {} },
      { toolCallId: "b", toolName: "Bash", input: {} },
    ], serverSideToolNameSet(names));

    expect(split.serverCalls.map((call) => call.toolCallId)).toEqual(["a"]);
    expect(split.clientCalls.map((call) => call.toolCallId)).toEqual(["b"]);
  });

  it("resolves server-side tool results with compact text outputs", async () => {
    const resolvers = {
      ...names,
      retrieveArtifact: vi.fn(async () => "artifact text"),
      resolveKnowledge: vi.fn(async () => ({ hits: 1 })),
      resolveDevDocs: vi.fn(async () => ({ docs: ["x"] })),
      resolveWebSearch: vi.fn(async () => ({ results: [] })),
    };

    const results = await resolveServerSideToolResults([
      { toolCallId: "a", toolName: "synesis_artifact_retrieve", input: { artifact_handle: "h1" } },
      { toolCallId: "k", toolName: "synesis_knowledge_search", input: { query: "redis" } },
      { toolCallId: "d", toolName: "search_developer_docs", input: { query: "fastify" } },
      { toolCallId: "w", toolName: "web_search", input: { query: "news" } },
    ], resolvers);

    expect(results).toEqual([
      { type: "tool-result", toolCallId: "a", toolName: "synesis_artifact_retrieve", output: { type: "text", value: "artifact text" } },
      { type: "tool-result", toolCallId: "k", toolName: "synesis_knowledge_search", output: { type: "text", value: "{\"hits\":1}" } },
      { type: "tool-result", toolCallId: "d", toolName: "search_developer_docs", output: { type: "text", value: "{\"docs\":[\"x\"]}" } },
      { type: "tool-result", toolCallId: "w", toolName: "synesis_web_search", output: { type: "text", value: "{\"results\":[]}" } },
    ]);
    expect(resolvers.retrieveArtifact).toHaveBeenCalledWith({ artifact_handle: "h1" });
  });

  it("builds assistant replay parts and preserves empty assistant content", () => {
    expect(buildAssistantReplayParts(undefined, [])).toEqual([{ type: "text", text: "" }]);
    expect(buildAssistantReplayParts("preface", [
      { toolCallId: "tc1", toolName: "synesis_knowledge_search", input: { query: "x" } },
    ])).toEqual([
      { type: "text", text: "preface" },
      { type: "tool-call", toolCallId: "tc1", toolName: "synesis_knowledge_search", input: { query: "x" } },
    ]);
  });
});
