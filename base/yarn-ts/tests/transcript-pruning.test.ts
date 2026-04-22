import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/state/artifact-store.js";
import { TranscriptPruningService } from "../src/reduction/transcript-pruning.js";

function msg(
  role: string,
  content: string,
  name?: string,
  extra?: { tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> },
): Record<string, unknown> {
  const m: Record<string, unknown> = { role, content };
  if (name) m.name = name;
  if (extra?.tool_call_id) m.tool_call_id = extra.tool_call_id;
  if (extra?.tool_calls) m.tool_calls = extra.tool_calls;
  return m;
}

function bashCall(id: string, command: string) {
  return msg("assistant", "", undefined, {
    tool_calls: [{ id, function: { name: "Bash", arguments: JSON.stringify({ command }) } }],
  });
}

function bashResult(id: string, output: string) {
  return msg("tool", output, "Bash", { tool_call_id: id });
}

function fileReadResult(path: string, content: string): Record<string, unknown> {
  return msg("tool", JSON.stringify({ filePath: path, content, truncated: false, bytes: content.length }), "read_file");
}

const defaultConfig = {
  enabled: true,
  keepTurns: 3,
  keepToolResults: 0,
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

    it("deduplicates identical file reads even within the recent keep window", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, keepTurns: 5, budgetChars: 10 });
      const content = "package main\nfunc main() {}\n" + "x".repeat(300);
      const messages = [
        msg("user", "read all"),
        fileReadResult("main.go", content),
        msg("assistant", "got it"),
        fileReadResult("main.go", content),
        msg("user", "ok"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(result.messages[1].content).toContain("FILE_SUPERSEDED");
      expect(result.messages[3].content).toContain("package main");
    });

    it("preserves both reads in recent window when content differs", () => {
      const svc = new TranscriptPruningService({ ...defaultConfig, keepTurns: 5, budgetChars: 10 });
      const messages = [
        msg("user", "read all"),
        fileReadResult("main.go", "package main\nversion 1\n" + "x".repeat(300)),
        msg("assistant", "editing"),
        fileReadResult("main.go", "package main\nversion 2\n" + "x".repeat(300)),
        msg("user", "ok"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).not.toContain("FILE_SUPERSEDED");
      expect(result.messages[3].content).not.toContain("FILE_SUPERSEDED");
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
    it("embeds artifact_handle when ArtifactStore is wired (H2)", () => {
      const store = new ArtifactStore({ maxPayloadBytes: 1_000_000, maxCount: 100 });
      const svc = new TranscriptPruningService(
        {
          ...defaultConfig,
          keepTurns: 1,
          budgetChars: 10,
          stubMaxChars: 50,
          artifactRetentionEnabled: true,
        },
        store,
      );
      const bigOutput = "x".repeat(500);
      const messages = [
        msg("user", "run test"),
        msg("assistant", "running"),
        msg("tool", bigOutput, "run_command"),
        msg("user", "done"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[2].content).toContain("TOOL_RESULT_PRUNED");
      expect(String(result.messages[2].content)).toMatch(/artifact_handle="art_/);
      expect(result.invocationDelta.artifactsStored).toBeGreaterThan(0);
    });

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
    it("preserves everything in the last N user turns (unique content)", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 2,
        budgetChars: 10,
        stubMaxChars: 10,
      });
      const messages = [
        msg("user", "turn 1"),
        msg("tool", "result-a " + "x".repeat(500), "run_command"),
        msg("user", "turn 2"),
        msg("tool", "result-b " + "y".repeat(500), "run_command"),
        msg("user", "turn 3"),
        msg("tool", "result-c " + "z".repeat(500), "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.messages[1].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[3].content).toContain("result-b");
      expect(result.messages[5].content).toContain("result-c");
    });

    it("collapses identical content in the recent window via near-duplicate dedup", () => {
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
      expect(result.messages[5].content).toBe(bigContent);
      expect(result.messages[3].content).toContain("NEAR_DUPLICATE_OUTPUT");
    });
  });

  describe("failing verification literal retention", () => {
    it("does not stub away an early failing go build when pruning fires", () => {
      const failOut = "# pkg\n./ask.go:306:18: undefined: extractPathField\n" + "x".repeat(700);
      const messages: Record<string, unknown>[] = [
        msg("user", "fix build"),
        bashCall("b0", "go build ./cmd/synesis/ 2>&1"),
        bashResult("b0", failOut),
      ];
      for (let i = 0; i < 14; i++) {
        messages.push(msg("assistant", `step ${i}`));
        messages.push(bashCall(`h${i}`, `echo hi${i}`));
        messages.push(bashResult(`h${i}`, "ok\n".repeat(120)));
      }
      const svc = new TranscriptPruningService({
        enabled: true,
        keepTurns: 1,
        keepToolResults: 3,
        budgetChars: 4000,
        stubMaxChars: 120,
        assistantCondenseChars: 2000,
      });
      const r = svc.prune(messages);
      expect(r.pruned).toBe(true);
      const failMsg = r.messages[2];
      expect(String(failMsg.content)).toContain("undefined:");
      expect(String(failMsg.content)).not.toContain("TOOL_RESULT_PRUNED");
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

  describe("agent loop — tool-result-count fallback", () => {
    it("prunes old tool results in a single-user-turn session with many tool calls", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 3,
        budgetChars: 10,
        stubMaxChars: 50,
      });
      const messages = [
        msg("user", "Build me a Go CLI"),
        msg("assistant", "I will build it."),
        msg("tool", "alpha output " + "a".repeat(500), "run_command"),
        msg("assistant", "Let me check."),
        msg("tool", "bravo output " + "b".repeat(500), "run_command"),
        msg("assistant", "Fixing."),
        msg("tool", "charlie output " + "c".repeat(500), "run_command"),
        msg("assistant", "Almost done."),
        msg("tool", "delta output " + "d".repeat(500), "run_command"),
        msg("assistant", "Running tests."),
        msg("tool", "echo output " + "e".repeat(500), "run_command"),
        msg("assistant", "Final check."),
        msg("tool", "PASS: all tests", "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(result.messages[2].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[4].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[6].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[8].content).toContain("delta output");
      expect(result.messages[10].content).toContain("echo output");
      expect(result.messages[12].content).toBe("PASS: all tests");
    });

    it("does not prune unique content when tool count is below keepToolResults", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 10,
        budgetChars: 10,
        stubMaxChars: 50,
      });
      const messages = [
        msg("user", "Do something"),
        msg("assistant", "ok"),
        msg("tool", "result-alpha " + "a".repeat(500), "run_command"),
        msg("assistant", "done"),
        msg("tool", "result-beta " + "b".repeat(500), "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(false);
      expect(result.messages[2].content).toContain("result-alpha");
      expect(result.messages[4].content).toContain("result-beta");
    });

    it("uses turn-based pruning when there are enough user turns even with keepToolResults set", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        keepToolResults: 100,
        budgetChars: 10,
        stubMaxChars: 50,
      });
      const bigOutput = "x".repeat(500);
      const messages = [
        msg("user", "turn 1"),
        msg("tool", bigOutput, "run_command"),
        msg("user", "turn 2"),
        msg("tool", "small result", "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(result.messages[1].content).toContain("TOOL_RESULT_PRUNED");
      expect(result.messages[3].content).toBe("small result");
    });

    it("preserves current-turn read literals even when keepToolResults fallback prunes old tools", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 2,
        budgetChars: 10,
        stubMaxChars: 80,
      });
      const readBody = [
        "export const STABLE_LITERAL = true;",
        "function currentTurnAnchor() { return 42; }",
        "x".repeat(800),
      ].join("\n");
      const messages = [
        msg("user", "single turn loop"),
        msg("assistant", "reading target"),
        fileReadResult("src/current-turn.ts", readBody),
        msg("assistant", "running checks"),
        msg("tool", "check-a\n" + "a".repeat(600), "run_command"),
        msg("assistant", "running checks again"),
        msg("tool", "check-b\n" + "b".repeat(600), "run_command"),
        msg("assistant", "one more check"),
        msg("tool", "check-c\n" + "c".repeat(600), "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(String(result.messages[2].content)).toContain("STABLE_LITERAL");
      expect(String(result.messages[4].content)).toContain("TOOL_RESULT_PRUNED");
      expect(String(result.messages[6].content)).toContain("check-b");
      expect(String(result.messages[8].content)).toContain("check-c");
    });

    it("bounds protected current-turn read literals to avoid unbounded growth", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 1,
        budgetChars: 10,
        stubMaxChars: 80,
      });
      const oldRead = "export const oldRead = true;\n" + "a".repeat(70_000);
      const latestRead = "export const latestRead = true;\n" + "b".repeat(70_000);
      const messages = [
        msg("user", "single turn loop"),
        msg("assistant", "first read"),
        fileReadResult("src/first.ts", oldRead),
        msg("assistant", "second read"),
        fileReadResult("src/second.ts", latestRead),
        msg("assistant", "verify"),
        msg("tool", "verify-a\n" + "x".repeat(600), "run_command"),
        msg("assistant", "verify again"),
        msg("tool", "verify-b\n" + "y".repeat(600), "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      expect(String(result.messages[2].content)).toContain("TOOL_RESULT_PRUNED");
      expect(String(result.messages[4].content)).toContain("latestRead");
    });

    it("uses gentler keep window for qwen sensitivities", () => {
      const cfg = {
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 2,
        budgetChars: 10,
        stubMaxChars: 80,
      };
      const big = (label: string, fill: string) => `${label}\n${fill.repeat(35_000)}`;
      const messages = [
        msg("user", "single turn loop"),
        msg("assistant", "first"),
        msg("tool", big("out-a", "a"), "run_command"),
        msg("assistant", "second"),
        msg("tool", big("out-b", "b"), "run_command"),
        msg("assistant", "third"),
        msg("tool", big("out-c", "c"), "run_command"),
        msg("assistant", "fourth"),
        msg("tool", big("out-d", "d"), "run_command"),
      ];
      const defaultSvc = new TranscriptPruningService(cfg);
      const qwenSvc = new TranscriptPruningService(cfg);
      const strictSvc = new TranscriptPruningService(cfg);
      const defaultResult = defaultSvc.prune(messages);
      const qwenResult = qwenSvc.prune(messages, undefined, "qwen3-coder-30b");
      const strictResult = strictSvc.prune(messages, undefined, "qwen3.6-coder-next");
      const defaultStubbed = defaultResult.messages.filter((m) => String(m.content).includes("TOOL_RESULT_PRUNED")).length;
      const qwenStubbed = qwenResult.messages.filter((m) => String(m.content).includes("TOOL_RESULT_PRUNED")).length;
      const strictStubbed = strictResult.messages.filter((m) => String(m.content).includes("TOOL_RESULT_PRUNED")).length;
      expect(defaultStubbed).toBeGreaterThan(qwenStubbed);
      expect(qwenStubbed).toBeGreaterThanOrEqual(strictStubbed);
      expect(String(strictResult.messages[2].content)).toContain("out-a");
    });
  });

  describe("duplicate command dedup", () => {
    it("deduplicates repeated shell commands, keeping only the latest result", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 1,
        budgetChars: 10,
        stubMaxChars: 5000,
      });
      const messages = [
        msg("user", "Build my project"),
        bashCall("tc1", "go test ./..."),
        bashResult("tc1", "FAIL: doctor.go:40 redundant newline\n" + "x".repeat(300)),
        bashCall("tc2", "go test ./..."),
        bashResult("tc2", "FAIL: doctor.go:40 redundant newline\n" + "y".repeat(300)),
        bashCall("tc3", "go test ./..."),
        bashResult("tc3", "PASS: all tests\n" + "z".repeat(300)),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      // First two runs of the same command deduped (before keep window)
      expect(result.messages[2].content).toContain("DUPLICATE_CMD_SUPERSEDED");
      expect(result.messages[2].content).toContain("go test ./...");
      expect(result.messages[4].content).toContain("DUPLICATE_CMD_SUPERSEDED");
      // Latest result preserved (inside keep window)
      expect(result.messages[6].content).toContain("PASS: all tests");
      expect(svc.getStats().commandsDeduped).toBe(2);
    });

    it("does not dedup different commands", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 1,
        budgetChars: 10,
        stubMaxChars: 5000,
      });
      const messages = [
        msg("user", "Build my project"),
        bashCall("tc1", "go build ./..."),
        bashResult("tc1", "ok\n" + "x".repeat(300)),
        bashCall("tc2", "go test ./..."),
        bashResult("tc2", "PASS\n" + "y".repeat(300)),
        bashCall("tc3", "go vet ./..."),
        bashResult("tc3", "ok\n" + "z".repeat(300)),
      ];
      const result = svc.prune(messages);
      // Each is a unique command so none gets deduped (only latest of each exists)
      expect(result.messages[2].content).not.toContain("DUPLICATE_CMD_SUPERSEDED");
      expect(result.messages[4].content).not.toContain("DUPLICATE_CMD_SUPERSEDED");
      expect(result.messages[6].content).not.toContain("DUPLICATE_CMD_SUPERSEDED");
      expect(svc.getStats().commandsDeduped).toBe(0);
    });
  });

  describe("near-duplicate output collapse", () => {
    it("collapses tool results with identical normalized content", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 1,
        budgetChars: 10,
        stubMaxChars: 5000,
      });
      const sharedOutput = "FAIL synesis.sh/synesis/cmd/synesis [build failed]\n"
        + "cmd/synesis/doctor.go:40:2: fmt.Println arg list ends with redundant newline\n"
        + "ok synesis.sh/synesis/pkg/config 0.390s\n"
        + "ok synesis.sh/synesis/pkg/streaming (cached)\n"
        + "x".repeat(200);
      const messages = [
        msg("user", "Build my project"),
        msg("assistant", "running tests"),
        msg("tool", sharedOutput, "run_command"),
        msg("assistant", "trying again"),
        msg("tool", sharedOutput, "run_command"),
        msg("assistant", "one more time"),
        msg("tool", sharedOutput, "run_command"),
      ];
      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);
      // First two identical outputs collapsed (before keep window)
      expect(result.messages[2].content).toContain("NEAR_DUPLICATE_OUTPUT");
      expect(result.messages[4].content).toContain("NEAR_DUPLICATE_OUTPUT");
      // Latest preserved (in keep window)
      expect(result.messages[6].content).toBe(sharedOutput);
      expect(svc.getStats().nearDuplicatesCollapsed).toBe(2);
    });
  });

  describe("realistic Go build agent loop", () => {
    it("dramatically reduces context for a session like the observed 14M-token one", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 5,
        budgetChars: 100,
        stubMaxChars: 200,
        assistantCondenseChars: 200,
      });

      const goTestFail = "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/doctor.go:40:2: fmt.Println arg list ends with redundant newline\nFAIL synesis.sh/synesis/cmd/synesis [build failed]\n" + "x".repeat(300);
      const longCode = "package config\n" + "func TestFoo() {}\n".repeat(30);

      const messages: Record<string, unknown>[] = [
        msg("user", "Build me a Go CLI with tests"),
        // Round 1: write code, run tests, fail
        msg("assistant", longCode),
        bashCall("tc1", "go test ./..."),
        bashResult("tc1", goTestFail),
        // Round 2: try again
        msg("assistant", "Let me check the error"),
        bashCall("tc2", "go test ./..."),
        bashResult("tc2", goTestFail),
        // Round 3: try with -v
        msg("assistant", "Trying verbose"),
        bashCall("tc3", "go test -v ./..."),
        bashResult("tc3", goTestFail),
        // Round 4: build only
        msg("assistant", "Checking build"),
        bashCall("tc4", "go build ./cmd/synesis"),
        bashResult("tc4", "(No output)"),
        // Round 5: fix and test specific pkg
        msg("assistant", "Testing specific package"),
        bashCall("tc5", "go test ./pkg/config/..."),
        bashResult("tc5", "ok synesis.sh/synesis/pkg/config 0.39s"),
        // Round 6: full test again
        msg("assistant", "Running full suite"),
        bashCall("tc6", "go test ./..."),
        bashResult("tc6", goTestFail),
        // Round 7: fix the issue
        msg("assistant", "Fixed the issue, testing again"),
        bashCall("tc7", "go test ./..."),
        bashResult("tc7", "ok synesis.sh/synesis/cmd/synesis\nok synesis.sh/synesis/pkg/config\nPASS"),
      ];

      const charsBefore = messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? (m.content as string).length : JSON.stringify(m.content ?? "").length),
        0,
      );

      const result = svc.prune(messages);
      expect(result.pruned).toBe(true);

      const charsAfter = result.messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? (m.content as string).length : JSON.stringify(m.content ?? "").length),
        0,
      );

      // Should save a significant amount — at least 40%
      const savings = 1 - charsAfter / charsBefore;
      expect(savings).toBeGreaterThan(0.4);

      const stats = svc.getStats();
      expect(stats.commandsDeduped).toBeGreaterThan(0);
      expect(stats.totalCharsSaved).toBeGreaterThan(0);
    });
  });

  describe("cumulative session simulation — O(n²) vs O(n)", () => {
    /**
     * Models what actually happens in a Claude Code session:
     *
     *   Request 1: [system, user] → model responds with tool call
     *   Request 2: [system, user, assistant, tool_result] → ...
     *   Request 3: [system, user, assistant, tool_result, assistant, tool_result] → ...
     *   ...
     *   Request N: full history of all prior N-1 exchanges
     *
     * Without pruning, total input chars across all requests = O(n²).
     * With pruning, old tool results and assistant text get stubbed,
     * capping each request to roughly the keep window + system overhead.
     */
    it("reduces cumulative input chars from O(n²) to near-linear growth", () => {
      const cfg = {
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 8,
        budgetChars: 2000,
        stubMaxChars: 200,
        assistantCondenseChars: 200,
      };

      const goTestOutput = "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/doctor.go:40:2: "
        + "fmt.Println arg list ends with redundant newline\n"
        + "FAIL synesis.sh/synesis/cmd/synesis [build failed]\n"
        + "? synesis.sh/synesis/internal/api [no test files]\n"
        + "? synesis.sh/synesis/pkg/config [no test files]\n"
        + "? synesis.sh/synesis/pkg/session [no test files]\n"
        + "? synesis.sh/synesis/pkg/streaming [no test files]\n"
        + "FAIL\n"
        + "x".repeat(200);

      const fileContent = "package config\nimport (\n\t\"os\"\n\t\"path/filepath\"\n\t\"testing\"\n)\n"
        + "func TestResolve_Defaults(t *testing.T) {\n\t// ...\n}\n".repeat(10)
        + "y".repeat(200);

      const ROUNDS = 30;

      function simulateSession(pruningEnabled: boolean) {
        const svc = new TranscriptPruningService({ ...cfg, enabled: pruningEnabled });
        const history: Record<string, unknown>[] = [
          msg("system", "You are an AI coding assistant."),
          msg("user", "Build me a Go CLI with config, session, and streaming packages plus full test coverage."),
        ];

        let cumulativeInputChars = 0;
        const perRequestChars: number[] = [];

        for (let round = 0; round < ROUNDS; round++) {
          const tc = `tc${round}`;
          // Model writes some code or reads a file
          if (round % 3 === 0) {
            history.push(msg("assistant", fileContent));
            history.push(
              msg("tool", JSON.stringify({ filePath: `pkg/config/config_test.go`, content: fileContent }), "read_file"),
            );
          }
          // Model runs a build/test command
          history.push(
            bashCall(tc, round < ROUNDS - 3 ? "go test ./..." : "go test ./pkg/config/..."),
          );
          history.push(
            bashResult(tc, round < ROUNDS - 2 ? goTestOutput : "ok synesis.sh/synesis/pkg/config 0.39s"),
          );
          history.push(msg("assistant", `Round ${round}: checking results, will fix the issue.`));

          // Simulate the client sending full history to Yarn
          const snapshot = [...history];
          const result = svc.prune(snapshot as never);
          const requestChars = result.messages.reduce(
            (sum, m) => sum + (typeof m.content === "string"
              ? (m.content as string).length
              : JSON.stringify(m.content ?? "").length),
            0,
          );
          cumulativeInputChars += requestChars;
          perRequestChars.push(requestChars);
        }

        return { cumulativeInputChars, perRequestChars };
      }

      const noPruning = simulateSession(false);
      const withPruning = simulateSession(true);

      // --- Cumulative cost reduction ---
      // Without pruning this is O(n²) — sum of linearly growing request sizes.
      // With pruning, once the budget triggers, request sizes plateau.
      const savings = 1 - withPruning.cumulativeInputChars / noPruning.cumulativeInputChars;
      expect(savings).toBeGreaterThan(0.5);

      // --- Per-request size caps ---
      // Without pruning, the last request is the largest (full history).
      const lastUnpruned = noPruning.perRequestChars[ROUNDS - 1];
      const lastPruned = withPruning.perRequestChars[ROUNDS - 1];
      expect(lastPruned).toBeLessThan(lastUnpruned * 0.5);

      // --- Growth rate flattens ---
      // The growth rate of pruned request sizes should plateau.
      // Compare the size increase between request 10→20 vs 20→30.
      const prunedGrowth1 = withPruning.perRequestChars[19] - withPruning.perRequestChars[9];
      const prunedGrowth2 = withPruning.perRequestChars[29] - withPruning.perRequestChars[19];
      // Second half should grow no more than the first half (plateau, not acceleration)
      expect(prunedGrowth2).toBeLessThanOrEqual(prunedGrowth1 * 1.5);

      // Without pruning, growth accelerates (each request adds the same delta to a bigger base)
      const unprunedGrowth1 = noPruning.perRequestChars[19] - noPruning.perRequestChars[9];
      const unprunedGrowth2 = noPruning.perRequestChars[29] - noPruning.perRequestChars[19];
      // Unpruned grows monotonically — each round adds roughly the same absolute amount
      expect(unprunedGrowth2).toBeGreaterThan(unprunedGrowth1 * 0.8);
    });

    it("preserves plan file reads during dedup and eviction", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        keepTurns: 1,
        keepToolResults: 2,
        budgetChars: 1000,
        stubMaxChars: 100,
        assistantCondenseChars: 100,
      });

      const planContent = "# Plan\n" + "- task item\n".repeat(200);
      const messages = [
        msg("user", "load plan"),
        msg("assistant", "Reading plan"),
        msg("tool", JSON.stringify({ filePath: "/home/user/.claude/plans/my-plan.md", content: planContent }), "read_file"),
        msg("assistant", "Working on it"),
        msg("tool", JSON.stringify({ filePath: "/home/user/.claude/plans/my-plan.md", content: planContent }), "read_file"),
        msg("user", "continue"),
        msg("assistant", "Sure"),
      ];

      const result = svc.prune(messages as never);
      const planMessages = result.messages.filter(
        (m) => (m.role as string) === "tool" && typeof m.content === "string" && (m.content as string).includes("my-plan.md"),
      );
      expect(planMessages.length).toBe(2);
      for (const pm of planMessages) {
        const c = String(pm.content);
        expect(c).not.toContain("FILE_SUPERSEDED");
        expect(c).not.toContain("TOOL_RESULT_PRUNED");
        expect(c).not.toContain("NEAR_DUPLICATE_OUTPUT");
        expect(c.length).toBeGreaterThan(500);
      }
    });

    it("cumulative cost scales sub-quadratically with pruning", () => {
      const cfg10 = {
        ...defaultConfig,
        keepTurns: 5,
        keepToolResults: 5,
        budgetChars: 5000,
        stubMaxChars: 100,
        assistantCondenseChars: 100,
      };

      function runNRounds(n: number, pruning: boolean): number {
        const svc = new TranscriptPruningService({ ...cfg10, enabled: pruning });
        const history: Record<string, unknown>[] = [
          msg("user", "Build a project"),
        ];
        let cumulative = 0;
        for (let i = 0; i < n; i++) {
          history.push(msg("assistant", "Working on round " + i + "\n" + "analysis ".repeat(80)));
          history.push(msg("tool", "FAIL synesis.sh/cmd line " + i + "\n" + "stack trace ".repeat(150), "run_command"));
          const result = svc.prune([...history] as never);
          cumulative += result.messages.reduce(
            (s, m) => s + (typeof m.content === "string" ? (m.content as string).length : 0),
            0,
          );
        }
        return cumulative;
      }

      const unpruned20 = runNRounds(20, false);
      const unpruned40 = runNRounds(40, false);
      const pruned20 = runNRounds(20, true);
      const pruned40 = runNRounds(40, true);

      // Without pruning, doubling rounds should ~quadruple cost (O(n²))
      const unprunedRatio = unpruned40 / unpruned20;
      expect(unprunedRatio).toBeGreaterThan(3.5);

      // With pruning, ratio should be meaningfully lower than quadratic
      const prunedRatio = pruned40 / pruned20;
      expect(prunedRatio).toBeLessThan(unprunedRatio * 0.85);

      // Absolute savings: pruned should use substantially fewer total chars
      expect(pruned40).toBeLessThan(unpruned40 * 0.6);
    });
  });

  describe("emergencyPrune", () => {
    it("does nothing when under target budget", () => {
      const svc = new TranscriptPruningService(defaultConfig);
      const messages = [
        msg("user", "Hello"),
        msg("assistant", "Hi"),
      ];
      const result = svc.emergencyPrune(messages as never, 100_000);
      expect(result.pruned).toBe(false);
      expect(result.messages).toEqual(messages);
    });

    it("aggressively evicts old tool results to fit under budget", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        budgetChars: 200_000,
        stubMaxChars: 100,
      });
      const messages: Record<string, unknown>[] = [
        msg("user", "Build the project"),
      ];
      for (let i = 0; i < 20; i++) {
        messages.push(msg("assistant", `Working on task ${i}`));
        messages.push(msg("tool", "output line ".repeat(200), "run_command", { tool_call_id: `tc_${i}` }));
      }
      const totalChars = messages.reduce(
        (s, m) => s + (typeof m.content === "string" ? (m.content as string).length : 0),
        0,
      );
      expect(totalChars).toBeGreaterThan(10_000);

      const result = svc.emergencyPrune(messages as never, 5_000);
      expect(result.pruned).toBe(true);
      expect(result.charsAfter).toBeLessThan(result.charsBefore);
      expect(result.charsAfter).toBeLessThan(10_000);
    });

    it("keeps the most recent tool results intact", () => {
      const svc = new TranscriptPruningService({
        ...defaultConfig,
        budgetChars: 200_000,
        stubMaxChars: 100,
      });
      const messages: Record<string, unknown>[] = [
        msg("user", "Build the project"),
      ];
      for (let i = 0; i < 10; i++) {
        messages.push(msg("assistant", `Step ${i}`));
        messages.push(msg("tool", `unique_output_${i}_${"x".repeat(500)}`, "run_command", { tool_call_id: `tc_${i}` }));
      }

      const result = svc.emergencyPrune(messages as never, 3_000);
      expect(result.pruned).toBe(true);
      const lastToolContent = (result.messages[result.messages.length - 1] as { content: string }).content;
      expect(lastToolContent).toContain("unique_output_9");
    });
  });
});
