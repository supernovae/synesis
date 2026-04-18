import {
  buildReadSnapshotEnvelope,
  FileSnapshotRegistry,
  guardedFallbackRead,
  isUnchangedHint,
  parseReadSnapshotEnvelope,
  type SnapshotLineRange,
} from "./file-snapshot-registry.js";

const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "file_read"]);
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "file"];

interface ToolCallReadMeta {
  toolName: string;
  filePath?: string;
  lineRange?: SnapshotLineRange;
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
    if (m.role !== "tool") {
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
      if ((existingEnvelope.status === "ok/full_content" || existingEnvelope.status === "ok/replayed_snapshot")
          && existingEnvelope.path && typeof existingEnvelope.content === "string") {
        registry.recordFullContent({
          rawPath: existingEnvelope.path,
          content: existingEnvelope.content,
          lineRange: existingEnvelope.line_range,
          source: existingEnvelope.source ?? "client_full_read",
          turnIndex: i,
          anchorDir: options.anchorDir,
        });
      }
      out.push(m);
      continue;
    }

    const meta = m.tool_call_id ? toolCallMeta.get(m.tool_call_id) : undefined;
    const parsed = parseReadPayload(raw);
    const targetPath = meta?.filePath || parsed.filePath || "";
    const lineRange = meta?.lineRange || parsed.lineRange;

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

    if (isUnchangedHint(raw)) {
      const snapshot = registry.getByPath(canonicalPath);
      // If the snapshot was recorded before the current user turn, the model's context
      // may have been reset (interrupt/restart). Replay the full content so the model
      // can actually use it rather than spinning on "unchanged" forever.
      const turnBoundary = options.lastUserPromptIdx ?? -1;
      const snapshotIsStale = snapshot !== null && snapshot.lastSeenTurn <= turnBoundary;
      // For full-file reads with a current, visible snapshot: return "unchanged" — the
      // model already has the content in context. Skip this for range reads (pages X-Y):
      // the model asked for a specific slice and can't find it from just "unchanged".
      const requestHasRange = lineRange != null;
      if (snapshot && snapshot.visibilityState === "ACTIVE_VISIBLE" && !snapshotIsStale && !requestHasRange) {
        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "ok/unchanged_snapshot_still_visible",
            path: snapshot.canonicalPath,
            snapshot_id: snapshot.snapshotId,
            content_hash: snapshot.contentHash,
            visibility: snapshot.visibilityState,
            line_range: lineRange ?? snapshot.lastLineRange,
          }),
        });
        normalizedCount += 1;
        continue;
      }
      if (snapshot && snapshot.lastFullContent) {
        // Replay the content — either snapshot is STALE (from a prior turn), the
        // request specifies a range, or the snapshot is not yet ACTIVE_VISIBLE.
        // Refresh lastSeenTurn so subsequent full-file reads in this same turn
        // correctly return "unchanged" rather than replaying again.
        // For range reads: extract the requested slice from the full content so the
        // model gets exactly the lines it asked for.
        const contentForRange = requestHasRange
          ? sliceSnapshotContent(snapshot.lastFullContent, lineRange)
          : snapshot.lastFullContent;
        const rangeToStore = requestHasRange
          ? (lineRange ?? snapshot.lastLineRange)
          : snapshot.lastLineRange;
        registry.recordFullContent({
          rawPath: snapshot.canonicalPath,
          content: snapshot.lastFullContent,  // always store full content in registry
          lineRange: rangeToStore,
          source: "replay",
          turnIndex: i,
          anchorDir: options.anchorDir,
        });
        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "ok/replayed_snapshot",
            path: snapshot.canonicalPath,
            snapshot_id: snapshot.snapshotId,
            content_hash: snapshot.contentHash,
            visibility: "ACTIVE_VISIBLE",
            source: "replay",
            line_range: lineRange ?? snapshot.lastLineRange,
            content: contentForRange,
          }),
        });
        normalizedCount += 1;
        replayedCount += 1;
        continue;
      }

      const fallback = await guardedFallbackRead(canonicalPath, {
        anchorDir: options.anchorDir,
        projectRoot: options.projectRoot,
        lineRange,
      });
      if (fallback.ok && typeof fallback.content === "string") {
        const rec = registry.recordFullContent({
          rawPath: canonicalPath,
          content: fallback.content,
          lineRange: fallback.lineRange,
          source: "forced_fs_read",
          turnIndex: i,
          anchorDir: options.anchorDir,
        });
        out.push({
          ...m,
          content: buildReadSnapshotEnvelope({
            kind: "synesis_file_read",
            status: "ok/full_content",
            path: rec?.canonicalPath || canonicalPath,
            snapshot_id: rec?.snapshotId,
            content_hash: rec?.contentHash,
            visibility: "ACTIVE_VISIBLE",
            source: "forced_fs_read",
            line_range: fallback.lineRange,
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
          reason: fallback.reason || "snapshot_evicted",
          detail: fallback.detail,
        }),
      });
      normalizedCount += 1;
      continue;
    }

    if (parsed.content !== null) {
      const rec = registry.recordFullContent({
        rawPath: canonicalPath,
        content: parsed.content,
        lineRange,
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
          snapshot_id: rec?.snapshotId,
          content_hash: rec?.contentHash,
          visibility: "ACTIVE_VISIBLE",
          source: "client_full_read",
          line_range: lineRange,
          content: parsed.content,
        }),
      });
      normalizedCount += 1;
      continue;
    }

    out.push(m);
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
        const lineRange = readLineRangeFromArgs(args);
        map.set(id, { toolName, filePath, lineRange });
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

function parseReadPayload(raw: string): { filePath: string | null; content: string | null; lineRange?: SnapshotLineRange } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { filePath: null, content: raw };
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
    const range = parsed.lineRange && typeof parsed.lineRange === "object"
      ? parsed.lineRange as Record<string, unknown>
      : null;
    const lineRange = range
      && Number.isFinite(Number(range.startLine))
      && Number.isFinite(Number(range.endLine))
      ? {
        startLine: Math.max(1, Math.trunc(Number(range.startLine))),
        endLine: Math.max(1, Math.trunc(Number(range.endLine))),
      }
      : undefined;
    return { filePath, content, lineRange };
  } catch {
    return { filePath: null, content: raw };
  }
}

/**
 * Extracts the lines covered by the given range from the full file content.
 * Line numbers are 1-based and inclusive. Falls back to the full content if
 * the range cannot be applied (e.g. startLine is beyond EOF).
 */
function sliceSnapshotContent(fullContent: string, range: SnapshotLineRange): string {
  const lines = fullContent.split("\n");
  const start = Math.max(1, range.startLine) - 1;  // 0-based
  const end = Math.min(lines.length, range.endLine);  // 0-based exclusive
  if (start >= lines.length) return fullContent;  // range beyond EOF → full content
  return lines.slice(start, end).join("\n");
}

