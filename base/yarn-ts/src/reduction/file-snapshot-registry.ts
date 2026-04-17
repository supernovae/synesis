import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

export type SnapshotVisibilityState = "ACTIVE_VISIBLE" | "SUMMARY_ONLY" | "EVICTED";
export type SnapshotSource = "client_full_read" | "replay" | "forced_fs_read";

export interface SnapshotLineRange {
  startLine: number;
  endLine: number;
}

export interface FileSnapshotRecord {
  canonicalPath: string;
  contentHash: string;
  snapshotId: string;
  lastFullContent: string;
  lastLineRange?: SnapshotLineRange;
  visibilityState: SnapshotVisibilityState;
  clientReadSeen: boolean;
  summaryRetained: boolean;
  source: SnapshotSource;
  lastSeenTurn: number;
  lastCompactionEpoch: number;
}

export interface ReadSnapshotEnvelope {
  kind: "synesis_file_read";
  status:
    | "ok/full_content"
    | "ok/replayed_snapshot"
    | "ok/unchanged_snapshot_still_visible"
    | "needs_targeted_read"
    | "failed/snapshot_evicted";
  path?: string;
  snapshot_id?: string;
  content_hash?: string;
  visibility?: SnapshotVisibilityState;
  source?: SnapshotSource;
  line_range?: SnapshotLineRange;
  content?: string;
  reason?: string;
  detail?: string;
}

export interface FallbackReadResult {
  ok: boolean;
  content?: string;
  lineRange?: SnapshotLineRange;
  reason?: string;
  detail?: string;
}

export class FileSnapshotRegistry {
  private readonly byPath = new Map<string, FileSnapshotRecord>();
  private compactionEpoch = 0;
  private sequence = 0;

  canonicalizePath(rawPath: string, anchorDir?: string | null): string {
    const trimmed = rawPath.trim();
    if (!trimmed) return "";
    const resolved = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.normalize(path.resolve(anchorDir || process.cwd(), trimmed));
    return resolved.replace(/\\/g, "/");
  }

  recordFullContent(params: {
    rawPath: string;
    content: string;
    lineRange?: SnapshotLineRange;
    source: SnapshotSource;
    turnIndex: number;
    anchorDir?: string | null;
  }): FileSnapshotRecord | null {
    const canonicalPath = this.canonicalizePath(params.rawPath, params.anchorDir);
    if (!canonicalPath) return null;
    const contentHash = sha256(params.content);
    const existing = this.byPath.get(canonicalPath);
    const snapshotId = existing && existing.contentHash === contentHash
      ? existing.snapshotId
      : `snap_${(++this.sequence).toString(36)}_${contentHash.slice(0, 10)}`;
    const next: FileSnapshotRecord = {
      canonicalPath,
      contentHash,
      snapshotId,
      lastFullContent: params.content,
      lastLineRange: params.lineRange,
      visibilityState: "ACTIVE_VISIBLE",
      clientReadSeen: true,
      summaryRetained: false,
      source: params.source,
      lastSeenTurn: params.turnIndex,
      lastCompactionEpoch: this.compactionEpoch,
    };
    this.byPath.set(canonicalPath, next);
    return next;
  }

  getByPath(rawPath: string, anchorDir?: string | null): FileSnapshotRecord | null {
    const canonical = this.canonicalizePath(rawPath, anchorDir);
    if (!canonical) return null;
    return this.byPath.get(canonical) ?? null;
  }

  markCompaction(defaultState: SnapshotVisibilityState = "SUMMARY_ONLY"): void {
    this.compactionEpoch += 1;
    for (const [p, rec] of this.byPath.entries()) {
      if (defaultState === "EVICTED") {
        this.byPath.set(p, {
          ...rec,
          visibilityState: "EVICTED",
          summaryRetained: false,
          lastCompactionEpoch: this.compactionEpoch,
        });
        continue;
      }
      this.byPath.set(p, {
        ...rec,
        visibilityState: rec.visibilityState === "EVICTED" ? "EVICTED" : "SUMMARY_ONLY",
        summaryRetained: true,
        lastCompactionEpoch: this.compactionEpoch,
      });
    }
  }

  markVisible(rawPath: string, anchorDir?: string | null): void {
    const canonical = this.canonicalizePath(rawPath, anchorDir);
    if (!canonical) return;
    const rec = this.byPath.get(canonical);
    if (!rec) return;
    this.byPath.set(canonical, {
      ...rec,
      visibilityState: "ACTIVE_VISIBLE",
      summaryRetained: false,
    });
  }

  markEvicted(rawPath: string, anchorDir?: string | null): void {
    const canonical = this.canonicalizePath(rawPath, anchorDir);
    if (!canonical) return;
    const rec = this.byPath.get(canonical);
    if (!rec) return;
    this.byPath.set(canonical, {
      ...rec,
      visibilityState: "EVICTED",
      summaryRetained: false,
    });
  }

  evict(rawPath: string, anchorDir?: string | null): void {
    const canonical = this.canonicalizePath(rawPath, anchorDir);
    if (!canonical) return;
    this.byPath.delete(canonical);
  }

  size(): number {
    return this.byPath.size;
  }
}

export function isUnchangedHint(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t.includes("unchanged since last read")
    || t === "file unchanged"
    || t === "unchanged"
    || t.includes("<file_unchanged")
    || t.includes("<file_read_blocked");
}

export function buildReadSnapshotEnvelope(payload: ReadSnapshotEnvelope): string {
  return JSON.stringify(payload);
}

export function parseReadSnapshotEnvelope(raw: string): ReadSnapshotEnvelope | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as ReadSnapshotEnvelope;
    if (parsed?.kind !== "synesis_file_read") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function guardedFallbackRead(
  rawPath: string,
  options?: {
    anchorDir?: string | null;
    projectRoot?: string | null;
    lineRange?: SnapshotLineRange;
  },
): Promise<FallbackReadResult> {
  const canonical = canonicalizeForRead(rawPath, options?.anchorDir);
  if (!canonical) {
    return { ok: false, reason: "invalid_path", detail: "missing_or_invalid_path" };
  }
  if (!path.isAbsolute(canonical)) {
    return { ok: false, reason: "path_not_absolute", detail: canonical };
  }
  if (options?.projectRoot) {
    const root = canonicalizeForRead(options.projectRoot, null);
    if (root && !isSubpath(canonical, root)) {
      return { ok: false, reason: "outside_project_root", detail: canonical };
    }
  }
  try {
    const raw = await readFile(canonical, "utf8");
    if (!options?.lineRange) return { ok: true, content: raw };
    const ranged = applyLineRange(raw, options.lineRange);
    return {
      ok: true,
      content: ranged.content,
      lineRange: ranged.lineRange,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "io_error", detail: detail.slice(0, 500) };
  }
}

function canonicalizeForRead(rawPath: string, anchorDir?: string | null): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const resolved = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.normalize(path.resolve(anchorDir || process.cwd(), trimmed));
  return resolved.replace(/\\/g, "/");
}

function isSubpath(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function applyLineRange(content: string, range: SnapshotLineRange): { content: string; lineRange: SnapshotLineRange } {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.trunc(range.startLine));
  const end = Math.max(start, Math.trunc(range.endLine));
  const chunk = lines.slice(start - 1, end);
  const boundedEnd = Math.min(end, lines.length);
  return {
    content: chunk.join("\n"),
    lineRange: { startLine: start, endLine: boundedEnd },
  };
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
