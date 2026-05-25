import { describe, expect, it } from "vitest";

import { buildCacheShapeDiagnostics } from "../src/telemetry/cache-shape-diagnostics.js";

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
});
