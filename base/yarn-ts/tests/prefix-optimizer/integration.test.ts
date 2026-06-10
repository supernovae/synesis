import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrefixOptimizer } from "../../src/providers/prefix-optimizer/index.js";
import { parseRequest } from "../../src/providers/prefix-optimizer/request-parser.js";
import type { ChatMessage, ToolDefinition } from "../../src/providers/prefix-optimizer/types.js";
import { canonicalStringify } from "../../src/providers/prefix-optimizer/serializer.js";

const fixtureFile = resolve(
  import.meta.dirname,
  "../fixtures/prefix-optimizer/claude-code-session.json",
);
const fixture = JSON.parse(readFileSync(fixtureFile, "utf-8"));

describe("PrefixOptimizer integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restructures messages with stable content first", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 3, enableReduction: true, enableDiagnosticLogging: false });
    const turn = fixture.turns[0];
    const result = optimizer.optimize(turn.messages as ChatMessage[], turn.tools as ToolDefinition[], "test-session-1");

    expect(result.messages.length).toBeGreaterThanOrEqual(2);

    const firstSystem = result.messages[0];
    expect(firstSystem.role).toBe("system");
    expect(firstSystem.content as string).toContain("AI coding assistant");

    const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeDefined();
    expect(lastUser?.content as string).toContain("Fix the bug in auth.ts");

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

  it("append-only consecutive requests keep full prior payload as stable prefix", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 0, enableReduction: true, enableDiagnosticLogging: false });
    const session = "append-only-stability";

    const firstMessages: ChatMessage[] = [
      { role: "system", content: "You are an AI coding assistant.\nFollow repository rules." },
      { role: "user", content: "Implement a tiny helper function." },
    ];
    const r1 = optimizer.optimize(firstMessages, undefined, session);
    expect(r1.diagnostics.prefixStableBytes).toBe(0);

    const secondMessages: ChatMessage[] = [
      { role: "system", content: "You are an AI coding assistant.\nFollow repository rules." },
      { role: "user", content: "Implement a tiny helper function." },
      { role: "assistant", content: "I will implement it now." },
      { role: "user", content: "Proceed." },
    ];
    const r2 = optimizer.optimize(secondMessages, undefined, session);

    const comparable = `tools=${canonicalStringify(r1.tools ?? [])}\nmessages=${r1.messages
      .map((m) => canonicalStringify(m))
      .join("\n<MSG_BOUNDARY>\n")}`;
    const r1Bytes = Buffer.byteLength(comparable, "utf8");
    expect(r2.diagnostics.prefixStableBytes).toBe(r1Bytes);
  });

  it("does not retain prompt snippets in prefix divergence diagnostics", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const optimizer = new PrefixOptimizer({
      markerBackend: "none",
      maxMarkers: 0,
      enableReduction: true,
      enableDiagnosticLogging: true,
    });
    const session = "private-prefix-diagnostics";
    const stableSystem = "SECRET_SYSTEM_PREFIX_DO_NOT_LOG\nFollow repository rules.";

    optimizer.optimize([
      { role: "system", content: stableSystem },
      { role: "user", content: "SECRET_USER_TURN_ONE" },
    ], undefined, session);
    optimizer.optimize([
      { role: "system", content: stableSystem },
      { role: "user", content: "SECRET_USER_TURN_TWO" },
    ], undefined, session);

    const serializedLogs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(serializedLogs).toContain("prefix_divergence_diagnostic");
    expect(serializedLogs).toContain("\"divergenceRegion\":\"message[1]\"");
    expect(serializedLogs).not.toContain("SECRET_SYSTEM_PREFIX_DO_NOT_LOG");
    expect(serializedLogs).not.toContain("SECRET_USER_TURN_ONE");
    expect(serializedLogs).not.toContain("SECRET_USER_TURN_TWO");
    expect(serializedLogs).not.toContain("Follow repository rules");
  });

  it("keeps frame hash aligned to existing TASK_FRAME content", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 0, enableReduction: true, enableDiagnosticLogging: false });
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are an AI coding assistant.",
          "<TASK_FRAME>",
          "objective=Fix login flow",
          "phase=implementation",
          "files=src/auth.ts",
          "constraints=none",
          "pending_checks=none",
          "open_issues=none",
          "next_action=Edit src/auth.ts",
          "</TASK_FRAME>",
          "<user_info>",
          "Today's date: Tuesday Apr 8, 2026",
          "</user_info>",
        ].join("\n"),
      },
      { role: "user", content: "Proceed." },
    ];

    const parsed = parseRequest(messages);
    const frameSeg = parsed.find((s) => s.category === "task_frame");
    expect(frameSeg).toBeDefined();

    const optimized = optimizer.optimize(messages, undefined, "frame-hash-alignment");
    expect(optimized.diagnostics.frameHash).toBe(frameSeg!.hash);
  });

  it("replaces existing TASK_FRAME when its objective is a synthetic plan-mode reminder", () => {
    const optimizer = new PrefixOptimizer({ markerBackend: "none", maxMarkers: 0, enableReduction: true, enableDiagnosticLogging: false });
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are an AI coding assistant.",
          "<TASK_FRAME>",
          "objective=Plan mode is active. You MUST NOT make any edits except to the plan file.",
          "phase=planning",
          "files=none",
          "constraints=none",
          "pending_checks=none",
          "open_issues=none",
          "next_action=present it for your approval",
          "</TASK_FRAME>",
        ].join("\n"),
      },
      { role: "user", content: "/plan Build a complete Rust workspace application." },
      { role: "assistant", content: "Ready to code?\n\nHere is Claude's plan:" },
      { role: "tool", content: "User has approved your plan. You can now start coding." },
      {
        role: "user",
        content: "<system-reminder>Plan mode is active. You MUST NOT make any edits except to the plan file.</system-reminder>",
      },
    ];

    const optimized = optimizer.optimize(messages, undefined, "stale-task-frame-replaced");
    const taskFrame = optimized.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content ?? ""))
      .find((content) => content.includes("<TASK_FRAME>"));

    expect(taskFrame).toContain("objective: /plan Build a complete Rust workspace application.");
    expect(taskFrame).not.toContain("objective: Plan mode is active");
    expect(taskFrame).not.toContain("next_action=present it for your approval");
  });
});
