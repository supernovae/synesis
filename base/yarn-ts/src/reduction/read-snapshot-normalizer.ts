import {
  buildReadSnapshotEnvelope,
  FileSnapshotRegistry,
  guardedFallbackRead,
  guardedVersionProbe,
  isFilesystemVersionStale,
  isUnchangedHint,
  normalizeLineRange,
  parseReadSnapshotEnvelope,
  rangesEqual,
  type SnapshotCompleteness,
  type SnapshotFilesystemVersion,
  type SnapshotLineRange,
} from "./file-snapshot-registry.js";

const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "file_read"]);
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "file"];

interface ToolCallReadMeta {
  toolName: string;
  filePath?: string;
  requestedRange?: SnapshotLineRange;
}

type MessageLike = {
  role: string;
  name?: string;
  tool_call_id?: string;
  content: unknown;
  tool_calls?: unknown;
};

export interface ReadSnapshotNormalizationOptions {
  projectRoot?: string | null;
  anchorDir?: string | null;
  /**
   * The message index of the last genuine human turn (not a tool-result user message).
   * When provided, any snapshot whose lastSeenTurn is <= this index is treated as
   * stale from the current turn's perspective: if the model explicitly reads the file
   * again we replay the full content instead of returning "unchanged_snapshot_still_visible".
   * This prevents the model from getting stuck after an interrupt/restart where the
   * snapshot exists from the previous sub-session but the model's context was cleared.
   */
  lastUserPromptIdx?: number;
}

export interface ReadSnapshotNormalizationResult {
  messages: MessageLike[];
  normalizedCount: number;
  replayedCount: number;
  fallbackCount: number;
}

