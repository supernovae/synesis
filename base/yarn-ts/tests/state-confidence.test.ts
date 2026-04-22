import { describe, expect, it } from "vitest";

import {
  assessStateConfidence,
  formatStateConfidenceBlock,
} from "../src/governance/state-confidence.js";
import type { ChatState } from "../src/governance/chat-state.js";
import type { FileState } from "../src/governance/file-state.js";

function chatState(overrides: Partial<ChatState>): ChatState {
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

function fileState(paths: Array<{ path: string; status: FileState["filesByPath"][string]["status"]; fullContentAvailable?: boolean }>): Pick<FileState, "filesByPath"> {
  const filesByPath: FileState["filesByPath"] = {};
  for (const row of paths) {
    filesByPath[row.path] = {
      path: row.path,
      status: row.status,
      lastContent: row.fullContentAvailable ? "content" : null,
      fullContentAvailable: row.fullContentAvailable === true,
      summaryOnly: row.fullContentAvailable !== true,
      lastHash: null,
      lastReadTurn: null,
      lastEditTurn: null,
      staleSinceEdit: row.status === "stale",
      visibleRange: null,
      retainedRange: null,
      replayableSnapshotId: null,
      readReturnedContent: row.fullContentAvailable === true,
      sourceSemantics: {
        signal: "none",
        envelopeStatus: "none",
      },
    };
  }
  return { filesByPath };
}

describe("state confidence", () => {
  it("reports high confidence when objective and file grounding are clear", () => {
    const assessment = assessStateConfidence({
      chatState: chatState({
        activeObjective: "Implement parser fix in src/parser.ts",
        pendingUserDirective: "Implement parser fix in src/parser.ts",
        currentFocusPaths: ["src/parser.ts"],
        transcriptSummary: "parser fix requested",
        phase: "edit",
      }),
      fileState: fileState([
        { path: "src/parser.ts", status: "available", fullContentAvailable: true },
      ]),
    });

    expect(assessment.chatConfidence).toBeGreaterThan(0.65);
    expect(assessment.fileConfidence).toBeGreaterThan(0.65);
    expect(assessment.needsReground).toBe(false);
  });

  it("requires deterministic re-grounding when confidence is low in action phase", () => {
    const assessment = assessStateConfidence({
      chatState: chatState({
        activeObjective: "Fix stale parser flow in src/parser.ts",
        pendingUserDirective: "Fix stale parser flow in src/parser.ts",
        currentFocusPaths: ["src/parser.ts"],
        narrationResidueSummary: "Repeated assistant narration",
        phase: "recover",
        lastVerificationOutcome: "fail",
      }),
      fileState: fileState([
        { path: "src/parser.ts", status: "stale", fullContentAvailable: false },
        { path: "src/lexer.ts", status: "partial", fullContentAvailable: false },
      ]),
    });

    expect(assessment.needsReground).toBe(true);
    expect(assessment.recommendedReadPath).toContain("src/parser.ts");
    expect(assessment.reasons).toContain("stale_file_snapshot_present");
    expect(assessment.overallConfidence).toBeLessThan(0.58);
  });

  it("suppresses re-grounding after a recent successful refresh read", () => {
    const assessment = assessStateConfidence({
      chatState: chatState({
        activeObjective: "Fix parser flow in src/parser.ts",
        pendingUserDirective: "Fix parser flow in src/parser.ts",
        currentFocusPaths: ["src/parser.ts"],
        phase: "recover",
      }),
      fileState: fileState([
        { path: "src/parser.ts", status: "stale", fullContentAvailable: false },
      ]),
      recentReadSatisfied: true,
    });

    expect(assessment.needsReground).toBe(false);
  });

  it("formats state confidence block only when re-grounding is required", () => {
    const low = assessStateConfidence({
      chatState: chatState({
        activeObjective: "Fix parser flow in src/parser.ts",
        pendingUserDirective: "Fix parser flow in src/parser.ts",
        currentFocusPaths: ["src/parser.ts"],
        phase: "edit",
      }),
      fileState: fileState([{ path: "src/parser.ts", status: "evicted" }]),
    });
    const high = assessStateConfidence({
      chatState: chatState({
        activeObjective: "Fix parser flow in src/parser.ts",
        pendingUserDirective: "Fix parser flow in src/parser.ts",
        currentFocusPaths: ["src/parser.ts"],
        transcriptSummary: "clear objective",
      }),
      fileState: fileState([{ path: "src/parser.ts", status: "available", fullContentAvailable: true }]),
    });

    expect(formatStateConfidenceBlock(low)).toContain("SYNESIS_STATE_CONFIDENCE");
    expect(formatStateConfidenceBlock(high)).toBeNull();
  });
});
