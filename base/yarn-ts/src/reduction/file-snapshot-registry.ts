import crypto from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

export type SnapshotVisibilityState = "ACTIVE_VISIBLE" | "SUMMARY_ONLY" | "EVICTED";
export type SnapshotSource = "client_full_read" | "replay" | "forced_fs_read";
export type SnapshotCompleteness = "full" | "partial";

export interface SnapshotLineRange {
  startLine: number;
  endLine: number;
}

export interface SnapshotFilesystemVersion {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  refreshedAtMs: number;
}

export interface SnapshotVersionIdentity {
  contentHash: string;
  filesystem?: SnapshotFilesystemVersion;
}

export interface FileSnapshotRecord {
  canonicalPath: string;
  contentHash: string;
  snapshotId: string;
  lastContent: string;
  lastFullContent?: string;
  requestedRange?: SnapshotLineRange;
  returnedRange?: SnapshotLineRange;
  completeness: SnapshotCompleteness;
  versionIdentity: SnapshotVersionIdentity;
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
  canonical_path?: string;
  snapshot_id?: string;
  content_hash?: string;
  visibility?: SnapshotVisibilityState;
  source?: SnapshotSource;
  requested_range?: SnapshotLineRange;
  returned_range?: SnapshotLineRange;
  completeness?: SnapshotCompleteness;
  version?: SnapshotVersionIdentity;
  line_range?: SnapshotLineRange;
  content?: string;
  reason?: string;
  detail?: string;
}

export interface FallbackReadResult {
  ok: boolean;
  content?: string;
  lineRange?: SnapshotLineRange;
  requestedRange?: SnapshotLineRange;
  returnedRange?: SnapshotLineRange;
  completeness?: SnapshotCompleteness;
  versionIdentity?: SnapshotVersionIdentity;
  fsVersion?: SnapshotFilesystemVersion;
  reason?: string;
  detail?: string;
}

export interface VersionProbeResult {
  ok: boolean;
  version?: SnapshotFilesystemVersion;
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
    requestedRange?: SnapshotLineRange;
    returnedRange?: SnapshotLineRange;
    lineRange?: SnapshotLineRange;
    completeness?: SnapshotCompleteness;
    fsVersion?: SnapshotFilesystemVersion;
    source: SnapshotSource;
    turnIndex: number;
    anchorDir?: string | null;
  }): FileSnapshotRecord | null {
    const canonicalPath = this.canonicalizePath(params.rawPath, params.anchorDir);
    if (!canonicalPath) return null;
    const requestedRange = normalizeLineRange(params.requestedRange ?? params.lineRange);
    const returnedRange = normalizeLineRange(params.returnedRange ?? params.lineRange ?? requestedRange);
    const completeness = inferCompleteness(params.completeness, requestedRange, returnedRange);
    const contentHash = sha256(params.content);
    const existing = this.byPath.get(canonicalPath);
    const snapshotId = existing
      && existing.contentHash === contentHash
      && existing.completeness === completeness
      && rangesEqual(existing.requestedRange, requestedRange)
      && rangesEqual(existing.returnedRange, returnedRange)
      ? existing.snapshotId
      : `snap_${(++this.sequence).toString(36)}_${contentHash.slice(0, 10)}`;
    const versionIdentity: SnapshotVersionIdentity = {
      contentHash,
      filesystem: params.fsVersion
        ?? (existing?.contentHash === contentHash ? existing.versionIdentity.filesystem : undefined),
    };
    const next: FileSnapshotRecord = {
      canonicalPath,
      contentHash,
      snapshotId,
      lastContent: params.content,
      lastFullContent: completeness === "full"
        ? params.content
        : existing?.lastFullContent,
      requestedRange,
      returnedRange,
      completeness,
      versionIdentity,
      lastLineRange: returnedRange,
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

  /** Iterate over all snapshot records (for artifact shadow projection). */
  records(): IterableIterator<FileSnapshotRecord> {
    return this.byPath.values();
  }
}

export function isUnchangedHint(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t.includes("unchanged since last read")
    || t === "file unchanged"
    || t === "unchanged"
    || t.includes("already read")
    || t.includes("already in memory")
    || t.includes("already in context")
    || t.includes("already loaded")
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
  const guard = guardReadPath(rawPath, options);
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, detail: guard.detail };
  }
  const canonical = guard.canonicalPath;
  try {
    const [raw, stats] = await Promise.all([
      readFile(canonical, "utf8"),
      stat(canonical),
    ]);
    const fsVersion = snapshotFsVersionFromStats(stats);
    if (!options?.lineRange) {
      return {
        ok: true,
        content: raw,
        completeness: "full",
        versionIdentity: {
          contentHash: sha256(raw),
          filesystem: fsVersion,
        },
        fsVersion,
      };
    }
    const requestedRange = normalizeLineRange(options.lineRange);
    const ranged = applyLineRange(raw, options.lineRange);
    return {
      ok: true,
      content: ranged.content,
      lineRange: ranged.lineRange,
      requestedRange,
      returnedRange: ranged.lineRange,
      completeness: "partial",
      versionIdentity: {
        contentHash: sha256(ranged.content),
        filesystem: fsVersion,
      },
      fsVersion,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "io_error", detail: detail.slice(0, 500) };
  }
}

