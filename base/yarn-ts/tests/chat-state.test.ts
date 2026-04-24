import { describe, expect, it } from "vitest";
import { deriveChatState, toChatStateSnapshot } from "../src/governance/chat-state.js";

describe("deriveChatState", () => {
  it("moves incorporated user corrections to resolved history", () => {
    const messages = [
      { role: "user", content: "Implement login callback handling." },
      { role: "assistant", content: "I will implement callback handling now." },
      { role: "user", content: "Correction: use OAuth callback validation instead of token polling." },
      { role: "assistant", content: "Updated auth.ts to OAuth callback validation and verified tests passed." },
      { role: "user", content: "Now add docs in src/auth.md for the callback flow." },
    ];

    const state = deriveChatState(messages);
    expect(state.unresolvedCorrections).toHaveLength(0);
    expect(state.resolvedCorrections).toHaveLength(1);
    expect(state.activeObjective).toContain("Now add docs");
    expect(state.activeObjective).not.toContain("Correction:");
  });

  it("collapses repeated assistant narration into residue summary", () => {
    const intro =
      "I am still verifying the same fix and I will continue validating the implementation before moving on.";
    const messages = [
      { role: "user", content: "Please continue." },
      { role: "assistant", content: `${intro}\n\nChecking logs now.` },
      { role: "assistant", content: `${intro}\n\nRunning tests now.` },
      { role: "assistant", content: `${intro}\n\nInspecting another output.` },
    ];

    const state = deriveChatState(messages);
    expect(state.narrationResidueSummary).toContain("Repeated assistant intent narration");
  });

  it("captures repeated acknowledgment residue and suppresses sycophant replay", () => {
    const messages = [
      { role: "user", content: "don't re-run tests; fix first" },
      { role: "assistant", content: "I understand. I will fix it." },
      { role: "assistant", content: "Understood, fixing now." },
      { role: "assistant", content: "I understand, applying fixes." },
    ];
    const state = deriveChatState(messages);
    expect(state.narrationResidueSummary).toContain("Repeated assistant acknowledgments");
  });

  it("keeps synthetic read affordances out of transcript summary", () => {
    const messages = [
      { role: "user", content: "Read src/a.ts and summarize." },
      { role: "assistant", content: "Reading now." },
      { role: "tool", content: "Unchanged since last read", name: "read_file" },
      { role: "assistant", content: "I will proceed with the existing snapshot context." },
    ];

    const state = deriveChatState(messages);
    expect(state.transcriptSummary.toLowerCase()).not.toContain("unchanged since last read");
  });

  it("reuses persisted objective snapshot when transcript is compacted", () => {
    const state = deriveChatState([], {
      previousSnapshot: {
        activeObjective: "Continue parser migration in src/parser.ts",
        pendingUserDirective: "Continue parser migration in src/parser.ts",
        phase: "edit",
        completionStatus: "in_progress",
        lastVerificationOutcome: "unknown",
        transcriptSummary: "user asked to complete parser migration",
      },
    });

    expect(state.activeObjective).toContain("parser migration");
    expect(state.pendingUserDirective).toContain("parser migration");
    expect(state.phase).toBe("edit");
  });

  it("emits a compact chat-state snapshot for session metadata", () => {
    const state = deriveChatState([
      { role: "user", content: "Implement parser guardrails in src/parser.ts" },
      { role: "assistant", content: "Implemented parser guardrails and verified with targeted tests." },
    ]);

    const snapshot = toChatStateSnapshot(state, 42);
    expect(snapshot.activeObjective).toContain("parser guardrails");
    expect(snapshot.phase).toBe(state.phase);
    expect(snapshot.resolvedCorrectionCount).toBe(0);
    expect(snapshot.updatedAt).toBe(42);
  });
});
