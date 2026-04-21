import { describe, expect, it } from "vitest";
import { ContentAddressedDedup } from "../src/reduction/content-addressed-dedup.js";

function readResult(path: string, content: string) {
  return {
    role: "tool",
    name: "read_file",
    content: JSON.stringify({ filePath: path, content, truncated: false, bytes: content.length }),
  };
}

function shellResult(output: string) {
  return { role: "tool", name: "run_command", content: output };
}

const goSource = `package main

import "fmt"

func main() {
\tfmt.Println("Hello, World!")
}
` + "x".repeat(300);

describe("ContentAddressedDedup", () => {
  it("deduplicates identical file reads", () => {
    const dedup = new ContentAddressedDedup();
    const msgs = [
      { role: "user", content: "read main.go" },
      readResult("main.go", goSource),
      { role: "assistant", content: "got it" },
      readResult("main.go", goSource),
    ];
    const { messages, dedupCount } = dedup.processMessages(msgs);
    expect(dedupCount).toBe(1);
    expect(messages[1].content).toContain("main.go");
    expect(messages[1].content).not.toContain('"status":"ok/replayed_snapshot"');
    expect(messages[3].content).toContain('"status":"ok/replayed_snapshot"');
    expect(messages[3].content).toContain('"reason":"dedup_replay"');
    expect(messages[3].content).toContain("main.go");
  });

  it("does not dedup modified file reads", () => {
    const dedup = new ContentAddressedDedup();
    const msgs = [
      { role: "user", content: "read" },
      readResult("main.go", goSource),
      { role: "assistant", content: "editing" },
      readResult("main.go", goSource.replace("Hello", "Goodbye")),
    ];
    const { messages, dedupCount } = dedup.processMessages(msgs);
    expect(dedupCount).toBe(0);
    expect(messages[1].content).not.toContain('"status":"ok/replayed_snapshot"');
    expect(messages[3].content).not.toContain('"status":"ok/replayed_snapshot"');
  });

  it("does not dedup different files", () => {
    const dedup = new ContentAddressedDedup();
    const msgs = [
      { role: "user", content: "read" },
      readResult("main.go", goSource),
      readResult("util.go", goSource.replace("main", "util")),
    ];
    const { messages, dedupCount } = dedup.processMessages(msgs);
    expect(dedupCount).toBe(0);
    expect(messages[1].content).not.toContain('"status":"ok/replayed_snapshot"');
    expect(messages[2].content).not.toContain('"status":"ok/replayed_snapshot"');
  });

  it("does not dedup non-file tools", () => {
    const dedup = new ContentAddressedDedup();
    const output = "PASS: all tests\n" + "x".repeat(300);
    const msgs = [
      { role: "user", content: "run" },
      shellResult(output),
      shellResult(output),
    ];
    const { dedupCount } = dedup.processMessages(msgs);
    expect(dedupCount).toBe(0);
  });

  it("does not dedup small file reads", () => {
    const dedup = new ContentAddressedDedup();
    const msgs = [
      { role: "user", content: "read" },
      readResult("go.mod", "module foo"),
      readResult("go.mod", "module foo"),
    ];
    const { dedupCount } = dedup.processMessages(msgs);
    expect(dedupCount).toBe(0);
  });

  it("tracks stats across calls", () => {
    const dedup = new ContentAddressedDedup();
    const msgs1 = [readResult("main.go", goSource)];
    dedup.processMessages(msgs1);
    const msgs2 = [readResult("main.go", goSource)];
    dedup.processMessages(msgs2);
    const stats = dedup.getStats();
    expect(stats.totalReads).toBe(2);
    expect(stats.deduplicatedReads).toBe(1);
    expect(stats.charsSaved).toBeGreaterThanOrEqual(0);
  });

  it("updates hash when file changes, then deduplicates the new version", () => {
    const dedup = new ContentAddressedDedup();
    dedup.processMessages([readResult("main.go", goSource)]);
    const changed = goSource.replace("Hello", "Goodbye");
    dedup.processMessages([readResult("main.go", changed)]);
    const { dedupCount } = dedup.processMessages([readResult("main.go", changed)]);
    expect(dedupCount).toBe(1);
  });

  it("handles read tool name variants", () => {
    const dedup = new ContentAddressedDedup();
    const content = JSON.stringify({ filePath: "main.go", content: goSource });
    dedup.processMessages([{ role: "tool", name: "Read", content }]);
    // "Read" lowercased = "read" which is in the set
    const { dedupCount } = dedup.processMessages([{ role: "tool", name: "read", content }]);
    expect(dedupCount).toBe(1);
  });

  it("resets the hash map", () => {
    const dedup = new ContentAddressedDedup();
    dedup.processMessages([readResult("main.go", goSource)]);
    expect(dedup.getTrackedFileCount()).toBe(1);
    dedup.reset();
    expect(dedup.getTrackedFileCount()).toBe(0);
    const { dedupCount } = dedup.processMessages([readResult("main.go", goSource)]);
    expect(dedupCount).toBe(0);
  });

  it("does not dedup plan files when path resolved from tool_call args", () => {
    const dedup = new ContentAddressedDedup();
    const planContent = "# My Plan\n\npath: main.go\npath=config.yaml\n\n## Tasks\n- implement feature\n" + "x".repeat(300);
    const planPath = "/Users/test/.claude/plans/my-plan.md";
    const msgs = [
      { role: "user", content: "read the plan" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: planPath }) } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "read_file", content: JSON.stringify({ filePath: planPath, content: planContent }) },
      { role: "assistant", content: "ok" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: planPath }) } }],
      },
      { role: "tool", tool_call_id: "call_2", name: "read_file", content: JSON.stringify({ filePath: planPath, content: planContent }) },
    ];
    const { dedupCount } = dedup.processMessages(msgs as never);
    expect(dedupCount).toBe(0);
  });

  it("plain-text reads still replay full body on dedup (wrong path from content is separate issue)", () => {
    const dedup = new ContentAddressedDedup();
    const planContent = "# My Plan\n\npath: main.go\n\n## Tasks\n- implement feature\n" + "x".repeat(300);
    const msgs = [
      { role: "user", content: "read the plan" },
      { role: "tool", name: "read_file", content: planContent },
      { role: "assistant", content: "ok" },
      { role: "tool", name: "read_file", content: planContent },
    ];
    const { dedupCount, messages } = dedup.processMessages(msgs as never);
    // Without tool_call args, extractFilePath picks "main.go" from content — isPlanFile is false.
    // Dedup still runs, but we cache the raw tool body (hashSource) so replay is not meta-only.
    expect(dedupCount).toBe(1);
    expect(String(messages[3].content)).toContain('"status":"ok/replayed_snapshot"');
    expect(String(messages[3].content)).toContain("# My Plan");
  });

  it("resolves file path from tool_call arguments over content extraction", () => {
    const dedup = new ContentAddressedDedup();
    const fileContent = "path: wrong.go\nsome content here\n" + "x".repeat(300);
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: "correct.go" }) } }],
      },
      { role: "tool", tool_call_id: "tc1", name: "read_file", content: JSON.stringify({ filePath: "correct.go", content: fileContent }) },
      { role: "assistant", content: "ok" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: "correct.go" }) } }],
      },
      { role: "tool", tool_call_id: "tc2", name: "read_file", content: JSON.stringify({ filePath: "correct.go", content: fileContent }) },
    ];
    const { dedupCount, messages } = dedup.processMessages(msgs as never);
    expect(dedupCount).toBe(1);
    expect(messages[4].content).toContain('"status":"ok/replayed_snapshot"');
    expect(messages[4].content).toContain('"path":"correct.go"');
    expect(messages[4].content).toContain('"content":"path: wrong.go');
  });

  it("saves significant chars in a realistic multi-read session", () => {
    const dedup = new ContentAddressedDedup();
    const files = [
      readResult("pkg/config/config.go", "package config\n" + "x".repeat(1000)),
      readResult("internal/api/client.go", "package api\n" + "y".repeat(1500)),
      readResult("pkg/streaming/streaming.go", "package streaming\n" + "z".repeat(800)),
    ];

    dedup.processMessages(files);
    dedup.processMessages(files);
    dedup.processMessages(files);

    const stats = dedup.getStats();
    expect(stats.totalReads).toBe(9);
    expect(stats.deduplicatedReads).toBe(6);
    expect(stats.charsSaved).toBeGreaterThanOrEqual(0);
  });

  it("emits needs_targeted_read status after repeated unchanged reads", () => {
    const dedup = new ContentAddressedDedup();
    const msgs = [
      readResult("main.go", goSource),
      readResult("main.go", goSource),
      readResult("main.go", goSource),
      readResult("main.go", goSource),
    ];
    const { messages } = dedup.processMessages(msgs as never);
    expect(String(messages[1].content)).toContain('"status":"ok/replayed_snapshot"');
    expect(String(messages[2].content)).toContain('"status":"ok/replayed_snapshot"');
    expect(String(messages[3].content)).toContain('"status":"needs_targeted_read"');
    expect(String(messages[3].content)).toContain('"reason":"unchanged_read_loop_pivot"');
  });
});
