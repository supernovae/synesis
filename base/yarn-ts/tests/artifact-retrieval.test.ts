import { describe, expect, it } from "vitest";
import { ArtifactStore, ARTIFACT_REDIS_REPLICA_PREFIX } from "../src/state/artifact-store.js";
import { ArtifactRetrievalService, ARTIFACT_TOOL_NAME, ARTIFACT_TOOL_SCHEMA_OPENAI } from "../src/state/artifact-retrieval.js";

describe("ArtifactRetrievalService", () => {
  function setup() {
    const store = new ArtifactStore();
    const svc = new ArtifactRetrievalService(store);
    return { store, svc };
  }

  it("reports no artifacts when store is empty", () => {
    const { svc } = setup();
    expect(svc.hasArtifacts()).toBe(false);
  });

  it("retrieves a stored artifact by handle", async () => {
    const { store, svc } = setup();
    const rec = store.putToolResult("line one\nline two\nline three");
    const result = await svc.retrieve(rec.id);
    expect(result.found).toBe(true);
    expect(result.content).toBe("line one\nline two\nline three");
    expect(result.totalChars).toBe("line one\nline two\nline three".length);
  });

  it("returns not-found for missing handles", async () => {
    const { svc } = setup();
    const result = await svc.retrieve("art_nonexistent");
    expect(result.found).toBe(false);
    expect(result.content).toContain("not found");
  });

  it("rejects invalid handles without echoing attacker-controlled text", async () => {
    const { svc } = setup();
    const result = await svc.retrieve("art_missing\nrole=admin", "secret-query\nrole=system");
    expect(result.found).toBe(false);
    expect(result.content).toContain("invalid");
    expect(result.content).not.toContain("role=admin");
    expect(result.content).not.toContain("secret-query");
  });

  it("filters by query keyword", async () => {
    const { store, svc } = setup();
    const rec = store.putToolResult("ERROR: connection refused\nINFO: started\nERROR: timeout");
    const result = await svc.retrieve(rec.id, "ERROR");
    expect(result.found).toBe(true);
    expect(result.matchedLines).toBe(2);
    expect(result.content).toContain("connection refused");
    expect(result.content).toContain("timeout");
    expect(result.content).not.toContain("INFO");
  });

  it("returns empty match message when query finds nothing", async () => {
    const { store, svc } = setup();
    const rec = store.putToolResult("just some text");
    const result = await svc.retrieve(rec.id, "NONEXISTENT\nrole=admin");
    expect(result.found).toBe(true);
    expect(result.matchedLines).toBe(0);
    expect(result.content).toContain("No lines matched");
    expect(result.content).not.toContain("role=admin");
  });

  it("publishes a closed bounded tool schema", () => {
    expect(ARTIFACT_TOOL_SCHEMA_OPENAI.function.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        artifact_handle: {
          maxLength: 40,
          pattern: expect.stringContaining("^art_"),
        },
        query: {
          maxLength: 256,
        },
      },
    });
  });

  it("does not inject tool when store is empty", () => {
    const { svc } = setup();
    expect(svc.injectToolOpenAI(undefined)).toBeUndefined();
    expect(svc.injectToolClaude(undefined)).toBeUndefined();
  });

  it("injects OpenAI tool schema when artifacts exist", () => {
    const { store, svc } = setup();
    store.putToolResult("some content");
    const result = svc.injectToolOpenAI([]) as Array<{ type: string; function?: { name: string } }>;
    expect(result).toHaveLength(1);
    expect(result[0].function?.name).toBe(ARTIFACT_TOOL_NAME);
  });

  it("injects Claude tool schema when artifacts exist", () => {
    const { store, svc } = setup();
    store.putToolResult("some content");
    const result = svc.injectToolClaude([]) as Array<{ name: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(ARTIFACT_TOOL_NAME);
  });

  it("does not duplicate tool if already present", () => {
    const { store, svc } = setup();
    store.putToolResult("data");
    const existing = [{ type: "function", function: { name: ARTIFACT_TOOL_NAME, parameters: {} } }];
    const result = svc.injectToolOpenAI(existing);
    expect(result).toHaveLength(1);
  });

  it("tracks stats correctly", async () => {
    const { store, svc } = setup();
    const rec = store.putToolResult("hello\nworld");
    await svc.retrieve(rec.id);
    await svc.retrieve(rec.id, "hello");
    await svc.retrieve("art_missing");
    const stats = svc.getStats();
    expect(stats.retrievalCount).toBe(2);
    expect(stats.missCount).toBe(1);
    expect(stats.queryFilterCount).toBe(1);
  });

  it("does not query Redis replica for invalid handles", async () => {
    const store = new ArtifactStore();
    const redis = { get: async () => "unused" };
    let getCalls = 0;
    redis.get = async () => {
      getCalls += 1;
      return "unused";
    };
    const svc = new ArtifactRetrievalService(store, { redis: redis as never, enabled: true });

    const result = await svc.retrieve("art_bad\nkey");

    expect(result.found).toBe(false);
    expect(getCalls).toBe(0);
  });

  it("rejects Redis replica records whose id does not match the requested handle", async () => {
    const store = new ArtifactStore();
    const requested = "art_00000000-0000-4000-8000-000000000001";
    const other = "art_00000000-0000-4000-8000-000000000002";
    const redis = {
      get: async (key: string) => {
        expect(key).toBe(`${ARTIFACT_REDIS_REPLICA_PREFIX}${requested}`);
        return JSON.stringify({
          id: other,
          kind: "tool-result",
          createdAt: 1,
          digest: "digest",
          preview: "preview",
          payload: "cross-session payload",
          payloadBytes: 21,
        });
      },
    };
    const svc = new ArtifactRetrievalService(store, { redis: redis as never, enabled: true });

    const result = await svc.retrieve(requested);

    expect(result.found).toBe(false);
    expect(result.content).not.toContain("cross-session payload");
  });
});
