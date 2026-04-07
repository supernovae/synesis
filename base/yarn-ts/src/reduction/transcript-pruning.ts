/**
 * Transcript Pruning Service
 *
 * Reduces total context sent to the LLM by evicting stale content from old
 * conversation turns while preserving enough metadata for the model to know
 * what happened.
 *
 * The client (Cursor / Claude Code) sends the FULL message history on every
 * request.  Without pruning, a 40-turn coding session accumulates O(n²) tokens
 * because every past tool result and assistant response is re-sent.
 *
 * This service operates on the messages array *after* tool-result reduction
 * and validation normalization but *before* system enrichment, so it only
 * touches content the model has already seen in prior turns.
 *
 * Three pruning strategies (applied in order):
 *   1. Duplicate file-read dedup   — keep only the latest read of each path
 *   2. Stale tool-result eviction  — summarize old tool results beyond the keep window
 *   3. Old assistant condensation  — trim large early assistant messages
 */

export interface TranscriptPruningConfig {
  enabled: boolean;
  /** Number of recent "user turns" whose tool results are kept at full fidelity. */
  keepTurns: number;
  /** Total chars budget; pruning only fires when the transcript exceeds this. */
  budgetChars: number;
  /** Max chars for a pruned tool-result stub. */
  stubMaxChars: number;
  /** Max chars for a condensed old assistant message. */
  assistantCondenseChars: number;
}

export interface TranscriptPruningStats {
  invocations: number;
  skippedUnderBudget: number;
  fileDeduped: number;
  toolResultsEvicted: number;
  assistantCondensed: number;
  charsBefore: number;
  charsAfter: number;
  totalCharsSaved: number;
}

interface MessageLike {
  role: string;
  name?: string;
  tool_call_id?: string;
  content: unknown;
}

const FILE_OP_TOOLS = new Set([
  "read", "write", "edit", "update",
  "read_file", "write_file", "edit_file",
  "str_replace_editor",
]);

const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file"];

export class TranscriptPruningService {
  private readonly stats: TranscriptPruningStats = {
    invocations: 0,
    skippedUnderBudget: 0,
    fileDeduped: 0,
    toolResultsEvicted: 0,
    assistantCondensed: 0,
    charsBefore: 0,
    charsAfter: 0,
    totalCharsSaved: 0,
  };

  constructor(private readonly config: TranscriptPruningConfig) {}

  prune(messages: MessageLike[]): { messages: MessageLike[]; pruned: boolean } {
    this.stats.invocations += 1;
    if (!this.config.enabled) {
      return { messages, pruned: false };
    }

    const totalChars = messages.reduce(
      (sum, m) => sum + contentLength(m.content),
      0,
    );
    this.stats.charsBefore += totalChars;

    if (totalChars <= this.config.budgetChars) {
      this.stats.skippedUnderBudget += 1;
      this.stats.charsAfter += totalChars;
      return { messages, pruned: false };
    }

    const userTurnBoundaries = computeUserTurnBoundaries(messages);
    const keepFromIndex = userTurnBoundaries.length > this.config.keepTurns
      ? userTurnBoundaries[userTurnBoundaries.length - this.config.keepTurns]
      : 0;

    let out = this.deduplicateFileReads(messages, keepFromIndex);
    out = this.evictStaleToolResults(out, keepFromIndex);
    out = this.condenseOldAssistant(out, keepFromIndex);

    const afterChars = out.reduce(
      (sum, m) => sum + contentLength(m.content),
      0,
    );
    this.stats.charsAfter += afterChars;
    this.stats.totalCharsSaved += Math.max(0, totalChars - afterChars);
    return { messages: out, pruned: totalChars !== afterChars };
  }

  /**
   * Strategy 1: If the same file was read multiple times, keep only the
   * latest read.  Earlier reads become a one-line stub.
   */
  private deduplicateFileReads(
    messages: MessageLike[],
    keepFromIndex: number,
  ): MessageLike[] {
    const latestReadIndex = new Map<string, number>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool" || !isFileOp(m.name)) continue;
      const fp = extractFilePath(m.content);
      if (!fp) continue;
      if (!latestReadIndex.has(fp)) {
        latestReadIndex.set(fp, i);
      }
    }

    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (m.role !== "tool" || !isFileOp(m.name)) return m;
      const fp = extractFilePath(m.content);
      if (!fp) return m;
      const latest = latestReadIndex.get(fp);
      if (latest === undefined || latest === i) return m;
      this.stats.fileDeduped += 1;
      return {
        ...m,
        content: `<FILE_SUPERSEDED path="${fp}" latest_at_msg=${latest} />`,
      };
    });
  }

  /**
   * Strategy 2: Tool results before the keep window get replaced with a
   * compact metadata stub (tool name, content size, preview).
   */
  private evictStaleToolResults(
    messages: MessageLike[],
    keepFromIndex: number,
  ): MessageLike[] {
    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (m.role !== "tool") return m;
      const raw = contentString(m.content);
      if (raw.length <= this.config.stubMaxChars) return m;
      if (raw.startsWith("<FILE_SUPERSEDED")) return m;
      this.stats.toolResultsEvicted += 1;
      const lines = raw.split("\n").length;
      const preview = raw.slice(0, 120).replace(/\n/g, " ");
      return {
        ...m,
        content: `<TOOL_RESULT_PRUNED tool="${m.name ?? "unknown"}" chars="${raw.length}" lines="${lines}">\n${preview}...\n</TOOL_RESULT_PRUNED>`,
      };
    });
  }

  /**
   * Strategy 3: Large assistant messages before the keep window are trimmed
   * to a reasonable summary length.
   */
  private condenseOldAssistant(
    messages: MessageLike[],
    keepFromIndex: number,
  ): MessageLike[] {
    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (m.role !== "assistant") return m;
      const raw = contentString(m.content);
      if (raw.length <= this.config.assistantCondenseChars) return m;
      this.stats.assistantCondensed += 1;
      const head = raw.slice(0, this.config.assistantCondenseChars);
      const lastNewline = head.lastIndexOf("\n");
      const clean = lastNewline > 0 ? head.slice(0, lastNewline) : head;
      return {
        ...m,
        content: `${clean}\n\n[... ${raw.length - clean.length} chars condensed from earlier turn ...]`,
      };
    });
  }

  getStats(): TranscriptPruningStats {
    return { ...this.stats };
  }

  getPerRequestSavedChars(): number {
    if (this.stats.invocations === 0) return 0;
    return this.stats.totalCharsSaved;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  try { return JSON.stringify(content ?? "").length; } catch { return 0; }
}

function contentString(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content ?? ""); } catch { return String(content); }
}

function isFileOp(toolName: string | undefined): boolean {
  return FILE_OP_TOOLS.has((toolName ?? "").toLowerCase());
}

function extractFilePath(content: unknown): string | null {
  const raw = contentString(content);

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const key of FILE_PATH_KEYS) {
        if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
      }
    } catch { /* not JSON */ }
  }

  const match = raw.match(/(?:filePath|file_path|path)\s*[:=]\s*"?([^\s"',}{]+)/i);
  return match?.[1] ?? null;
}

/**
 * Find the message indices where each "user turn" starts.
 * A user turn begins at each `role: "user"` message.
 */
function computeUserTurnBoundaries(messages: MessageLike[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") boundaries.push(i);
  }
  return boundaries;
}