export async function normalizeReadSnapshotMessages(
  messages: MessageLike[],
  registry: FileSnapshotRegistry,
  options: ReadSnapshotNormalizationOptions,
): Promise<ReadSnapshotNormalizationResult> {
  const toolCallMeta = buildToolCallMeta(messages);
  let normalizedCount = 0;
  let replayedCount = 0;
  let fallbackCount = 0;
  const out: MessageLike[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool" && m.role !== "tool_result") {
      out.push(m);
      continue;
    }
    const toolName = String(m.name ?? "").toLowerCase();
    if (!READ_TOOL_NAMES.has(toolName)) {
      out.push(m);
      continue;
    }
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const existingEnvelope = parseReadSnapshotEnvelope(raw);
    if (existingEnvelope) {
      const envelopePath = existingEnvelope.canonical_path ?? existingEnvelope.path ?? "";
      const canonicalEnvelopePath = envelopePath
        ? registry.canonicalizePath(envelopePath, options.anchorDir)
        : "";
      const envelopeRequestedRange = normalizeLineRange(
        existingEnvelope.requested_range ?? existingEnvelope.line_range,
      );
      const envelopeReturnedRange = normalizeLineRange(
        existingEnvelope.returned_range ?? existingEnvelope.line_range ?? envelopeRequestedRange,
      );
      const envelopeCompleteness = inferReadCompleteness(
        existingEnvelope.completeness,
        envelopeRequestedRange,
        envelopeReturnedRange,
        false,
      );
      const hasEnvelopeContent = typeof existingEnvelope.content === "string" && existingEnvelope.content.length > 0;
      if (canonicalEnvelopePath && hasEnvelopeContent) {
        registry.recordFullContent({
          rawPath: canonicalEnvelopePath,
          content: existingEnvelope.content!,
          requestedRange: envelopeRequestedRange,
          returnedRange: envelopeReturnedRange,
          completeness: envelopeCompleteness,
          source: existingEnvelope.source ?? "client_full_read",
          turnIndex: i,
          anchorDir: options.anchorDir,
          fsVersion: existingEnvelope.version?.filesystem,
        });
      }
      if (existingEnvelope.status === "ok/unchanged_snapshot_still_visible" && !hasEnvelopeContent) {
        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "needs_targeted_read",
            path: canonicalEnvelopePath || existingEnvelope.path,
            canonical_path: canonicalEnvelopePath || existingEnvelope.canonical_path,
            snapshot_id: existingEnvelope.snapshot_id,
            content_hash: existingEnvelope.content_hash,
            requested_range: envelopeRequestedRange,
            returned_range: envelopeReturnedRange,
            line_range: envelopeReturnedRange,
            completeness: envelopeCompleteness,
            version: existingEnvelope.version,
            reason: "meta_read_missing_replay_content",
            detail: "existing_snapshot_envelope_had_no_content",
          }),
        });
        normalizedCount += 1;
        continue;
      }
      out.push({
        ...m,
        content: buildReadSnapshotEnvelope({
          ...existingEnvelope,
          path: canonicalEnvelopePath || existingEnvelope.path,
          canonical_path: canonicalEnvelopePath || existingEnvelope.canonical_path,
          requested_range: envelopeRequestedRange,
          returned_range: envelopeReturnedRange,
          line_range: envelopeReturnedRange,
          completeness: envelopeCompleteness,
        }),
      });
      continue;
    }

    const meta = m.tool_call_id ? toolCallMeta.get(m.tool_call_id) : undefined;
    const parsed = parseReadPayload(raw);
    const targetPath = meta?.filePath || parsed.filePath || "";
    const requestedRange = normalizeLineRange(meta?.requestedRange ?? parsed.requestedRange ?? parsed.lineRange);
    const returnedRangeHint = normalizeLineRange(parsed.returnedRange ?? parsed.lineRange ?? requestedRange);

    if (!targetPath) {
      out.push({
        ...m,
        content: buildReadSnapshotEnvelope({
          kind: "synesis_file_read",
          status: "needs_targeted_read",
          reason: "path_missing",
          detail: "read_result_missing_file_path",
        }),
      });
      normalizedCount += 1;
      continue;
    }

    const canonicalPath = registry.canonicalizePath(targetPath, options.anchorDir);

    const metaHint = classifyMetaReadHint(raw);
    if (metaHint !== null) {
      const snapshot = registry.getByPath(canonicalPath);
      const turnBoundary = options.lastUserPromptIdx ?? -1;
      const snapshotNeedsContextReplay = snapshot !== null && snapshot.lastSeenTurn <= turnBoundary;
      if (snapshot) {
        const snapshotVersionState = await detectSnapshotVersionState(
          snapshot.canonicalPath,
          snapshot.versionIdentity.filesystem,
          options,
        );
        if (snapshotVersionState === "stale") {
          registry.markEvicted(snapshot.canonicalPath, options.anchorDir);
          out.push({
            ...m,
            content: buildReadSnapshotEnvelope({
              kind: "synesis_file_read",
              status: "needs_targeted_read",
              path: canonicalPath,
              canonical_path: canonicalPath,
              snapshot_id: snapshot.snapshotId,
              content_hash: snapshot.contentHash,
              requested_range: requestedRange,
              returned_range: snapshot.returnedRange,
              line_range: snapshot.returnedRange,
              completeness: snapshot.completeness,
              version: snapshot.versionIdentity,
              reason: "stale_snapshot_version",
              detail: "cached_snapshot_version_mismatch",
            }),
          });
          normalizedCount += 1;
          continue;
        }

        const replayCandidate = selectReplayContent(snapshot, requestedRange);
        if (replayCandidate.content !== null) {
          const rec = registry.recordFullContent({
            rawPath: snapshot.canonicalPath,
            content: replayCandidate.recordContent,
            requestedRange,
            returnedRange: replayCandidate.returnedRange,
            completeness: replayCandidate.completeness,
            source: "replay",
            turnIndex: i,
            anchorDir: options.anchorDir,
            fsVersion: snapshot.versionIdentity.filesystem,
          });
          out.push({
            ...m,
            content: buildReadSnapshotEnvelope({
              kind: "synesis_file_read",
              status: "ok/replayed_snapshot",
              path: rec?.canonicalPath || canonicalPath,
              canonical_path: rec?.canonicalPath || canonicalPath,
              snapshot_id: rec?.snapshotId || snapshot.snapshotId,
              content_hash: rec?.contentHash || snapshot.contentHash,
              visibility: "ACTIVE_VISIBLE",
              source: "replay",
              requested_range: requestedRange,
              returned_range: replayCandidate.returnedRange,
              line_range: replayCandidate.returnedRange,
              completeness: replayCandidate.completeness,
              version: rec?.versionIdentity ?? snapshot.versionIdentity,
              reason: snapshotNeedsContextReplay ? "snapshot_replayed_after_turn_boundary" : metaHint,
              content: replayCandidate.content,
            }),
          });
          normalizedCount += 1;
          replayedCount += 1;
          continue;
        }

        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "needs_targeted_read",
            path: canonicalPath,
            canonical_path: canonicalPath,
            snapshot_id: snapshot.snapshotId,
            content_hash: snapshot.contentHash,
            requested_range: requestedRange,
            returned_range: snapshot.returnedRange,
            line_range: snapshot.returnedRange,
            completeness: snapshot.completeness,
            version: snapshot.versionIdentity,
            reason: replayCandidate.reason ?? "snapshot_not_replayable",
            detail: "meta_read_result_without_replayable_content",
          }),
        });
        normalizedCount += 1;
        continue;
      }

      const fallback = await guardedFallbackRead(canonicalPath, {
        anchorDir: options.anchorDir,
        projectRoot: options.projectRoot,
        lineRange: requestedRange,
      });
      if (fallback.ok && typeof fallback.content === "string") {
        const rec = registry.recordFullContent({
          rawPath: canonicalPath,
          content: fallback.content,
          requestedRange: fallback.requestedRange ?? requestedRange,
          returnedRange: fallback.returnedRange ?? fallback.lineRange ?? returnedRangeHint,
          completeness: fallback.completeness ?? inferReadCompleteness(undefined, requestedRange, fallback.returnedRange ?? fallback.lineRange, false),
          source: "forced_fs_read",
          turnIndex: i,
          anchorDir: options.anchorDir,
          fsVersion: fallback.fsVersion,
        });
        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "ok/full_content",
            path: rec?.canonicalPath || canonicalPath,
            canonical_path: rec?.canonicalPath || canonicalPath,
            snapshot_id: rec?.snapshotId,
            content_hash: rec?.contentHash,
            visibility: "ACTIVE_VISIBLE",
            source: "forced_fs_read",
            requested_range: fallback.requestedRange ?? requestedRange,
            returned_range: fallback.returnedRange ?? fallback.lineRange,
            line_range: fallback.returnedRange ?? fallback.lineRange,
            completeness: fallback.completeness ?? "full",
            version: rec?.versionIdentity ?? fallback.versionIdentity,
            reason: metaHint,
            content: fallback.content,
          }),
        });
        normalizedCount += 1;
        fallbackCount += 1;
        continue;
      }

      out.push({
        ...m,
        content: buildReadSnapshotEnvelope({
          kind: "synesis_file_read",
          status: fallback.reason === "outside_project_root" || fallback.reason === "path_not_absolute"
            ? "needs_targeted_read"
            : "failed/snapshot_evicted",
          path: canonicalPath,
          canonical_path: canonicalPath,
          requested_range: requestedRange,
          returned_range: returnedRangeHint,
          line_range: returnedRangeHint,
          completeness: inferReadCompleteness(undefined, requestedRange, returnedRangeHint, false),
          reason: fallback.reason || "snapshot_evicted",
          detail: fallback.detail,
        }),
      });
      normalizedCount += 1;
      continue;
    }

    if (parsed.content !== null) {
      const completeness = inferReadCompleteness(
        parsed.completeness,
        requestedRange,
        returnedRangeHint,
        parsed.truncated,
      );
      const rec = registry.recordFullContent({
        rawPath: canonicalPath,
        content: parsed.content,
        requestedRange,
        returnedRange: returnedRangeHint,
        completeness,
        fsVersion: parsed.fsVersion,
        source: "client_full_read",
        turnIndex: i,
        anchorDir: options.anchorDir,
      });
      out.push({
        ...m,
        content: buildReadSnapshotEnvelope({
          kind: "synesis_file_read",
          status: "ok/full_content",
          path: rec?.canonicalPath || canonicalPath,
          canonical_path: rec?.canonicalPath || canonicalPath,
          snapshot_id: rec?.snapshotId,
          content_hash: rec?.contentHash,
          visibility: "ACTIVE_VISIBLE",
          source: "client_full_read",
          requested_range: requestedRange,
          returned_range: returnedRangeHint,
          line_range: returnedRangeHint,
          completeness,
          version: rec?.versionIdentity,
          content: parsed.content,
        }),
      });
      normalizedCount += 1;
      continue;
    }

    out.push({
      ...m,
      content: buildReadSnapshotEnvelope({
        kind: "synesis_file_read",
        status: "needs_targeted_read",
        path: canonicalPath,
        canonical_path: canonicalPath,
        requested_range: requestedRange,
        returned_range: returnedRangeHint,
        line_range: returnedRangeHint,
        completeness: inferReadCompleteness(undefined, requestedRange, returnedRangeHint, false),
        reason: "read_result_missing_content",
        detail: "tool_result_contains_no_content_payload",
      }),
    });
    normalizedCount += 1;
  }

  return { messages: out, normalizedCount, replayedCount, fallbackCount };
}

