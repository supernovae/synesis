import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/state/artifact-store.js";
import { ToolResultReductionService } from "../src/reduction/tool-result-reducer.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(maxRawChars = 100): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "",
    SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
    SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://openrouter.ai/api/v1",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "",
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_YARN_DB_POOL_MAX: 20,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 30000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 3000,
    SYNESIS_YARN_WRITE_QUEUE_MAX: 10000,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 50,
    SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: maxRawChars,
    SYNESIS_YARN_TOOL_OUTPUT_TRIM_GUIDED_ENABLED: true,
    SYNESIS_YARN_TOOL_OUTPUT_TRIM_MAX_LINES: 50,
    SYNESIS_YARN_TOOL_OUTPUT_TRIM_PREVIEW_LINES: 20,
    SYNESIS_YARN_TASK_PRUNING_ENABLED: true,
    SYNESIS_YARN_TASK_PRUNING_MIN_LINES: 80,
    SYNESIS_YARN_TASK_PRUNING_KEEP_MAX_LINES: 30,
    SYNESIS_YARN_TASK_PRUNING_CONTEXT_RADIUS: 1,
    SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT: 8,
    SYNESIS_YARN_VALIDATION_MAX_FINDINGS: 30,
    SYNESIS_YARN_VALIDATION_INCLUDE_RAW: false,
    SYNESIS_YARN_REDUCERS_ENABLED: true,
    SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: "",
    SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: 0.6,
    SYNESIS_YARN_REDUCER_PROFILE: "balanced",
    SYNESIS_YARN_JSON_COMPACTION_ENABLED: true,
    SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: true,
    SYNESIS_YARN_WORKING_FRAME_ENABLED: true,
    SYNESIS_YARN_PROJECT_MANIFEST_ENABLED: true,
    SYNESIS_YARN_FRAME_MAX_FILES: 12,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true
  } as AppConfig;
}

