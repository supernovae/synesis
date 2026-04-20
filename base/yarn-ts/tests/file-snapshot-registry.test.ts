import { describe, expect, it } from "vitest";
import {
  FileSnapshotRegistry,
  guardedFallbackRead,
  isUnchangedHint,
} from "../src/reduction/file-snapshot-registry.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("FileSnapshotRegistry", () => {
  it("records full content and toggles visibility on compaction", () => {
    const registry = new FileSnapshotRegistry();
    const rec = registry.recordFullContent({
      rawPath: "/tmp/foo.ts",
      content: "export const a = 1;\n",
      source: "client_full_read",
      turnIndex: 4,
    });
    expect(rec).not.toBeNull();
    expect(rec?.visibilityState).toBe("ACTIVE_VISIBLE");
    registry.markCompaction("SUMMARY_ONLY");
    const after = registry.getByPath("/tmp/foo.ts");
    expect(after?.visibilityState).toBe("SUMMARY_ONLY");
    registry.markVisible("/tmp/foo.ts");
    expect(registry.getByPath("/tmp/foo.ts")?.visibilityState).toBe("ACTIVE_VISIBLE");
  });

  it("tracks changed file hash with new snapshot id", () => {
    const registry = new FileSnapshotRegistry();
    const a = registry.recordFullContent({
      rawPath: "/tmp/foo.ts",
      content: "a",
      source: "client_full_read",
      turnIndex: 1,
    });
    const b = registry.recordFullContent({
      rawPath: "/tmp/foo.ts",
      content: "b",
      source: "client_full_read",
      turnIndex: 2,
    });
    expect(a?.contentHash).not.toBe(b?.contentHash);
    expect(a?.snapshotId).not.toBe(b?.snapshotId);
  });

  it("keeps last full content when latest snapshot is partial", () => {
    const registry = new FileSnapshotRegistry();
    registry.recordFullContent({
      rawPath: "/tmp/range.ts",
      content: "L1\nL2\nL3\nL4\n",
      source: "client_full_read",
      turnIndex: 1,
    });
    const partial = registry.recordFullContent({
      rawPath: "/tmp/range.ts",
      content: "L2\nL3",
      requestedRange: { startLine: 2, endLine: 3 },
      returnedRange: { startLine: 2, endLine: 3 },
      completeness: "partial",
      source: "client_full_read",
      turnIndex: 2,
    });
    expect(partial?.completeness).toBe("partial");
    expect(partial?.requestedRange).toEqual({ startLine: 2, endLine: 3 });
    expect(partial?.returnedRange).toEqual({ startLine: 2, endLine: 3 });
    expect(partial?.lastContent).toBe("L2\nL3");
    expect(partial?.lastFullContent).toBe("L1\nL2\nL3\nL4\n");
    expect(partial?.versionIdentity.contentHash).toBe(partial?.contentHash);
  });

  it("detects unchanged hint variants", () => {
    expect(isUnchangedHint("Unchanged since last read")).toBe(true);
    expect(isUnchangedHint('<FILE_UNCHANGED path="a" />')).toBe(true);
    expect(isUnchangedHint("new file body")).toBe(false);
  });

  it("uses guarded fallback read with optional line range", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-snap-"));
    const filePath = path.join(root, "a.ts");
    writeFileSync(filePath, "L1\nL2\nL3\nL4\n", "utf8");
    const full = await guardedFallbackRead(filePath, { projectRoot: root });
    expect(full.ok).toBe(true);
    expect(full.content).toContain("L1");
    const ranged = await guardedFallbackRead(filePath, {
      projectRoot: root,
      lineRange: { startLine: 2, endLine: 3 },
    });
    expect(ranged.ok).toBe(true);
    expect(ranged.content).toBe("L2\nL3");
    expect(ranged.requestedRange).toEqual({ startLine: 2, endLine: 3 });
    expect(ranged.returnedRange).toEqual({ startLine: 2, endLine: 3 });
    expect(ranged.completeness).toBe("partial");
    expect(ranged.versionIdentity?.filesystem?.size).toBeGreaterThan(0);
  });
});