function buildToolCallMeta(messages: MessageLike[]): Map<string, ToolCallReadMeta> {
  const map = new Map<string, ToolCallReadMeta>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = Array.isArray((m as Record<string, unknown>).tool_calls)
      ? ((m as Record<string, unknown>).tool_calls as unknown[])
      : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const row = tc as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : "";
      const fn = row.function && typeof row.function === "object" ? row.function as Record<string, unknown> : null;
      const toolName = typeof fn?.name === "string" ? fn.name : "";
      if (!id || !READ_TOOL_NAMES.has(toolName.toLowerCase())) continue;
      const argsRaw = typeof fn?.arguments === "string" ? fn.arguments : "";
      if (!argsRaw) continue;
      try {
        const args = JSON.parse(argsRaw) as Record<string, unknown>;
        const filePath = readPathFromArgs(args);
        const requestedRange = readLineRangeFromArgs(args);
        map.set(id, { toolName, filePath, requestedRange });
      } catch {
        continue;
      }
    }
  }
  return map;
}

function readPathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readLineRangeFromArgs(args: Record<string, unknown>): SnapshotLineRange | undefined {
  const start = typeof args.startLine === "number"
    ? args.startLine
    : (typeof args.start_line === "number" ? args.start_line : null);
  const lineRange = Array.isArray(args.line_range) ? args.line_range : null;
  if (lineRange && lineRange.length >= 2 && Number.isFinite(Number(lineRange[0])) && Number.isFinite(Number(lineRange[1]))) {
    const a = Math.max(1, Math.trunc(Number(lineRange[0])));
    const b = Math.max(a, Math.trunc(Number(lineRange[1])));
    return { startLine: a, endLine: b };
  }
  if (start !== null && Number.isFinite(Number(start))) {
    const s = Math.max(1, Math.trunc(Number(start)));
    return { startLine: s, endLine: s + 200 };
  }
  return undefined;
}

