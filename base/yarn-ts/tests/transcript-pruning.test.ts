import { describe, expect, it } from "vitest";
import { TranscriptPruningService } from "../src/reduction/transcript-pruning.js";

function msg(role: string, content: string, name?: string): { role: string; name?: string; content: string } {
  return name ? { role, name, content } : { role, content };
}

function fileReadResult(path: string, content: string): { role: string; name: string; content: string } {
  return msg("tool", JSON.stringify({ filePath: path, content, truncated: false, bytes: content.length }), "read_file");
}

const defaultConfig = {
  enabled: true,
  keepTurns: 3,
  budgetChars: 500,
  stubMaxChars: 200,
  assistantCondenseChars: 300,
};

describe("TranscriptPruningService", () => {
  describe("budget gating", () => {
    it("skips pruning when under budget", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, budgetChars: 100_000 });
      const messages = [
        msg("system", "You are helpful."),
        msg("user", "Hello"),
        msg("assistant", "Hi there!"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(false);
      expect(result.messages).toEqual(messages);
      expect(svc.getStats().skippedUnderBudget).toBe(1);
    });

    it("skips pruning when disabled", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, enabled: false });
      const messages = [msg("user", "x".repeat(1000))];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(false);
    });
  });

  describe("file read dedup", () => {
    it("keeps only the latest read of the same file", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, keepTurns: 1, budgetChars: 10 });
      const messages = [
        msg("user", "read the file"),
        msg("assistant", "I'll read it"),
        fileReadResult("main.go", "package main\n// version 1"),
        msg("user", "edit it"),
        msg("assistant", "done"),
        fileReadResult("main.go", "package main\n// version 2"),
        msg("user", "looks good"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      const firstRead = result.messages[2];
      expect(firstRead.content).toContain("<FILE_SUPERSEDED");
      expect(firstRead.content).toContain("main.go");
      const lastRead = result.messages[5];
      expect(lastRead.content).toContain("version 2");
    });

    it("does not dedup different files", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, keepTurns: 1, budgetChars: 10 });
      const messages = [
        msg("user", "read files"),
        fileReadResult("main.go", "package main"),
        fileReadResult("util.go", "package util"),
        msg("user", "ok"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).not.toContain("FILE_SUPERSEDED");
      expect(result.messages[2].content).not.toContain("FILE_SUPERSEDED");
    });
  });

  describe("stale tool result eviction", () => {
    it("evicts large tool results from old turns", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        stubMaxChars: 50,
      });
      const bigOutput = "x".repeat(500);
      const messages = [
        msg("user", "run test"),
        msg("assistant", "running"),
        msg("tool", bigOutput, "run_command"),
        msg("user", "run again"),
        msg("assistant", "ok"),
        msg("tool", "PASS", "run_command"),
        msg("user", "done"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(result.messages[2].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[2].content).toContain('tool="run_command"');
      expect(result.messages[5].content).toBe("PASS");
    });

    it("keeps small tool results even from old turns", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        stubMaxChars: 200,
      });
      const messages = [
        msg("user", "run test"),
        msg("tool", "ok: 5 passed", "run_command"),
        msg("user", "done"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).toBe("ok: 5 passed");
    });
  });

  describe("old assistant condensation", () => {
    it("trims large assistant messages from old turns", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        assistantCondenseChars: 50,
      });
      const longResponse = "Here is the implementation:\n" + "line\n".repeat(100);
      const messages = [
        msg("user", "write code"),
        msg("assistant", longResponse),
        msg("user", "looks good"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(result.messages[1].content).toContain("condensed from earlier turn");
      expect((result.messages[1].content as string).length).toBeLessThan(longResponse.length);
    });

    it("keeps small assistant messages", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        assistantCondenseChars: 5000,
      });
      const messages = [
        msg("user", "hello"),
        msg("assistant", "Hi!"),
        msg("user", "bye"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).toBe("Hi!");
    });
  });

  describe("keep window", () => {
    it("preserves everything in the last N user turns", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 2,
        budgetChars: 10,
        stubMaxChars: 10,
      });
      const bigContent = "x".repeat(500);
      const messages = [
        msg("user", "turn 1"),
        msg("tool", bigContent, "run_command"),
        msg("user", "turn 2"),
        msg("tool", bigContent, "run_command"),
        msg("user", "turn 3"),
        msg("tool", bigContent, "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[3].content).toBe(bigContent);
      expect(result.messages[5].content).toBe(bigContent);
    });
  });

  describe("stats tracking", () => {
    it("accumulates stats across calls", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        stubMaxChars: 10,
      });
      const messages = [
        msg("user", "turn 1"),
        msg("tool", "x".repeat(2000), "cmd"),
        msg("user", "turn 2"),
      ];
      svc.prune(messages);
      svc.prune(messages);
      const stats = svc.getStats();
      expect(stats.invocations).toBe(2);
      expect(stats.toolResultsEvicted).toBe(2);
      expect(stats.totalCharsSaved).toBeGreaterThan(0);
    });
  });

  describe("combined strategies", () => {
    it("applies all three strategies in a realistic session", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        budgetChars: 10,
        stubMaxChars: 100,
        assistantCondenseChars: 100,
      });
      const longCode = "package main\n" + "func foo() {}\n".repeat(40);
      const messages = [
        msg("system", "You are a Go expert."),
        msg("user", "write main.go"),
        msg("assistant", longCode),
        fileReadResult("main.go", longCode),
        msg("user", "update main.go"),
        msg("assistant", longCode.replace("foo", "bar")),
        fileReadResult("main.go", longCode.replace("foo", "bar")),
        msg("user", "run tests"),
        msg("assistant", "running"),
        msg("tool", "PASS: 5 tests", "run_test"),
      ];

      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);

      expect(result.messages[2].content).toContain("condensed");
      expect(result.messages[3].content).toContain("FILE_SUPERSEDED");
      expect(result.messages[5].content).toContain("condensed");
      expect(result.messages[6].content).not.toContain("SUPERSEDED");
      expect(result.messages[9].content).toBe("PASS: 5 tests");

      const stats = svc.getStats();
      expect(stats.fileDeduped).toBe(1);
      expect(stats.assistantCondensed).toBe(2);
      expect(stats.totalCharsSaved).toBeGreaterThan(0);
    });
  });
});
