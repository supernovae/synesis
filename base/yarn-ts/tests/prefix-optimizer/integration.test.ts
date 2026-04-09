import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrefixOptimizer } from "../../src/providers/prefix-optimizer/index.js";
import type { ChatMessage, ToolDefinition } from "../../src/providers/prefix-optimizer/types.js";

const fixtureFile = resolve(
  import.meta.dirname,
  "../fixtures/prefix-optimizer/claude-code-session.json",
);
const fixture = JSON.parse(readFileSync(fixtureFile, "utf-8"));

describe("PrefixOptimizer integration", () => {
  it("restructures messages with stable content first", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const turn = fixture.turns[0];
    const result = optimizer.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], "test-session-1");

    expect(result.messages.length).toBeGreaterThanOrEqual(2);

    const firstSystem = result.messages[0];
    expect(firstSystem.role).toBe("system");
    expect(firstSystem.content as string).toContain("AI coding assistant");

    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content as string).toContain("Fix the bug in auth.ts");

    const systemMessages = result.messages.filter((m) => m.role === "system");
    const lastSystemContent = (systemMessages[systemMessages.length - 1].content as string);
    const hasVolatile = lastSystemContent.includes("Today's date") ||
      lastSystemContent.includes("Workspace Path") ||
      lastSystemContent.includes("open_and_recently_viewed_files");
    expect(hasVolatile).toBe(true);
  });

  it("produces stable core hashes across turns with different volatile content", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "dashscope", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });

    const r1 = optimizer.optimize(
      fixture.turns[0].messages as ChatMessage[],
      fixture.turns[0].tools as ToolDefinition[],
      "hash-session",
    );
    const r2 = optimizer.optimize(
      fixture.turns[1].messages as ChatMessage[],
      fixture.turns[1].tools as ToolDefinition[],
      "hash-session",
    );

    expect(r1.diagnostics.coreHash).toBeTruthy();
    expect(r2.diagnostics.coreHash).toBeTruthy();
    expect(r1.diagnostics.coreHash).toBe(r2.diagnostics.coreHash);
    expect(r1.diagnostics.projectHash).toBe(r2.diagnostics.projectHash);
  });

  it("reports first_request then null miss reason on stable turns", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "dashscope", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const session = "miss-session";

    const r1 = optimizer.optimize(
      fixture.turns[0].messages as ChatMessage[],
      fixture.turns[0].tools as ToolDefinition[],
      session,
    );
    expect(r1.diagnostics.cacheMissReason).toBe("first_request");

    const r2 = optimizer.optimize(
      fixture.turns[1].messages as ChatMessage[],
      fixture.turns[1].tools as ToolDefinition[],
      session,
    );
    expect(r2.diagnostics.cacheMissReason).toBeNull();
  });

  it("markerBackend none returns empty markerIndices but same layout", () => {
    const optimizerNone = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const optimizerDS = new PrefixOptimizer({ markerBackend: "dashscope", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });

    const turn = fixture.turns[0];
    const rNone = optimizerNone.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], "none-session");
    const rDS = optimizerDS.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], "ds-session");

    expect(rNone.markerIndices).toEqual([]);
    expect(rNone.messages.length).toBe(rDS.messages.length);

    for (let i = 0; i < rNone.messages.length; i++) {
      expect(rNone.messages[i].role).toBe(rDS.messages[i].role);
    }
  });

  it("tool hash is stable regardless of tool order", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const turn = fixture.turns[0];
    const reversed = [...turn.tools].reverse();

    const r1 = optimizer.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], "tool-order-1");
    const r2 = optimizer.optimize(turn.messages as ChatMessage[], reversed as ToolDefinition[], "tool-order-2");

    expect(r1.diagnostics.toolsetHash).toBe(r2.diagnostics.toolsetHash);
  });

  it("evicts session state", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const session = "evict-session";
    const turn = fixture.turns[0];

    optimizer.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], session);
    expect(optimizer.getSessionDiagnostics(session)).not.toBeNull();

    optimizer.evictSession(session);
    expect(optimizer.getSessionDiagnostics(session)).toBeNull();
  });

  it("repeated same-task turns produce identical stable prefix hashes", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "dashscope", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const session = "repeat-session";
    const turn = fixture.turns[0];

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(optimizer.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], session));
    }

    const coreHashes = results.map((r) => r.diagnostics.coreHash);
    const projHashes = results.map((r) => r.diagnostics.projectHash);
    const toolHashes = results.map((r) => r.diagnostics.toolsetHash);

    expect(new Set(coreHashes).size).toBe(1);
    expect(new Set(projHashes).size).toBe(1);
    expect(new Set(toolHashes).size).toBe(1);

    expect(results[0].diagnostics.cacheMissReason).toBe("first_request");
    for (let i = 1; i < results.length; i++) {
      expect(results[i].diagnostics.cacheMissReason).toBeNull();
    }
  });

  it("volatile content changes do not affect stable hashes", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });

    const msg1: ChatMessage[] = [
      {
        role: "system",
        content: "You are an AI coding assistant.\n\n<rules>\nDo not rewrite files.\n</rules>\n\n<user_info>\nToday's date: Monday Apr 7, 2026\ncwd: /Users/alice/project\n</user_info>",
      },
      { role: "user", content: "Hello" },
    ];

    const msg2: ChatMessage[] = [
      {
        role: "system",
        content: "You are an AI coding assistant.\n\n<rules>\nDo not rewrite files.\n</rules>\n\n<user_info>\nToday's date: Tuesday Apr 8, 2026\ncwd: /Users/bob/other-project\n</user_info>",
      },
      { role: "user", content: "Hello" },
    ];

    const r1 = optimizer.optimize(msg1, undefined, "volatile-1");
    const r2 = optimizer.optimize(msg2, undefined, "volatile-2");

    expect(r1.diagnostics.coreHash).toBe(r2.diagnostics.coreHash);
    expect(r1.diagnostics.volatileHash).not.toBe(r2.diagnostics.volatileHash);
  });
});