type ParsedReadPayload = {
  filePath: string | null;
  content: string | null;
  lineRange?: SnapshotLineRange;
  requestedRange?: SnapshotLineRange;
  returnedRange?: SnapshotLineRange;
  completeness?: SnapshotCompleteness;
  truncated: boolean;
  fsVersion?: SnapshotFilesystemVersion;
};

function parseReadPayload(raw: string): ParsedReadPayload {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return {
      filePath: null,
      content: raw,
      truncated: false,
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const filePath = typeof parsed.filePath === "string"
      ? parsed.filePath
      : (typeof parsed.file_path === "string"
        ? parsed.file_path
        : (typeof parsed.path === "string" ? parsed.path : null));
    const content = typeof parsed.content === "string"
      ? parsed.content
      : (typeof parsed.text === "string" ? parsed.text : null);
    const lineRange = normalizeLineRange(extractRange(parsed.lineRange));
    const requestedRange = normalizeLineRange(
      extractRange(parsed.requested_range)
      ?? extractRange(parsed.requestedRange)
      ?? extractRange(parsed.line_range)
      ?? lineRange,
    );
    const returnedRange = normalizeLineRange(
      extractRange(parsed.returned_range)
      ?? extractRange(parsed.returnedRange)
      ?? extractRange(parsed.line_range)
      ?? lineRange,
    );
    const completeness = normalizeCompleteness(parsed.completeness);
    const truncated = parsed.truncated === true || parsed.partial === true;
    const fsVersion = normalizeFilesystemVersion(
      parsed.version && typeof parsed.version === "object"
        ? (parsed.version as Record<string, unknown>).filesystem
        : parsed.filesystem,
    );
    return { filePath, content, lineRange, requestedRange, returnedRange, completeness, truncated, fsVersion };
  } catch {
    return {
      filePath: null,
      content: raw,
      truncated: false,
    };
  }
}

function sliceSnapshotContentWithRange(
  fullContent: string,
  requestedRange: SnapshotLineRange,
): { content: string; returnedRange: SnapshotLineRange } {
  const lines = fullContent.split("\n");
  const start = Math.max(1, requestedRange.startLine);
  const end = Math.max(start, requestedRange.endLine);
  const startIdx = start - 1;
  const boundedEnd = Math.min(end, lines.length);
  if (startIdx >= lines.length) {
    return {
      content: fullContent,
      returnedRange: { startLine: 1, endLine: lines.length },
    };
  }
  return {
    content: lines.slice(startIdx, boundedEnd).join("\n"),
    returnedRange: { startLine: start, endLine: boundedEnd },
  };
}

function extractRange(raw: unknown): SnapshotLineRange | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw) && raw.length >= 2) {
    if (!Number.isFinite(Number(raw[0])) || !Number.isFinite(Number(raw[1]))) return undefined;
    return normalizeLineRange({
      startLine: Number(raw[0]),
      endLine: Number(raw[1]),
    });
  }
  if (typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    const start = row.startLine ?? row.start_line;
    const end = row.endLine ?? row.end_line;
    if (!Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) return undefined;
    return normalizeLineRange({
      startLine: Number(start),
      endLine: Number(end),
    });
  }
  return undefined;
}

