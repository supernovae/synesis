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
    expect(messages[1].content).not.toContain("FILE_UNCHANGED");
    expect(messages[3].content).toContain("FILE_UNCHANGED");
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
    expect(messages[1].content).not.toContain("FILE_UNCHANGED");
    expect(messages[3].content).not.toContain("FILE_UNCHANGED");
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
    expect(messages[1].content).not.toContain("FILE_UNCHANGED");
    expect(messages[2].content).not.toContain("FILE_UNCHANGED");
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
    expect(stats.charsSaved).toBeGreaterThan(0);
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
    expect(stats.charsSaved).toBeGreaterThan(5000);
  });
});
