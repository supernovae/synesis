import { describe, expect, it } from "vitest";
import { FileSnapshotRegistry } from "../src/reduction/file-snapshot-registry.js";
import { normalizeReadSnapshotMessages } from "../src/reduction/read-snapshot-normalizer.js";
import { buildArtifactShadows } from "../src/governance/artifact-shadow.js";
import { deriveFileState, toFileStateSnapshot } from "../src/governance/file-state.js";

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

describe("deriveFileState", () => {
  it("uses replayed snapshot truth for unchanged hints when snapshot exists", async () => {
    const registry = new FileSnapshotRegistry();
    const path = "/tmp/state-replay.ts";
    registry.recordFullContent({
      rawPath: path,
      content: "export const stateReplay = true;\n",
      source: "client_full_read",
      turnIndex: 1,
    });

    const normalized = await normalizeReadSnapshotMessages(
      openAIToolTriplet("state-1", path, "Unchanged since last read") as never,
      registry,
      {},
    );
    const shadows = buildArtifactShadows(registry, new Map());
    const fileState = deriveFileState({
      registry,
      artifactShadows: shadows,
      messages: normalized.messages as Array<{ role: string; content: unknown; name?: string }>,
    });

    const entry = fileState.filesByPath[path];
    expect(entry.status).toBe("unchanged");
    expect(entry.sourceSemantics.signal).toBe("meta_hint_replay");
    expect(entry.fullContentAvailable).toBe(true);
    expect(entry.lastContent).toContain("stateReplay = true");
    expect(entry.lastContent?.toLowerCase()).not.toContain("unchanged since last read");
  });

  it("marks content unavailable when unchanged hint cannot rehydrate prior snapshot", async () => {
    const registry = new FileSnapshotRegistry();
    const path = "/tmp/synesis-state-evicted-never-exists.ts";
    registry.recordFullContent({
      rawPath: path,
      content: "export const stale = 1;\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    registry.evict(path);

    const normalized = await normalizeReadSnapshotMessages(
      openAIToolTriplet("state-2", path, "Unchanged since last read") as never,
      registry,
      {},
    );
    const fileState = deriveFileState({
      registry,
      artifactShadows: new Map(),
      messages: normalized.messages as Array<{ role: string; content: unknown; name?: string }>,
    });

    const entry = fileState.filesByPath[path];
    expect(entry.status).toBe("evicted");
    expect(entry.fullContentAvailable).toBe(false);
    expect(entry.lastContent).toBeNull();
    expect(entry.sourceSemantics.signal).toBe("snapshot_evicted");
  });

  it("marks snapshots stale after edit-turn mutation", () => {
    const registry = new FileSnapshotRegistry();
    const path = "/tmp/state-stale-after-edit.ts";
    registry.recordFullContent({
      rawPath: path,
      content: "export const staleAfterEdit = false;\n",
      source: "client_full_read",
      turnIndex: 2,
    });

    const editTurns = new Map<string, number>([[path, 9]]);
    const shadows = buildArtifactShadows(registry, editTurns);
    const fileState = deriveFileState({
      registry,
      artifactShadows: shadows,
      messages: [],
    });

    const entry = fileState.filesByPath[path];
    expect(entry.status).toBe("stale");
    expect(entry.staleSinceEdit).toBe(true);
    expect(entry.lastEditTurn).toBe(9);
  });

  it("emits compact status counts for persisted file-state snapshot", () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/available.ts",
      content: "export const ok = true;\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    registry.recordFullContent({
      rawPath: "/tmp/partial.ts",
      content: "line 10",
      lineRange: { startLine: 10, endLine: 10 },
      completeness: "partial",
      source: "client_partial_read",
      turnIndex: 2,
    });

    const shadows = buildArtifactShadows(
      registry,
      new Map<string, number>([["/tmp/partial.ts", 4]]),
    );
    const fileState = deriveFileState({
      registry,
      artifactShadows: shadows,
      messages: [],
    });
    const snapshot = toFileStateSnapshot(fileState, { updatedAt: 123, maxPaths: 4 });
    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.statusCounts.stale).toBe(1);
    expect(snapshot.staleFiles).toContain("/tmp/partial.ts");
    expect(snapshot.updatedAt).toBe(123);
  });
});