function normalizeCompleteness(raw: unknown): SnapshotCompleteness | undefined {
  if (typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "full") return "full";
  if (lowered === "partial") return "partial";
  return undefined;
}

function normalizeFilesystemVersion(raw: unknown): SnapshotFilesystemVersion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const mtimeMs = Number(row.mtimeMs ?? row.mtime_ms);
  const size = Number(row.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return undefined;
  const refreshedAtMs = Number(row.refreshedAtMs ?? row.refreshed_at_ms ?? Date.now());
  const ctimeMsRaw = Number(row.ctimeMs ?? row.ctime_ms);
  return {
    mtimeMs,
    size,
    ctimeMs: Number.isFinite(ctimeMsRaw) ? ctimeMsRaw : undefined,
    refreshedAtMs: Number.isFinite(refreshedAtMs) ? refreshedAtMs : Date.now(),
  };
}

function inferReadCompleteness(
  explicit: SnapshotCompleteness | undefined,
  requestedRange?: SnapshotLineRange,
  returnedRange?: SnapshotLineRange,
  truncated = false,
): SnapshotCompleteness {
  if (explicit === "full" || explicit === "partial") return explicit;
  if (truncated || requestedRange || returnedRange) return "partial";
  return "full";
}

function selectReplayContent(
  snapshot: ReturnType<FileSnapshotRegistry["getByPath"]>,
  requestedRange?: SnapshotLineRange,
): {
  content: string | null;
  recordContent: string;
  returnedRange?: SnapshotLineRange;
  completeness: SnapshotCompleteness;
  reason?: string;
} {
  if (!snapshot) {
    return {
      content: null,
      recordContent: "",
      completeness: "partial",
      reason: "snapshot_missing",
    };
  }
  if (requestedRange) {
    if (snapshot.lastFullContent) {
      const sliced = sliceSnapshotContentWithRange(snapshot.lastFullContent, requestedRange);
      return {
        content: sliced.content,
        recordContent: snapshot.lastFullContent,
        returnedRange: sliced.returnedRange,
        completeness: "partial",
      };
    }
    const cachedRange = snapshot.returnedRange ?? snapshot.requestedRange ?? snapshot.lastLineRange;
    if (snapshot.lastContent && rangesEqual(cachedRange, requestedRange)) {
      const normalizedCachedRange = normalizeLineRange(cachedRange);
      const normalizedReplay = normalizedCachedRange
        ? sliceSnapshotContentWithRange(snapshot.lastContent, normalizedCachedRange)
        : { content: snapshot.lastContent, returnedRange: normalizedCachedRange };
      return {
        content: normalizedReplay.content,
        recordContent: snapshot.lastContent,
        returnedRange: normalizedReplay.returnedRange,
        completeness: "partial",
      };
    }
    return {
      content: null,
      recordContent: "",
      returnedRange: normalizeLineRange(cachedRange),
      completeness: "partial",
      reason: "partial_snapshot_range_mismatch",
    };
  }
  if (snapshot.lastFullContent) {
    return {
      content: snapshot.lastFullContent,
      recordContent: snapshot.lastFullContent,
      returnedRange: snapshot.returnedRange,
      completeness: "full",
    };
  }
  return {
    content: null,
    recordContent: "",
    returnedRange: snapshot.returnedRange,
    completeness: snapshot.completeness,
    reason: "partial_snapshot_requires_range",
  };
}

async function detectSnapshotVersionState(
  canonicalPath: string,
  expectedFsVersion: SnapshotFilesystemVersion | undefined,
  options: ReadSnapshotNormalizationOptions,
): Promise<"fresh" | "stale" | "unknown"> {
  if (!expectedFsVersion) return "unknown";
  const probed = await guardedVersionProbe(canonicalPath, {
    anchorDir: options.anchorDir,
    projectRoot: options.projectRoot,
  });
  if (!probed.ok || !probed.version) return "unknown";
  return isFilesystemVersionStale(expectedFsVersion, probed.version) ? "stale" : "fresh";
}

type MetaReadHint =
  | "unchanged_hint"
  | "already_read_hint"
  | "already_loaded_hint"
  | "in_memory_hint";

function classifyMetaReadHint(raw: string): MetaReadHint | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text.includes("already in memory") || text.includes("in memory")) return "in_memory_hint";
  if (text.includes("already loaded")) return "already_loaded_hint";
  if (text.includes("already read") || text.includes("already in context")) return "already_read_hint";
  if (isUnchangedHint(text)) return "unchanged_hint";
  return null;
}

