import type { ArtifactReadShadow } from "./artifact-shadow.js";
import {
  parseReadSnapshotEnvelope,
  type FileSnapshotRecord,
  type FileSnapshotRegistry,
  type ReadSnapshotEnvelope,
  type SnapshotLineRange,
} from "../reduction/file-snapshot-registry.js";

export type FileStateStatus =
  | "available"
  | "partial"
  | "unchanged"
  | "stale"
  | "evicted"
  | "missing";

export const FILE_STATE_STATUSES: readonly FileStateStatus[] = [
  "available",
  "partial",
  "unchanged",
  "stale",
  "evicted",
  "missing",
];

const FILE_STATE_SOURCE_SIGNALS: readonly FileStateSourceSemantics["signal"][] = [
  "full_content",
  "replayed_snapshot",
  "meta_hint_replay",
  "targeted_read_required",
  "snapshot_evicted",
  "none",
];

const FILE_STATE_ENVELOPE_STATUSES: readonly FileStateSourceSemantics["envelopeStatus"][] = [
  "ok/full_content",
  "ok/replayed_snapshot",
  "ok/unchanged_snapshot_still_visible",
  "needs_targeted_read",
  "failed/snapshot_evicted",
  "none",
];

export interface FileStateSourceSemantics {
  signal:
    | "full_content"
    | "replayed_snapshot"
    | "meta_hint_replay"
    | "targeted_read_required"
    | "snapshot_evicted"
    | "none";
  envelopeStatus: ReadSnapshotEnvelope["status"] | "none";
  reason?: string;
  detail?: string;
}

export interface FileStateEntry {
  path: string;
  status: FileStateStatus;
  lastContent: string | null;
  fullContentAvailable: boolean;
  summaryOnly: boolean;
  lastHash: string | null;
  lastReadTurn: number | null;
  lastEditTurn: number | null;
  staleSinceEdit: boolean;
  visibleRange: SnapshotLineRange | null;
  retainedRange: SnapshotLineRange | null;
  replayableSnapshotId: string | null;
  readReturnedContent: boolean;
  sourceSemantics: FileStateSourceSemantics;
}

export interface FileState {
  filesByPath: Record<string, FileStateEntry>;
  fileCount: number;
}

export interface FileStateSnapshot {
  fileCount: number;
  statusCounts: Record<FileStateStatus, number>;
  staleFiles: string[];
  partialFiles: string[];
  evictedFiles: string[];
  updatedAt: number;
}

interface MessageLike {
  role: string;
  content: unknown;
  name?: string;
}

interface ReadSignal {
  path: string;
  status: ReadSnapshotEnvelope["status"];
  reason?: string;
  detail?: string;
  hasContent: boolean;
  content?: string;
  contentHash?: string;
  snapshotId?: string;
  returnedRange?: SnapshotLineRange;
}

export interface DeriveFileStateOptions {
  registry: FileSnapshotRegistry;
  artifactShadows?: ReadonlyMap<string, ArtifactReadShadow>;
  messages?: MessageLike[];
  maxStoredContentChars?: number;
}

export function parseFileStateStatus(value: unknown): FileStateStatus | null {
  return typeof value === "string" && (FILE_STATE_STATUSES as readonly string[]).includes(value)
    ? value as FileStateStatus
    : null;
}

