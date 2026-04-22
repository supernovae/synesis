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
});
