import type {
  FileSnapshotRegistry,
  FileSnapshotRecord,
  SnapshotCompleteness,
  SnapshotLineRange,
} from "../reduction/file-snapshot-registry.js";

export interface ArtifactReadShadow {
  canonicalPath: string;
  contentHash: string;
  contentLength: number;
  completeness: SnapshotCompleteness;
  requestedRange?: SnapshotLineRange;
  returnedRange?: SnapshotLineRange;
  lastReadTurn: number;
  lastEditTurn?: number;
  /** False when the most recent read returned a dedup stub, not actual content. */
  readReturnedContent: boolean;
  /** True when the file was edited after the last real (non-stub) read. */
  stale: boolean;
}

/**
 * Project `FileSnapshotRegistry` records into the lightweight
 * `ArtifactReadShadow` view that the execution governor consumes.
 *
 * The registry already tracks canonical path, content hash, completeness,
 * ranges, and turn index.  This projection adds `lastEditTurn` and `stale`
 * semantics that the registry itself does not own.
 *
 * @param editTurns  Map from canonical path to the turn on which the file
 *                   was last written/edited.  Maintained externally (e.g. by
 *                   tool-call governance or the index integration layer).
 */
export function buildArtifactShadows(
  registry: FileSnapshotRegistry,
  editTurns: ReadonlyMap<string, number>,
): Map<string, ArtifactReadShadow> {
  return buildArtifactShadowsFromRecords(registry.records(), editTurns);
}

/**
 * Core projection: convert one `FileSnapshotRecord` + optional edit-turn
 * into an `ArtifactReadShadow`.
 */
export function projectSnapshotToShadow(
  record: FileSnapshotRecord,
  lastEditTurn: number | undefined,
): ArtifactReadShadow {
  const readReturnedContent =
    record.visibilityState === "ACTIVE_VISIBLE" && record.clientReadSeen;
  const stale = lastEditTurn !== undefined && lastEditTurn > record.lastSeenTurn;
  return {
    canonicalPath: record.canonicalPath,
    contentHash: record.contentHash,
    contentLength: record.lastContent.length,
    completeness: record.completeness,
    requestedRange: record.requestedRange,
    returnedRange: record.returnedRange,
    lastReadTurn: record.lastSeenTurn,
    lastEditTurn,
    readReturnedContent,
    stale,
  };
}

/**
 * Build shadows from an iterable of snapshot records.  This is the
 * preferred entry point when the caller can enumerate records (e.g.
 * via a registry helper that exposes its internal map).
 */
export function buildArtifactShadowsFromRecords(
  records: Iterable<FileSnapshotRecord>,
  editTurns: ReadonlyMap<string, number>,
): Map<string, ArtifactReadShadow> {
  const out = new Map<string, ArtifactReadShadow>();
  for (const rec of records) {
    out.set(rec.canonicalPath, projectSnapshotToShadow(rec, editTurns.get(rec.canonicalPath)));
  }
  return out;
}

/**
 * Summarise artifact shadows for inclusion in pause envelopes and
 * telemetry payloads.
 */
export function summarizeArtifactContext(
  shadows: ReadonlyMap<string, ArtifactReadShadow>,
): { staleFiles: string[]; partialFiles: string[] } {
  const staleFiles: string[] = [];
  const partialFiles: string[] = [];
  for (const s of shadows.values()) {
    if (s.stale) staleFiles.push(s.canonicalPath);
    if (s.completeness === "partial") partialFiles.push(s.canonicalPath);
  }
  staleFiles.sort();
  partialFiles.sort();
  return { staleFiles, partialFiles };
}