export function deriveFileState(options: DeriveFileStateOptions): FileState {
  const shadowByPath = options.artifactShadows ?? new Map<string, ArtifactReadShadow>();
  const maxContentChars = Math.max(128, options.maxStoredContentChars ?? 2000);
  const readSignals = collectLatestReadSignals(options.messages ?? []);

  const recordsByPath = new Map<string, FileSnapshotRecord>();
  for (const record of options.registry.records()) {
    recordsByPath.set(record.canonicalPath, record);
  }

  const allPaths = new Set<string>([
    ...recordsByPath.keys(),
    ...shadowByPath.keys(),
    ...readSignals.keys(),
  ]);

  const sortedPaths = Array.from(allPaths).sort();
  const filesByPath: Record<string, FileStateEntry> = {};

  for (const path of sortedPaths) {
    const record = recordsByPath.get(path);
    const shadow = shadowByPath.get(path);
    const signal = readSignals.get(path);

    const staleSinceEdit = Boolean(shadow?.stale);
    const summaryOnly = record?.visibilityState === "SUMMARY_ONLY";
    const hasSignalContent = Boolean(signal?.hasContent && signal.content);
    const fullContentAvailable = hasSignalContent
      || Boolean(record?.lastFullContent && record.visibilityState !== "EVICTED");

    let status: FileStateStatus = "missing";
    if (staleSinceEdit || signal?.reason === "stale_snapshot_version") {
      status = "stale";
    } else if (signal?.status === "failed/snapshot_evicted" || record?.visibilityState === "EVICTED") {
      status = "evicted";
    } else if (signal?.status === "needs_targeted_read" && !record) {
      status = "missing";
    } else if (signal?.status === "ok/replayed_snapshot" && isMetaReplayReason(signal.reason)) {
      status = "unchanged";
    } else if (summaryOnly) {
      status = "unchanged";
    } else if (record?.completeness === "partial" || shadow?.completeness === "partial") {
      status = "partial";
    } else if (record || signal?.status === "ok/full_content" || signal?.status === "ok/replayed_snapshot") {
      status = "available";
    }

    const signalContent = hasSignalContent ? String(signal?.content ?? "") : "";
    const fallbackContent = record?.lastFullContent ?? record?.lastContent ?? "";
    const lastContentRaw = signalContent || fallbackContent;
    const lastContent = fullContentAvailable && lastContentRaw
      ? lastContentRaw.slice(0, maxContentChars)
      : null;

    const sourceSemantics = resolveSourceSemantics(record, signal);

    filesByPath[path] = {
      path,
      status,
      lastContent,
      fullContentAvailable,
      summaryOnly,
      lastHash: signal?.contentHash ?? record?.contentHash ?? null,
      lastReadTurn: record?.lastSeenTurn ?? null,
      lastEditTurn: shadow?.lastEditTurn ?? null,
      staleSinceEdit,
      visibleRange: signal?.returnedRange ?? record?.returnedRange ?? null,
      retainedRange: record?.requestedRange ?? null,
      replayableSnapshotId: signal?.snapshotId ?? record?.snapshotId ?? null,
      readReturnedContent: signal?.hasContent ?? shadow?.readReturnedContent ?? false,
      sourceSemantics,
    };
  }

  return {
    filesByPath,
    fileCount: sortedPaths.length,
  };
}

export interface FormatFileStateBlockOptions {
  maxFiles?: number;
}

export function formatFileStateBlock(
  fileState: FileState,
  options: FormatFileStateBlockOptions = {},
): string | null {
  const paths = Object.keys(fileState.filesByPath)
    .map((path) => ({ raw: path, safe: safeControlPath(path) }))
    .filter((path): path is { raw: string; safe: string } => Boolean(path.safe))
    .sort((a, b) => a.safe.localeCompare(b.safe));
  if (paths.length === 0) return null;

  const maxFiles = Math.max(1, options.maxFiles ?? 24);
  const lines: string[] = ["<SYNESIS_FILE_STATE version=\"1\">"];
  lines.push(`files_total=${safeNonNegativeInteger(fileState.fileCount)}`);

  for (const path of paths.slice(0, maxFiles)) {
    const entry = fileState.filesByPath[path.raw];
    if (!entry) continue;
    const sourceSemantics = entry.sourceSemantics ?? { signal: "none", envelopeStatus: "none" };
    lines.push(
      [
        "file",
        `path=${path.safe}`,
        `status=${parseFileStateStatus(entry.status) ?? "missing"}`,
        `full_content_available=${entry.fullContentAvailable ? "yes" : "no"}`,
        `summary_only=${entry.summaryOnly ? "yes" : "no"}`,
        `stale_since_edit=${entry.staleSinceEdit ? "yes" : "no"}`,
        `last_hash=${safeControlToken(entry.lastHash, "none", 128)}`,
        `last_read_turn=${safeInteger(entry.lastReadTurn, -1)}`,
        `last_edit_turn=${safeInteger(entry.lastEditTurn, -1)}`,
        `read_returned_content=${entry.readReturnedContent ? "yes" : "no"}`,
        `source_signal=${safeSourceSignal(sourceSemantics.signal)}`,
        `source_status=${safeEnvelopeStatus(sourceSemantics.envelopeStatus)}`,
        `source_reason=${safeControlToken(sourceSemantics.reason, "none", 160)}`,
      ].join(";"),
    );
  }

  if (paths.length > maxFiles) {
    lines.push(`truncated=${paths.length - maxFiles}`);
  }
  lines.push("</SYNESIS_FILE_STATE>");
  return lines.join("\n");
}

