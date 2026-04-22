import { describe, expect, it } from "vitest";

import {
  applyObjectiveScope,
  resolveObjectiveEpoch,
  type ObjectiveScopeMessage,
} from "../src/governance/objective-scope.js";
import type { ChatState } from "../src/governance/chat-state.js";
import type { FileState } from "../src/governance/file-state.js";

function makeChatState(overrides: Partial<ChatState>): ChatState {
  return {
    activeObjective: null,
    phase: "edit",
    unresolvedCorrections: [],
    resolvedCorrections: [],
    lastAttemptSummary: null,
    lastVerificationOutcome: "unknown",
    blockers: [],
    currentFocusPaths: [],
    transcriptSummary: "",
    narrationResidueSummary: null,
    pendingUserDirective: null,
    completionStatus: "in_progress",
    ...overrides,
  };
}

function makeFileState(path: string, status: "stale" | "partial" | "evicted" = "stale"): Pick<FileState, "filesByPath"> {
  return {
    filesByPath: {
      [path]: {
        path,
        status,
        lastContent: null,
        fullContentAvailable: false,
        summaryOnly: true,
        lastHash: null,
        lastReadTurn: null,
        lastEditTurn: null,
        staleSinceEdit: status === "stale",
        visibleRange: null,
        retainedRange: null,
        replayableSnapshotId: null,
        readReturnedContent: false,
        sourceSemantics: {
          signal: "none",
          envelopeStatus: "none",
        },
      },
    },
  };
}

