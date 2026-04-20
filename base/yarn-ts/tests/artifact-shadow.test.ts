import { describe, expect, it } from "vitest";
import {
  projectSnapshotToShadow,
  buildArtifactShadowsFromRecords,
  summarizeArtifactContext,
  type ArtifactReadShadow,
} from "../src/governance/artifact-shadow.js";
import type { FileSnapshotRecord } from "../src/reduction/file-snapshot-registry.js";

function makeRecord(overrides: Partial<FileSnapshotRecord> = {}): FileSnapshotRecord {
  return {
    canonicalPath: "/repo/src/handler.go",
    contentHash: "abc123",
    snapshotId: "snap_1",
    lastContent: "package handler\n// ...\n",
    completeness: "full",
    versionIdentity: { contentHash: "abc123" },
    visibilityState: "ACTIVE_VISIBLE",
    clientReadSeen: true,
    summaryRetained: false,
    source: "client_full_read",
    lastSeenTurn: 3,
    lastCompactionEpoch: 0,
    ...overrides,
  };
}

describe("projectSnapshotToShadow", () => {
  it("projects a fresh full read into a non-stale shadow", () => {
    const shadow = projectSnapshotToShadow(makeRecord(), undefined);
    expect(shadow.canonicalPath).toBe("/repo/src/handler.go");
    expect(shadow.contentHash).toBe("abc123");
    expect(shadow.completeness).toBe("full");
    expect(shadow.stale).toBe(false);
    expect(shadow.readReturnedContent).toBe(true);
    expect(shadow.lastReadTurn).toBe(3);
    expect(shadow.lastEditTurn).toBeUndefined();
  });

  it("marks stale when lastEditTurn > lastSeenTurn", () => {
    const shadow = projectSnapshotToShadow(makeRecord({ lastSeenTurn: 3 }), 5);
    expect(shadow.stale).toBe(true);
    expect(shadow.lastEditTurn).toBe(5);
  });

  it("not stale when lastEditTurn <= lastSeenTurn", () => {
    const shadow = projectSnapshotToShadow(makeRecord({ lastSeenTurn: 5 }), 3);
    expect(shadow.stale).toBe(false);
  });

  it("marks readReturnedContent false when evicted", () => {
    const shadow = projectSnapshotToShadow(
      makeRecord({ visibilityState: "EVICTED" }),
      undefined,
    );
    expect(shadow.readReturnedContent).toBe(false);
  });

  it("propagates partial completeness", () => {
    const shadow = projectSnapshotToShadow(
      makeRecord({
        completeness: "partial",
        requestedRange: { startLine: 1, endLine: 50 },
        returnedRange: { startLine: 1, endLine: 50 },
      }),
      undefined,
    );
    expect(shadow.completeness).toBe("partial");
    expect(shadow.requestedRange).toEqual({ startLine: 1, endLine: 50 });
  });

  it("computes contentLength from lastContent", () => {
    const content = "hello\nworld\n";
    const shadow = projectSnapshotToShadow(makeRecord({ lastContent: content }), undefined);
    expect(shadow.contentLength).toBe(content.length);
  });
});

describe("buildArtifactShadowsFromRecords", () => {
  it("builds a map of shadows from records", () => {
    const records = [
      makeRecord({ canonicalPath: "/repo/a.go" }),
      makeRecord({ canonicalPath: "/repo/b.go", lastSeenTurn: 2 }),
    ];
    const editTurns = new Map([
      ["/repo/b.go", 5],
    ]);
    const shadows = buildArtifactShadowsFromRecords(records, editTurns);
    expect(shadows.size).toBe(2);
    expect(shadows.get("/repo/a.go")?.stale).toBe(false);
    expect(shadows.get("/repo/b.go")?.stale).toBe(true);
  });

  it("returns empty map for empty records", () => {
    const shadows = buildArtifactShadowsFromRecords([], new Map());
    expect(shadows.size).toBe(0);
  });
});

describe("summarizeArtifactContext", () => {
  it("identifies stale and partial files", () => {
    const shadows = new Map<string, ArtifactReadShadow>([
      ["/repo/a.go", {
        canonicalPath: "/repo/a.go", contentHash: "x", contentLength: 100,
        completeness: "full", lastReadTurn: 3, stale: true, readReturnedContent: true,
      }],
      ["/repo/b.go", {
        canonicalPath: "/repo/b.go", contentHash: "y", contentLength: 200,
        completeness: "partial", lastReadTurn: 5, stale: false, readReturnedContent: true,
        requestedRange: { startLine: 1, endLine: 50 },
      }],
      ["/repo/c.go", {
        canonicalPath: "/repo/c.go", contentHash: "z", contentLength: 50,
        completeness: "full", lastReadTurn: 7, stale: false, readReturnedContent: true,
      }],
    ]);
    const summary = summarizeArtifactContext(shadows);
    expect(summary.staleFiles).toEqual(["/repo/a.go"]);
    expect(summary.partialFiles).toEqual(["/repo/b.go"]);
  });
});
