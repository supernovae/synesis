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
 * Five pruning strategies (applied in order):
 *   1. Duplicate command dedup       — keep only the latest result for repeated shell commands
 *   2. Duplicate file-read dedup     — keep only the latest read of each path
 *   3. Stale tool-result eviction    — summarize old tool results beyond the keep window
 *   4. Old assistant condensation    — trim large early assistant messages
 *   5. Near-duplicate output collapse — collapse tool results with identical content
 *
 * The keep window is determined by BOTH user-turn count and tool-result count.
 * In agent-loop sessions (one user message, many tool calls), the turn-based
 * window alone stays at 0 and pruning never fires.  The tool-result-count
 * fallback ensures pruning activates once tool results exceed keepToolResults.
 */

export interface TranscriptPruningConfig {
  enabled: boolean;
  /** Number of recent "user turns" whose tool results are kept at full fidelity. */
  keepTurns: number;
  /** Max recent tool results kept at full fidelity (fallback for single-turn agent loops). 0 disables. */
  keepToolResults: number;
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
  commandsDeduped: number;
  fileDeduped: number;
  toolResultsEvicted: number;
  assistantCondensed: number;
  nearDuplicatesCollapsed: number;
  charsBefore: number;
  charsAfter: number;
  totalCharsSaved: number;
}

interface MessageLike {
  role: string;
  name?: string;
  tool_call_id?: string;
  content: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

const FILE_OP_TOOLS = new Set([
  "read", "write", "edit", "update",
  "read_file", "write_file", "edit_file",
  "str_replace_editor",
]);

const SHELL_TOOLS = new Set([
  "bash", "run_command", "run_terminal_command", "execute_command",
  "shell", "terminal", "run_bash",
]);

const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file"];

export class TranscriptPruningService {
  private readonly stats: TranscriptPruningStats = {
    invocations: 0,
    skippedUnderBudget: 0,
    commandsDeduped: 0,
    fileDeduped: 0,
    toolResultsEvicted: 0,
    assistantCondensed: 0,
    nearDuplicatesCollapsed: 0,
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

    const keepFromIndex = this.computeKeepFromIndex(messages);

    let out = this.deduplicateCommands(messages, keepFromIndex);
    out = this.deduplicateFileReads(out, keepFromIndex);
    out = this.evictStaleToolResults(out, keepFromIndex);
    out = this.condenseOldAssistant(out, keepFromIndex);
    out = this.collapseNearDuplicateOutputs(out, keepFromIndex);

    const afterChars = out.reduce(
      (sum, m) => sum + contentLength(m.content),
      0,
    );
    this.stats.charsAfter += afterChars;
    this.stats.totalCharsSaved += Math.max(0, totalChars - afterChars);
    return { messages: out, pruned: totalChars !== afterChars };
  }

  /**
   * Compute the message index from which we preserve full content.
   * Uses user-turn boundaries first, then falls back to tool-result count
   * for single-turn agent loops where the turn-based heuristic yields 0.
   */
  private computeKeepFromIndex(messages: MessageLike[]): number {
    const userTurnBoundaries = computeUserTurnBoundaries(messages);
    const turnBased = userTurnBoundaries.length > this.config.keepTurns
      ? userTurnBoundaries[userTurnBoundaries.length - this.config.keepTurns]
      : 0;

    if (turnBased > 0 || this.config.keepToolResults <= 0) return turnBased;

    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") toolIndices.push(i);
    }
    if (toolIndices.length <= this.config.keepToolResults) return 0;
    return toolIndices[toolIndices.length - this.config.keepToolResults];
  }

