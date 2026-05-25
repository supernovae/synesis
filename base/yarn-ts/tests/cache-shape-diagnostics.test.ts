import { describe, expect, it } from "vitest";

import {
  buildCacheShapeDiagnostics,
  buildCacheShapeOutcomeDiagnostics,
  cacheShapeDiagnosticFields,
} from "../src/telemetry/cache-shape-diagnostics.js";

describe("buildCacheShapeDiagnostics", () => {
  it("hashes stable prefix, tools, and provider options without exposing payload content", () => {
    const diagnostics = buildCacheShapeDiagnostics({
      messages: [
        { role: "system", content: "stable instructions" },
        { role: "developer", content: "stable developer instructions" },
        { role: "user", content: "volatile user text" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          metadata: { trace: "abc" },
        },
      },
    });

    expect(diagnostics).toMatchObject({
      messageCount: 3,
      toolCount: 1,
    });
    expect(diagnostics.stablePrefixBytes).toBeGreaterThan(0);
    expect(diagnostics.toolSchemaBytes).toBeGreaterThan(0);
    expect(diagnostics.providerOptionsBytes).toBeGreaterThan(0);
    expect(diagnostics.stablePrefixHash).toMatch(/^[a-f0-9]{16}$/);
    expect(diagnostics.toolSchemaHash).toMatch(/^[a-f0-9]{16}$/);
    expect(diagnostics.providerOptionsHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(diagnostics)).not.toContain("volatile user text");
    expect(JSON.stringify(diagnostics)).not.toContain("stable instructions");
  });

  it("is stable across object key ordering", () => {
    const left = buildCacheShapeDiagnostics({
      messages: [{ role: "system", content: "same" }],
      tools: [{ b: 2, a: 1 }],
      providerOptions: { openai: { z: true, a: false } },
    });
    const right = buildCacheShapeDiagnostics({
      messages: [{ content: "same", role: "system" }],
      tools: [{ a: 1, b: 2 }],
      providerOptions: { openai: { a: false, z: true } },
    });

    expect(right.stablePrefixHash).toBe(left.stablePrefixHash);
    expect(right.toolSchemaHash).toBe(left.toolSchemaHash);
    expect(right.providerOptionsHash).toBe(left.providerOptionsHash);
  });

  it("uses explicit empty sentinels for absent tools and provider options", () => {
    expect(buildCacheShapeDiagnostics({ messages: [] })).toMatchObject({
      messageCount: 0,
      stablePrefixBytes: 2,
      toolCount: 0,
      toolSchemaHash: "0:empty",
      toolSchemaBytes: 0,
      providerOptionsHash: "0:empty",
      providerOptionsBytes: 0,
    });
  });

  it("maps diagnostics to prefixed request diagnostic fields", () => {
    expect(cacheShapeDiagnosticFields({
      messageCount: 2,
      stablePrefixHash: "prefix",
      stablePrefixBytes: 50,
      toolCount: 1,
      toolSchemaHash: "tool",
      toolSchemaBytes: 75,
      providerOptionsHash: "provider",
      providerOptionsBytes: 25,
    })).toEqual({
      cacheShapeMessageCount: 2,
      cacheShapeStablePrefixHash: "prefix",
      cacheShapeStablePrefixBytes: 50,
      cacheShapeToolCount: 1,
      cacheShapeToolSchemaHash: "tool",
      cacheShapeToolSchemaBytes: 75,
      cacheShapeProviderOptionsHash: "provider",
      cacheShapeProviderOptionsBytes: 25,
    });
  });

  it("classifies cache shape outcomes from provider usage", () => {
    expect(buildCacheShapeOutcomeDiagnostics({
      inputTokens: 100,
      cachedTokens: 37,
      cacheCreationTokens: 0,
    })).toEqual({
      cacheShapePromptTokens: 100,
      cacheShapeCachedTokens: 37,
      cacheShapeCacheCreationTokens: 0,
      cacheShapeHitPct: 37,
      cacheShapeOutcome: "hit",
    });

    expect(buildCacheShapeOutcomeDiagnostics({
      inputTokens: 100,
      cachedTokens: 0,
      cacheCreationTokens: 25,
    })).toMatchObject({
      cacheShapeHitPct: 0,
      cacheShapeOutcome: "write",
    });

    expect(buildCacheShapeOutcomeDiagnostics({
      inputTokens: 100,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    })).toMatchObject({
      cacheShapeOutcome: "miss",
    });

    expect(buildCacheShapeOutcomeDiagnostics({
      inputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    })).toMatchObject({
      cacheShapeOutcome: "unknown",
    });
  });
});