export function toFileStateSnapshot(
  fileState: FileState,
  options: { updatedAt?: number; maxPaths?: number } = {},
): FileStateSnapshot {
  const statusCounts: Record<FileStateStatus, number> = {
    available: 0,
    partial: 0,
    unchanged: 0,
    stale: 0,
    evicted: 0,
    missing: 0,
  };
  const staleFiles: string[] = [];
  const partialFiles: string[] = [];
  const evictedFiles: string[] = [];
  const maxPaths = Math.max(1, options.maxPaths ?? 8);

  for (const [path, entry] of Object.entries(fileState.filesByPath)) {
    const status = parseFileStateStatus(entry.status) ?? "missing";
    const safePath = safeControlPath(path);
    statusCounts[status] += 1;
    if (!safePath) continue;
    if (status === "stale" || entry.staleSinceEdit) staleFiles.push(safePath);
    if (status === "partial") partialFiles.push(safePath);
    if (status === "evicted") evictedFiles.push(safePath);
  }

  staleFiles.sort();
  partialFiles.sort();
  evictedFiles.sort();

  return {
    fileCount: fileState.fileCount,
    statusCounts,
    staleFiles: staleFiles.slice(0, maxPaths),
    partialFiles: partialFiles.slice(0, maxPaths),
    evictedFiles: evictedFiles.slice(0, maxPaths),
    updatedAt: options.updatedAt ?? Date.now(),
  };
}

function collectLatestReadSignals(messages: MessageLike[]): Map<string, ReadSignal> {
  const out = new Map<string, ReadSignal>();
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    if (typeof message.content !== "string") continue;
    const envelope = parseReadSnapshotEnvelope(message.content);
    if (!envelope) continue;

    const path = normalizePath(envelope.canonical_path ?? envelope.path);
    if (!path) continue;
    const content = typeof envelope.content === "string" ? envelope.content : undefined;

    out.set(path, {
      path,
      status: envelope.status,
      reason: envelope.reason,
      detail: envelope.detail,
      hasContent: Boolean(content && content.length > 0),
      content,
      contentHash: envelope.content_hash,
      snapshotId: envelope.snapshot_id,
      returnedRange: envelope.returned_range ?? envelope.line_range,
    });
  }
  return out;
}

function resolveSourceSemantics(
  record: FileSnapshotRecord | undefined,
  signal: ReadSignal | undefined,
): FileStateSourceSemantics {
  if (signal) {
    if (signal.status === "ok/full_content") {
      return {
        signal: "full_content",
        envelopeStatus: signal.status,
        reason: signal.reason,
        detail: signal.detail,
      };
    }
    if (signal.status === "ok/replayed_snapshot") {
      return {
        signal: isMetaReplayReason(signal.reason) ? "meta_hint_replay" : "replayed_snapshot",
        envelopeStatus: signal.status,
        reason: signal.reason,
        detail: signal.detail,
      };
    }
    if (signal.status === "needs_targeted_read") {
      return {
        signal: "targeted_read_required",
        envelopeStatus: signal.status,
        reason: signal.reason,
        detail: signal.detail,
      };
    }
    return {
      signal: "snapshot_evicted",
      envelopeStatus: signal.status,
      reason: signal.reason,
      detail: signal.detail,
    };
  }

  if (record?.source === "replay") {
    return { signal: "replayed_snapshot", envelopeStatus: "none" };
  }
  if (record) {
    return { signal: "full_content", envelopeStatus: "none" };
  }
  return { signal: "none", envelopeStatus: "none" };
}

function isMetaReplayReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason === "unchanged_hint"
    || reason === "already_read_hint"
    || reason === "already_loaded_hint"
    || reason === "in_memory_hint"
    || reason === "dedup_replay"
    || reason === "snapshot_replayed_after_turn_boundary";
}

function normalizePath(rawPath: string | undefined): string {
  const value = typeof rawPath === "string" ? rawPath.trim().replace(/\\/g, "/") : "";
  return value;
}

function safeSourceSignal(value: unknown): FileStateSourceSemantics["signal"] {
  return typeof value === "string" && (FILE_STATE_SOURCE_SIGNALS as readonly string[]).includes(value)
    ? value as FileStateSourceSemantics["signal"]
    : "none";
}

function safeEnvelopeStatus(value: unknown): FileStateSourceSemantics["envelopeStatus"] {
  return typeof value === "string" && (FILE_STATE_ENVELOPE_STATUSES as readonly string[]).includes(value)
    ? value as FileStateSourceSemantics["envelopeStatus"]
    : "none";
}

function safeControlPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.length > 300) return "";
  if (!/^[A-Za-z0-9._~@/+:-]+$/.test(normalized)) return "";
  return normalized;
}

function safeControlToken(value: unknown, fallback: string, maxChars: number): string {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw
    .replace(/[\r\n\t;=<>"`]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
  return normalized || fallback;
}

function safeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