describe("objective scope", () => {
  it("increments objective epoch when objective meaningfully changes", () => {
    const chatState = makeChatState({
      activeObjective: "Implement parser fix in src/parser.ts",
      pendingUserDirective: "Implement parser fix in src/parser.ts",
    });
    const epoch = resolveObjectiveEpoch({
      metadata: {
        objective_epoch_id: 2,
        objective_epoch_objective_text: "Audit the repository and summarize findings",
        objective_epoch_objective_hash: "prevhash",
      },
      chatState,
      latestUserPromptText: "Implement parser fix in src/parser.ts",
      requestOrdinal: 7,
    });

    expect(epoch.objectiveChanged).toBe(true);
    expect(epoch.epochId).toBe(3);
    expect(epoch.anchorUserHash.length).toBeGreaterThan(10);
    expect(epoch.objectiveSetRequest).toBe(7);
  });

  it("keeps objective epoch stable for equivalent objective refinements", () => {
    const baseObjective = "Implement parser fix in src/parser.ts and add tests";
    const chatState = makeChatState({
      activeObjective: "Implement parser fix in parser.ts and add targeted tests",
      pendingUserDirective: "Implement parser fix in parser.ts and add targeted tests",
    });
    const epoch = resolveObjectiveEpoch({
      metadata: {
        objective_epoch_id: 4,
        objective_epoch_objective_text: baseObjective,
      },
      chatState,
      latestUserPromptText: "Implement parser fix in parser.ts and add targeted tests",
      requestOrdinal: 9,
    });

    expect(epoch.objectiveChanged).toBe(false);
    expect(epoch.epochId).toBe(4);
    expect(epoch.objectiveSetRequest).toBe(9);
    expect(epoch.similarityToPrevious).toBeGreaterThan(0.65);
  });

  it("fences transcript to objective anchor and emits relevant pre-boundary evidence", () => {
    const currentObjective = "Implement parser fix in src/parser.ts";
    const chatState = makeChatState({
      activeObjective: currentObjective,
      pendingUserDirective: currentObjective,
      currentFocusPaths: ["src/parser.ts"],
      blockers: ["failing parser tests"],
      transcriptSummary: "parser tests fail",
      lastVerificationOutcome: "fail",
    });
    const epoch = resolveObjectiveEpoch({
      metadata: {
        objective_epoch_id: 1,
        objective_epoch_objective_text: "Old objective",
      },
      chatState,
      latestUserPromptText: currentObjective,
      requestOrdinal: 5,
    });

    const messages: ObjectiveScopeMessage[] = [
      { role: "user", content: "Old objective unrelated to parser." },
      { role: "tool", name: "read_file", content: "README.md general project notes." },
      { role: "tool", name: "run_test", content: "src/parser.ts:42: fail expected token" },
      { role: "user", content: currentObjective },
      { role: "assistant", content: "Working on parser fix now." },
    ];

    const scoped = applyObjectiveScope({
      messages,
      epoch,
      chatState,
      fileState: makeFileState("src/parser.ts", "stale"),
      maxRelevantEvidence: 4,
      preBoundaryWindow: 20,
      minimumScore: 3,
    });

    expect(scoped.boundaryIndex).toBe(3);
    expect(scoped.scopedMessages[0]?.role).toBe("user");
    expect(String(scoped.scopedMessages[0]?.content)).toContain("Implement parser fix");
    expect(scoped.retainedEvidenceCount).toBeGreaterThan(0);
    expect(scoped.relevantEvidenceBlock).toContain("src/parser.ts");
    expect(scoped.relevantEvidenceBlock).not.toContain("README.md general project notes");
  });

  it("falls back to the latest user boundary when anchor hash is unavailable", () => {
    const chatState = makeChatState({
      activeObjective: "Implement auth fix",
      pendingUserDirective: "Implement auth fix",
    });
    const scoped = applyObjectiveScope({
      messages: [
        { role: "user", content: "First objective." },
        { role: "assistant", content: "Investigating." },
        { role: "user", content: "Implement auth fix" },
        { role: "assistant", content: "Working now." },
      ],
      epoch: {
        epochId: 2,
        objectiveHash: "abc",
        objectiveText: "Implement auth fix",
        anchorUserHash: "missing-anchor-hash",
        objectiveSetRequest: 3,
        objectiveChanged: false,
        similarityToPrevious: 1,
      },
      chatState,
      fileState: makeFileState("src/auth.ts", "partial"),
    });

    expect(scoped.boundaryIndex).toBe(2);
    expect(scoped.anchorMatched).toBe(false);
  });

  it("adjusts boundary to preserve tool_call/tool_result pairs (OpenAI format)", () => {
    const chatState = makeChatState({
      activeObjective: "Fix the bug",
      pendingUserDirective: "Fix the bug",
    });
    const messages: Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }> = [
      { role: "user", content: "Old stuff" },
      { role: "assistant", content: "analysis" },
      { role: "tool", content: "result for tc_1", tool_call_id: "tc_1", name: "Bash" },
      { role: "tool", content: "result for tc_2", tool_call_id: "tc_2", name: "Bash" },
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc_1" }, { id: "tc_2" }] },
      { role: "tool", content: "new result for tc_1", tool_call_id: "tc_1", name: "Bash" },
      { role: "tool", content: "new result for tc_2", tool_call_id: "tc_2", name: "Bash" },
    ];

    const scoped = applyObjectiveScope({
      messages: messages as ObjectiveScopeMessage[],
      epoch: {
        epochId: 1,
        objectiveHash: "abc",
        objectiveText: "Fix the bug",
        anchorUserHash: "",
        objectiveSetRequest: 1,
        objectiveChanged: false,
        similarityToPrevious: 1,
      },
      chatState,
      fileState: makeFileState("src/bug.ts"),
    });

    expect(scoped.boundaryIndex).toBe(4);
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of scoped.scopedMessages as Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }>) {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) toolCallIds.add(tc.id);
      }
      if (m.tool_call_id) toolResultIds.add(m.tool_call_id);
    }
    for (const id of toolCallIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });

  it("adjusts boundary backward when assistant tool_calls straddle the boundary", () => {
    const chatState = makeChatState({
      activeObjective: "Fix the parser",
      pendingUserDirective: "Fix the parser",
    });
    const messages: Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }> = [
      { role: "user", content: "Old work" },
      { role: "assistant", content: "analysis" },
      { role: "tool", content: "result for tc_4_0", tool_call_id: "tc_4_0", name: "read_file" },
      { role: "tool", content: "result for tc_4_1", tool_call_id: "tc_4_1", name: "read_file" },
      { role: "user", content: "Fix the parser" },
      { role: "assistant", content: "Let me check", tool_calls: [{ id: "tc_4_0" }, { id: "tc_4_1" }] },
      { role: "tool", content: "new result", tool_call_id: "tc_5", name: "Bash" },
    ];

    const scoped = applyObjectiveScope({
      messages: messages as ObjectiveScopeMessage[],
      epoch: {
        epochId: 1,
        objectiveHash: "abc",
        objectiveText: "Fix the parser",
        anchorUserHash: "",
        objectiveSetRequest: 1,
        objectiveChanged: false,
        similarityToPrevious: 1,
      },
      chatState,
      fileState: makeFileState("src/parser.ts"),
    });

    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of scoped.scopedMessages as Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }>) {
      if (m.tool_calls) for (const tc of m.tool_calls) toolCallIds.add(tc.id);
      if (m.tool_call_id) toolResultIds.add(m.tool_call_id);
    }
    expect(toolCallIds.has("tc_4_0")).toBe(true);
    expect(toolCallIds.has("tc_4_1")).toBe(true);
    for (const id of toolCallIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
    expect(scoped.boundaryIndex).toBeLessThanOrEqual(2);
  });

  it("adjusts boundary to preserve tool_call/tool_result pairs when results are before boundary", () => {
    const chatState = makeChatState({
      activeObjective: "Fix the bug",
      pendingUserDirective: "Fix the bug",
    });
    const messages: Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }> = [
      { role: "user", content: "Initial setup" },
      { role: "assistant", content: "analysis" },
      { role: "tool", content: "old result", tool_call_id: "tc_old", name: "Bash" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc_3" }] },
      { role: "tool", content: "result for tc_3", tool_call_id: "tc_3", name: "Bash" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc_4" }] },
      { role: "tool", content: "result for tc_4", tool_call_id: "tc_4", name: "read_file" },
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc_5" }] },
      { role: "tool", content: "result for tc_5", tool_call_id: "tc_5", name: "Bash" },
    ];

    const scoped = applyObjectiveScope({
      messages: messages as ObjectiveScopeMessage[],
      epoch: {
        epochId: 1,
        objectiveHash: "abc",
        objectiveText: "Fix the bug",
        anchorUserHash: "",
        objectiveSetRequest: 1,
        objectiveChanged: false,
        similarityToPrevious: 1,
      },
      chatState,
      fileState: makeFileState("src/bug.ts"),
    });

    expect(scoped.boundaryIndex).toBe(7);
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of scoped.scopedMessages as Array<ObjectiveScopeMessage & { tool_calls?: Array<{ id: string }> }>) {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) toolCallIds.add(tc.id);
      }
      if (m.tool_call_id) toolResultIds.add(m.tool_call_id);
    }
    for (const id of toolCallIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});