describe("ToolResultReductionService", () => {
  const codeFixtureByLanguage: Record<string, string[]> = {
    rust: [
      "use std::collections::HashMap;",
      "pub struct SessionStore { map: HashMap<String, String> }",
      "impl SessionStore {",
      "  pub fn insert(&mut self, k: String, v: String) { self.map.insert(k, v); }",
      "}",
    ],
    python: [
      "import json",
      "class SessionStore:",
      "    def save(self, key: str, value: str) -> None:",
      "        self._data[key] = value",
      "if __name__ == '__main__':",
      "    print('ok')",
    ],
    javascript: [
      "export class SessionStore {",
      "  constructor() { this.map = new Map(); }",
      "  save(key, value) { this.map.set(key, value); }",
      "}",
      "const run = () => { return true; };",
    ],
    go: [
      "package session",
      "import \"fmt\"",
      "type Store struct {}",
      "func (s *Store) Save(key string, value string) error { return nil }",
      "func main() { fmt.Println(\"ok\") }",
    ],
    shell: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "function save_session() {",
      "  local key=\"$1\"",
      "  echo \"$key\"",
      "}",
    ],
    cpp: [
      "#include <string>",
      "class Store {",
      "public:",
      "  std::string Save(const std::string& key) { return key; }",
      "};",
    ],
    csharp: [
      "using System;",
      "namespace SessionTool {",
      "public class Store {",
      "  public string Save(string key) { return key; }",
      "}}",
    ],
    java: [
      "package io.synesis.session;",
      "public class Store {",
      "  public String save(String key) { return key; }",
      "}",
      "import java.util.Map;",
    ],
    kotlin: [
      "package io.synesis.session",
      "class Store {",
      "  fun save(key: String): String = key",
      "}",
      "import kotlin.collections.MutableMap",
    ],
  };

  function expandFixture(lines: string[], total = 180): string {
    return Array.from({ length: total }, (_, i) => lines[i % lines.length]).join("\n");
  }

  it("keeps small tool outputs unchanged", () => {
    const svc = new ToolResultReductionService(makeConfig(500), new ArtifactStore());
    const out = svc.reduceMessages([
      { role: "tool", content: "short output", name: "bash" }
    ]);
    expect(out.reducedCount).toBe(0);
    expect(out.messages[0].content).toBe("short output");
  });

  it("reduces oversized tool outputs with artifact handle", () => {
    const store = new ArtifactStore();
    const svc = new ToolResultReductionService(makeConfig(20), store);
    const large = "x".repeat(400);
    const out = svc.reduceMessages([
      { role: "tool", content: large, name: "bash" }
    ]);
    expect(out.reducedCount).toBe(1);
    const reduced = String(out.messages[0].content);
    expect(reduced).toContain("<TOOL_RESULT_SUMMARY");
    expect(reduced).toContain("artifact_handle=");
    const stats = svc.getStats();
    expect(stats.artifactHandleCount).toBe(1);
    expect(stats.tokensSavedEstimateTotal).toBeGreaterThan(0);
  });

  it("can reduce standalone tool result payloads", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult(
      "_____________________ test_add _____________________\nE       assert 1 == 2",
      "pytest"
    );
    expect(out).toContain("<TOOL_REDUCED");
    expect(out).toContain('family="pytest"');
  });

  it("fails safe to artifact summary when no reducer matches and output is oversized", () => {
    const svc = new ToolResultReductionService(makeConfig(20), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult("x".repeat(200), "unknown");
    expect(out).toContain("<TOOL_RESULT_SUMMARY");
    const stats = svc.getStats();
    expect(stats.fallbackToArtifactCount).toBeGreaterThan(0);
  });

  it("tracks enrichedCount and bypassEligibleCount in stats", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    svc.reduceStandaloneToolResult(
      "_____________________ test_add _____________________\nE       assert 1 == 2",
      "pytest"
    );
    const stats = svc.getStats();
    expect(stats.enrichedCount).toBeGreaterThanOrEqual(1);
    expect(typeof stats.bypassEligibleCount).toBe("number");
  });

  it("enrichment stats start at zero", () => {
    const svc = new ToolResultReductionService(makeConfig(500), new ArtifactStore());
    const stats = svc.getStats();
    expect(stats.enrichedCount).toBe(0);
    expect(stats.bypassEligibleCount).toBe(0);
  });

  it("normalizes MCP git_status payloads for git reducer family", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult(
      {
        exitCode: 0,
        stdout: "## feature/x...origin/feature/x [ahead 1]\n M src/index.ts\n?? notes.md",
        stderr: "",
      },
      "git_status",
    );
    expect(out).toContain("<TOOL_REDUCED");
    expect(out).toContain('family="git"');
  });

  it("applies guided truncation for oversized discovery outputs", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const lines = Array.from({ length: 120 }, (_, i) => `file_${i}.ts`).join("\n");
    const out = svc.reduceMessages([
      { role: "tool", content: lines, name: "glob" },
    ]);
    expect(out.reducedCount).toBe(1);
    expect(String(out.messages[0].content)).toContain('code="tool_output_truncated_guided"');
    expect(svc.getPerRequestGuidedTruncationDelta()).toBe(1);
  });

  it("adds deterministic remediation for empty search/list outputs", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const out = svc.reduceMessages([
      { role: "tool", content: JSON.stringify({ matches: [], exitCode: 1, stderr: "" }), name: "search_code" },
    ]);
    expect(out.reducedCount).toBe(1);
    expect(String(out.messages[0].content)).toContain('code="empty_result_remediation"');
  });

  it("applies deterministic task-conditioned pruning with artifact expansion handle", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const lines = Array.from({ length: 140 }, (_, i) => {
      if (i === 15) return "INFO compiling package";
      if (i === 56) return "ERROR retry behavior duplicated request id=abc123";
      if (i === 57) return "stack traceback duplicate request";
      return `noise line ${i}`;
    }).join("\n");
    const recentPadding = Array.from({ length: 9 }, (_, i) => ({
      role: "tool" as const, name: "read_file", content: `line ${i}`,
    }));
    const out = svc.reduceMessages(
      [{ role: "tool", content: lines, name: "run_command" }, ...recentPadding],
      "add tests for retry behavior duplicate requests",
    );
    expect(out.reducedCount).toBe(1);
    const reduced = String(out.messages[0].content);
    expect(reduced).toContain('code="task_conditioned_pruning"');
    expect(reduced).toContain("artifact_handle=");
    expect(reduced).toContain("retry behavior duplicated request");
    expect(svc.getPerRequestTaskPrunedDelta()).toBe(1);
  });

  it("keeps standalone reduction parity by applying content-dispatch before reducers", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const log = Array.from({ length: 90 }, (_, i) => `2026-04-08T10:${String(i % 60).padStart(2, "0")}:00Z INFO run ${i}`).join("\n");
    const out = svc.reduceStandaloneToolResult(log, "run_command", "investigate log stream");
    expect(out).not.toBe(log);
    expect(out.toLowerCase()).toContain("log-stream");
  });

  it("does not task-prune source-like Bash reads", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const code = Array.from({ length: 180 }, (_, i) => {
      if (i === 0) return "package main";
      if (i % 6 === 0) return `func testCase${i}() {`;
      if (i % 6 === 1) return `  value := doThing(${i})`;
      if (i % 6 === 2) return "  if value != nil {";
      if (i % 6 === 3) return '    return fmt.Errorf("failed to parse config")';
      if (i % 6 === 4) return "  }";
      return "}";
    }).join("\n");
    const out = svc.reduceMessages(
      [{ role: "tool", name: "Bash", content: code }],
      "add tests for retry behavior and json output",
    );
    expect(String(out.messages[0].content)).not.toContain('code="task_conditioned_pruning"');
    expect(String(out.messages[0].content)).toContain("package main");
    expect(svc.getPerRequestTaskPrunedDelta()).toBe(0);
  });

  it("keeps task-pruning enabled for diagnostic bash output", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const diag = Array.from({ length: 160 }, (_, i) => {
      if (i === 50) return "ERROR retry behavior duplicated request id=abc123";
      if (i === 51) return "stderr: broken pipe during streaming";
      return `noise line ${i}`;
    }).join("\n");
    const recentPadding = Array.from({ length: 9 }, (_, i) => ({
      role: "tool" as const, name: "read_file", content: `line ${i}`,
    }));
    const out = svc.reduceMessages(
      [{ role: "tool", name: "run_command", content: diag }, ...recentPadding],
      "add tests for retry behavior duplicate requests",
    );
    expect(out.reducedCount).toBe(1);
    expect(String(out.messages[0].content)).toContain('code="task_conditioned_pruning"');
    expect(svc.getPerRequestTaskPrunedDelta()).toBe(1);
  });

  it.each(Object.entries(codeFixtureByLanguage))(
    "does not task-prune source-like reads for %s",
    (_language, fixtureLines) => {
      const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
      const content = expandFixture(fixtureLines);
      const out = svc.reduceMessages(
        [{ role: "tool", name: "run_command", content: { command: "cat src/file", stdout: content } }],
        "add tests for retry behavior duplicate requests and api compatibility",
      );
      const reduced = String(out.messages[0].content);
      expect(reduced).not.toContain('code="task_conditioned_pruning"');
      expect(svc.getPerRequestTaskPrunedDelta()).toBe(0);
    },
  );

  it.each(Object.entries(codeFixtureByLanguage))(
    "does not task-prune Read tool source results for %s",
    (_language, fixtureLines) => {
      const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
      const content = expandFixture(fixtureLines);
      const out = svc.reduceMessages(
        [{ role: "tool", name: "Read", content }],
        "add tests for retry behavior duplicate requests and api compatibility",
      );
      const reduced = String(out.messages[0].content);
      expect(reduced).not.toContain('code="task_conditioned_pruning"');
      expect(svc.getPerRequestTaskPrunedDelta()).toBe(0);
    },
  );

  it.each(Object.entries(codeFixtureByLanguage))(
    "does not task-prune read_file tool source results for %s",
    (_language, fixtureLines) => {
      const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
      const content = expandFixture(fixtureLines);
      const out = svc.reduceMessages(
        [{ role: "tool", name: "read_file", content }],
        "add comprehensive test suite for broken pipe handling and retry behavior",
      );
      const reduced = String(out.messages[0].content);
      expect(reduced).not.toContain('code="task_conditioned_pruning"');
      expect(svc.getPerRequestTaskPrunedDelta()).toBe(0);
    },
  );

  it("does not task-prune artifact:// WebFetch results containing source code", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const goCode = expandFixture(codeFixtureByLanguage.go);
    const out = svc.reduceMessages(
      [{ role: "tool", name: "WebFetch", content: { command: "artifact://art_abc123", stdout: goCode } }],
      "add tests for retry behavior duplicate requests and api compatibility",
    );
    const reduced = String(out.messages[0].content);
    expect(reduced).not.toContain('code="task_conditioned_pruning"');
    expect(svc.getPerRequestTaskPrunedDelta()).toBe(0);
  });

  it("still reduces Read tool results that are NOT source code", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const logLines = Array.from({ length: 180 }, (_, i) =>
      `2026-04-08T12:00:${String(i).padStart(2, "0")}Z INFO  processing request ${i} for user abc`,
    ).join("\n");
    const out = svc.reduceMessages(
      [{ role: "tool", name: "Read", content: logLines }],
      "add tests for retry behavior duplicate requests and api compatibility",
    );
    const reduced = String(out.messages[0].content);
    expect(reduced).not.toBe(logLines);
    expect(out.reducedCount).toBeGreaterThanOrEqual(1);
  });

  it("replaces Claude Code 'Unchanged since last read' cache stubs with recovery hint", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const out = svc.reduceMessages(
      [{ role: "tool", name: "Read", content: "Unchanged since last read" }],
      "implement the plan tasks",
    );
    const reduced = String(out.messages[0].content);
    expect(reduced).toContain("read_cache_stub");
    expect(reduced).toContain("Bash(cat");
    expect(reduced).not.toBe("Unchanged since last read");
    expect(out.reducedCount).toBe(1);
  });

  it("does not fire cache-stub remediation on normal Read results", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const normalContent = "const x = 42;\nexport default x;";
    const out = svc.reduceMessages(
      [{ role: "tool", name: "Read", content: normalContent }],
      "implement the plan tasks",
    );
    const reduced = String(out.messages[0].content);
    expect(reduced).not.toContain("read_cache_stub");
  });

  it("respects pruning watermark -- messages above watermark are not task-pruned", () => {
    const svc = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const longOutput = Array.from({ length: 200 }, (_, i) =>
      `line ${i}: some output that is not relevant to the task at hand`,
    ).join("\n");
    const messages = [
      { role: "tool" as const, name: "bash", content: longOutput },
      { role: "tool" as const, name: "bash", content: longOutput },
      { role: "tool" as const, name: "bash", content: longOutput },
    ];
    const withoutWatermark = svc.reduceMessages(messages, "fix the login bug");
    const svc2 = new ToolResultReductionService(makeConfig(48_000), new ArtifactStore());
    const withWatermark = svc2.reduceMessages(messages, "fix the login bug", 0);
    const wmContent1 = String(withWatermark.messages[1].content);
    const wmContent2 = String(withWatermark.messages[2].content);
    expect(wmContent1).toBe(longOutput);
    expect(wmContent2).toBe(longOutput);
    const noWmContent0 = String(withoutWatermark.messages[0].content);
    const wmContent0 = String(withWatermark.messages[0].content);
    expect(noWmContent0).toBe(wmContent0);
  });
});