  /**
   * Strategy 1: If the same shell command was run multiple times, keep only
   * the latest result.  Earlier results for the same command become a stub.
   */
  private deduplicateCommands(
    messages: MessageLike[],
    keepFromIndex: number,
  ): MessageLike[] {
    const cmdMap = extractToolCallCommands(messages);
    if (cmdMap.size === 0) return messages;

    const latestByCommand = new Map<string, number>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool" || !m.tool_call_id) continue;
      const cmd = cmdMap.get(m.tool_call_id);
      if (!cmd) continue;
      if (!latestByCommand.has(cmd)) latestByCommand.set(cmd, i);
    }

    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (m.role !== "tool" || !m.tool_call_id) return m;
      const cmd = cmdMap.get(m.tool_call_id);
      if (!cmd) return m;
      const latest = latestByCommand.get(cmd);
      if (latest === undefined || latest === i) return m;
      this.stats.commandsDeduped += 1;
      const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      return {
        ...m,
        content: `<DUPLICATE_CMD_SUPERSEDED cmd="${shortCmd}" latest_at_msg=${latest} />`,
      };
    });
  }

  /**
   * Strategy 2: If the same file was read multiple times, keep only the
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
   * Strategy 3: Tool results before the keep window get replaced with a
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
      if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<DUPLICATE_CMD_SUPERSEDED")) return m;
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
   * Strategy 4: Large assistant messages before the keep window are trimmed
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

  /**
   * Strategy 5: Tool results with identical or near-identical content get
   * collapsed to a reference pointing at the latest occurrence.  Catches
   * repeated builds/tests that produce the same output even when the command
   * strings differ slightly (e.g. `go test ./...` vs `go test -v ./...`).
   */
  private collapseNearDuplicateOutputs(
    messages: MessageLike[],
    keepFromIndex: number,
  ): MessageLike[] {
    const fingerprintToLatest = new Map<string, number>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool") continue;
      const raw = contentString(m.content);
      if (raw.length < 200) continue;
      if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<DUPLICATE_CMD_SUPERSEDED")
        || raw.startsWith("<TOOL_RESULT_PRUNED") || raw.startsWith("<NEAR_DUPLICATE_OUTPUT")) continue;
      const fp = contentFingerprint(raw);
      if (!fingerprintToLatest.has(fp)) fingerprintToLatest.set(fp, i);
    }

    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (m.role !== "tool") return m;
      const raw = contentString(m.content);
      if (raw.length < 200) return m;
      if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<DUPLICATE_CMD_SUPERSEDED")
        || raw.startsWith("<TOOL_RESULT_PRUNED") || raw.startsWith("<NEAR_DUPLICATE_OUTPUT")) return m;
      const fp = contentFingerprint(raw);
      const latest = fingerprintToLatest.get(fp);
      if (latest === undefined || latest === i) return m;
      this.stats.nearDuplicatesCollapsed += 1;
      return {
        ...m,
        content: `<NEAR_DUPLICATE_OUTPUT tool="${m.name ?? "unknown"}" chars="${raw.length}" same_as_msg=${latest} />`,
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

/**
 * Build a map from tool_call_id → shell command string by scanning assistant
 * messages for tool_calls that invoke shell-like tools.
 */
function extractToolCallCommands(messages: MessageLike[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (!tc.id || !tc.function?.arguments) continue;
      const name = (tc.function.name ?? "").toLowerCase();
      if (!SHELL_TOOLS.has(name)) continue;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        const cmd = String(args.command ?? args.cmd ?? args.input ?? "").trim();
        if (cmd) map.set(tc.id, cmd);
      } catch { /* not parseable */ }
    }
  }
  return map;
}

/**
 * Produce a short fingerprint for content comparison.  Uses sampled lines so
 * that outputs differing only in timestamps or run counts still match.
 */
function contentFingerprint(raw: string): string {
  const lines = raw.split("\n");
  const sampled: string[] = [];
  const step = Math.max(1, Math.floor(lines.length / 20));
  for (let i = 0; i < lines.length; i += step) {
    sampled.push(lines[i].trim().replace(/\d+/g, "#").replace(/\s+/g, " "));
  }
  return sampled.join("\n");
}
