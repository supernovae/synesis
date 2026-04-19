import { describe, expect, it } from "vitest";
import { FileSnapshotRegistry } from "../src/reduction/file-snapshot-registry.js";
import { normalizeReadSnapshotMessages } from "../src/reduction/read-snapshot-normalizer.js";
import { claudeMessagesToOpenAI } from "../src/tool-mapping.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function openAIToolTriplet(toolCallId: string, filePath: string, resultContent: string): Array<Record<string, unknown>> {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ file_path: filePath }),
          },
        },
      ],
    },
    { role: "tool", name: "read_file", tool_call_id: toolCallId, content: resultContent },
  ];
}

describe("read snapshot normalizer", () => {
  it("normalizes full content read to ok/full_content envelope", async () => {
    const registry = new FileSnapshotRegistry();
    const messages = openAIToolTriplet("c1", "/tmp/a.ts", JSON.stringify({ filePath: "/tmp/a.ts", content: "x=1\n" }));
    const out = await normalizeReadSnapshotMessages(messages as never, registry, {});
    expect(out.normalizedCount).toBe(1);
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/full_content"');
    expect(toolContent).toContain('"path":"/tmp/a.ts"');
  });

  it("normalizes tool_result role payloads the same as tool payloads", async () => {
    const registry = new FileSnapshotRegistry();
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "tr1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ file_path: "/tmp/a-tool-result.ts" }),
            },
          },
        ],
      },
      {
        role: "tool_result",
        name: "read_file",
        tool_call_id: "tr1",
        content: JSON.stringify({ filePath: "/tmp/a-tool-result.ts", content: "const x = 1;\n" }),
      },
    ];
    const out = await normalizeReadSnapshotMessages(messages as never, registry, {});
    expect(out.normalizedCount).toBe(1);
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/full_content"');
    expect(toolContent).toContain('"path":"/tmp/a-tool-result.ts"');
  });

  it("replays snapshot after compaction when unchanged hint arrives", async () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/b.ts",
      content: "export const b = 2;\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    registry.markCompaction("SUMMARY_ONLY");
    const messages = openAIToolTriplet("c2", "/tmp/b.ts", "Unchanged since last read");
    const out = await normalizeReadSnapshotMessages(messages as never, registry, {});
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/replayed_snapshot"');
    expect(toolContent).toContain("export const b = 2;");
  });

  it("allows compact unchanged response while snapshot remains active", async () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/c.ts",
      content: "export const c = 3;\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    const messages = openAIToolTriplet("c3", "/tmp/c.ts", "Unchanged since last read");
    const out = await normalizeReadSnapshotMessages(messages as never, registry, {});
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/unchanged_snapshot_still_visible"');
    expect(toolContent).not.toContain('"content":"export const c = 3;');
  });

  it("falls back to filesystem read when snapshot was evicted", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-normalizer-"));
    const filePath = path.join(root, "d.ts");
    writeFileSync(filePath, "export const d = 4;\n", "utf8");
    const registry = new FileSnapshotRegistry();
    const messages = openAIToolTriplet("c4", filePath, "Unchanged since last read");
    const out = await normalizeReadSnapshotMessages(messages as never, registry, { projectRoot: root });
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/full_content"');
    expect(toolContent).toContain('"source":"forced_fs_read"');
    expect(toolContent).toContain("export const d = 4;");
  });

  it("preserves changed file full read path", async () => {
    const registry = new FileSnapshotRegistry();
    await normalizeReadSnapshotMessages(
      openAIToolTriplet("c5", "/tmp/e.ts", JSON.stringify({ filePath: "/tmp/e.ts", content: "v=1" })) as never,
      registry,
      {},
    );
    const out = await normalizeReadSnapshotMessages(
      openAIToolTriplet("c6", "/tmp/e.ts", JSON.stringify({ filePath: "/tmp/e.ts", content: "v=2" })) as never,
      registry,
      {},
    );
    expect(String(out.messages[1].content)).toContain('"status":"ok/full_content"');
    const rec = registry.getByPath("/tmp/e.ts");
    expect(rec?.lastFullContent).toBe("v=2");
  });

  it("keeps line-range semantics through compaction replay", async () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/f.ts",
      content: "L1\nL2\nL3\n",
      lineRange: { startLine: 2, endLine: 3 },
      source: "client_full_read",
      turnIndex: 1,
    });
    registry.markCompaction("SUMMARY_ONLY");
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c7",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ file_path: "/tmp/f.ts", line_range: [2, 3] }) },
          },
        ],
      },
      { role: "tool", name: "read_file", tool_call_id: "c7", content: "Unchanged since last read" },
    ];
    const out = await normalizeReadSnapshotMessages(messages as never, registry, {});
    const toolContent = String(out.messages[1].content);
    expect(toolContent).toContain('"status":"ok/replayed_snapshot"');
    expect(toolContent).toContain('"line_range":{"startLine":2,"endLine":3}');
  });

  it("applies the same normalization after Claude conversion (transport matrix)", async () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/g.ts",
      content: "export const g = 7;\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    registry.markCompaction("SUMMARY_ONLY");
    const claudeMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tcg",
            name: "Read",
            input: { file_path: "/tmp/g.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tcg",
            content: "Unchanged since last read",
          },
        ],
      },
    ];
    const converted = claudeMessagesToOpenAI(claudeMessages as never);
    const out = await normalizeReadSnapshotMessages(converted as never, registry, {});
    const tool = out.messages.find((m) => m.role === "tool");
    expect(String(tool?.content)).toContain('"status":"ok/replayed_snapshot"');
  });
});