export async function guardedVersionProbe(
  rawPath: string,
  options?: {
    anchorDir?: string | null;
    projectRoot?: string | null;
  },
): Promise<VersionProbeResult> {
  const guard = guardReadPath(rawPath, options);
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, detail: guard.detail };
  }
  try {
    const stats = await stat(guard.canonicalPath);
    return {
      ok: true,
      version: snapshotFsVersionFromStats(stats),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "io_error", detail: detail.slice(0, 500) };
  }
}

export function normalizeLineRange(range?: SnapshotLineRange | null): SnapshotLineRange | undefined {
  if (!range) return undefined;
  if (!Number.isFinite(Number(range.startLine)) || !Number.isFinite(Number(range.endLine))) return undefined;
  const start = Math.max(1, Math.trunc(Number(range.startLine)));
  const end = Math.max(start, Math.trunc(Number(range.endLine)));
  return { startLine: start, endLine: end };
}

export function rangesEqual(
  a?: SnapshotLineRange | null,
  b?: SnapshotLineRange | null,
): boolean {
  const an = normalizeLineRange(a);
  const bn = normalizeLineRange(b);
  if (!an && !bn) return true;
  if (!an || !bn) return false;
  return an.startLine === bn.startLine && an.endLine === bn.endLine;
}

export function isFilesystemVersionStale(
  expected?: SnapshotFilesystemVersion,
  observed?: SnapshotFilesystemVersion,
): boolean {
  if (!expected || !observed) return false;
  return expected.mtimeMs !== observed.mtimeMs || expected.size !== observed.size;
}

function inferCompleteness(
  explicit: SnapshotCompleteness | undefined,
  requestedRange?: SnapshotLineRange,
  returnedRange?: SnapshotLineRange,
): SnapshotCompleteness {
  if (explicit === "full" || explicit === "partial") return explicit;
  if (requestedRange || returnedRange) return "partial";
  return "full";
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

function guardReadPath(
  rawPath: string,
  options?: {
    anchorDir?: string | null;
    projectRoot?: string | null;
  },
): { ok: true; canonicalPath: string } | { ok: false; reason: string; detail: string } {
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
  return { ok: true, canonicalPath: canonical };
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

function snapshotFsVersionFromStats(stats: Awaited<ReturnType<typeof stat>>): SnapshotFilesystemVersion {
  const mtimeMs = Number((stats as { mtimeMs?: unknown }).mtimeMs ?? 0);
  const size = Number((stats as { size?: unknown }).size ?? 0);
  const ctimeMs = Number((stats as { ctimeMs?: unknown }).ctimeMs ?? NaN);
  return {
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
    size: Number.isFinite(size) ? size : 0,
    ctimeMs: Number.isFinite(ctimeMs) ? ctimeMs : undefined,
    refreshedAtMs: Date.now(),
  };
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
