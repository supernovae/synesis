import { looksLikeVerificationFailureOutput } from "../context/compaction-sensitivity.js";
import { normalizeCommandOutputForComparison } from "./output-normalization.js";
import type { ArtifactStore } from "../state/artifact-store.js";
import { isUnchangedHint, parseReadSnapshotEnvelope } from "./file-snapshot-registry.js";
import { inferCompactionSensitivity, type CompactionSensitivity } from "../context/compaction-sensitivity.js";

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
  /** Store pruned/superseded bytes in ArtifactStore when a store is configured (see README invariants H2). */
  artifactRetentionEnabled?: boolean;
}

/** Per-request delta for harness telemetry. */
export interface TranscriptPruningInvocationDelta {
  commandsDeduped: number;
  fileDeduped: number;
  toolResultsEvicted: number;
  assistantCondensed: number;
  nearDuplicatesCollapsed: number;
  artifactsStored: number;
}

export interface TranscriptPruningStats {
  invocations: number;
  skippedUnderBudget: number;
  commandsDeduped: number;
  fileDeduped: number;
  toolResultsEvicted: number;
  assistantCondensed: number;
  nearDuplicatesCollapsed: number;
  artifactsStored: number;
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

const READ_OP_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "file_read",
  "str_replace_editor",
]);

const SHELL_TOOLS = new Set([
  "bash", "run_command", "run_terminal_command", "execute_command",
  "shell", "terminal", "run_bash",
]);

const ACTIVE_READ_LITERAL_PRESERVE_CAP = 120_000;

function isShellLikeToolName(name: string | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  return SHELL_TOOLS.has(n) || n.includes("bash") || n.includes("shell") || n.includes("terminal");
}

function isReadLikeToolName(name: string | undefined): boolean {
  return READ_OP_TOOLS.has((name ?? "").trim().toLowerCase());
}

/** Indices of recent failing shell/test tool bodies — never stub-evict these (safe literal context). */
function protectedFailingVerificationToolIndices(messages: MessageLike[]): Set<number> {
  const failIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") continue;
    const raw = contentString(messages[i].content);
    if (raw.length < 80) continue;
    if (!isShellLikeToolName(messages[i].name)) continue;
    if (!looksLikeVerificationFailureOutput(raw)) continue;
    failIdx.push(i);
  }
  return new Set(failIdx.slice(-3));
}

function hasReplayableReadContent(content: unknown): boolean {
  const raw = contentString(content);
  if (!raw) return false;
  if (isUnchangedHint(raw)) return false;
  if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<TOOL_RESULT_PRUNED")) return false;
  const envelope = parseReadSnapshotEnvelope(raw);
  if (envelope) {
    return typeof envelope.content === "string" && envelope.content.length > 0;
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const body = parsed.content ?? parsed.text;
      if (typeof body === "string" && body.length > 0) return true;
    } catch {
      return raw.length > 120;
    }
  }
  return raw.length > 120;
}

/**
 * Preserve a bounded set of current-turn read literals so keepToolResults fallback
 * cannot evict code the model just read in the active user turn.
 */
function protectedCurrentTurnReadToolIndices(
  messages: MessageLike[],
  maxChars = ACTIVE_READ_LITERAL_PRESERVE_CAP,
): Set<number> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return new Set();
  const protectedIdx: number[] = [];
  let retainedChars = 0;
  for (let i = messages.length - 1; i > lastUserIdx; i -= 1) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    if (!isReadLikeToolName(m.name)) continue;
    if (!hasReplayableReadContent(m.content)) continue;
    const raw = contentString(m.content);
    if (protectedIdx.length === 0 || retainedChars + raw.length <= maxChars) {
      protectedIdx.push(i);
      retainedChars += raw.length;
    }
  }
  return new Set(protectedIdx);
}

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
    artifactsStored: 0,
    charsBefore: 0,
    charsAfter: 0,
    totalCharsSaved: 0,
  };

  constructor(
    private readonly config: TranscriptPruningConfig,
    private readonly artifactStore?: ArtifactStore | null,
  ) {}

  private artifactRetentionOn(): boolean {
    return Boolean(this.artifactStore && this.config.artifactRetentionEnabled !== false);
  }

  /** Store raw tool bytes and return artifact id for stub embedding (H2). */
  private retainPayload(raw: string): string | undefined {
    if (!this.artifactRetentionOn() || raw.length === 0) return undefined;
    try {
      const id = this.artifactStore!.putToolResult(raw).id;
      this.stats.artifactsStored += 1;
      return id;
    } catch {
      return undefined;
    }
  }

  /**
   * Compute effective budget, optionally scaled down for small projects.
   * For projects < 500KB source, use min(configured, 2x project size) so
   * pruning fires earlier and avoids carrying 30K+ tokens of stale context
   * for a 160KB codebase.
   */
  effectiveBudget(projectSizeChars?: number, sensitivity: CompactionSensitivity = "default"): number {
    const baseBudget = this.effectiveTranscriptBudgetForSensitivity(sensitivity);
    if (!projectSizeChars || projectSizeChars <= 0) return baseBudget;
    const floor = sensitivity === "strict_literals" ? 90_000 : (sensitivity === "qwen_coder" ? 75_000 : 60_000);
    const scaled = projectSizeChars * 3;
    return Math.min(baseBudget, Math.max(scaled, floor));
  }

  prune(
    messages: MessageLike[],
    projectSizeChars?: number,
    backendModelHint?: string,
  ): { messages: MessageLike[]; pruned: boolean; invocationDelta: TranscriptPruningInvocationDelta } {
    const delta0 = this.captureDeltaSnapshot();
    this.stats.invocations += 1;
    const zeroDelta = (): TranscriptPruningInvocationDelta => ({
      commandsDeduped: 0,
      fileDeduped: 0,
      toolResultsEvicted: 0,
      assistantCondensed: 0,
      nearDuplicatesCollapsed: 0,
      artifactsStored: 0,
    });
    if (!this.config.enabled) {
      return { messages, pruned: false, invocationDelta: zeroDelta() };
    }

    const sensitivity = inferCompactionSensitivity(backendModelHint ?? "");
    const budget = this.effectiveBudget(projectSizeChars, sensitivity);
    const totalChars = messages.reduce(
      (sum, m) => sum + contentLength(m.content),
      0,
    );
    this.stats.charsBefore += totalChars;

    if (totalChars <= budget) {
      this.stats.skippedUnderBudget += 1;
      this.stats.charsAfter += totalChars;
      return { messages, pruned: false, invocationDelta: this.diffDelta(delta0) };
    }

    const keepFromIndex = this.computeKeepFromIndex(messages, backendModelHint);

    const protectedFailIdx = protectedFailingVerificationToolIndices(messages);
    const protectedReadIdx = protectedCurrentTurnReadToolIndices(messages);
    const evictProtectedIdx = new Set<number>([...protectedFailIdx, ...protectedReadIdx]);
    let out = this.deduplicateCommands(messages, keepFromIndex);
    out = this.deduplicateFileReads(out, keepFromIndex, protectedReadIdx);
    out = this.evictStaleToolResults(out, keepFromIndex, evictProtectedIdx);
    out = this.condenseOldAssistant(out, keepFromIndex);
    out = this.collapseNearDuplicateOutputs(out, keepFromIndex, protectedReadIdx);

    const afterChars = out.reduce(
      (sum, m) => sum + contentLength(m.content),
      0,
    );
    this.stats.charsAfter += afterChars;
    this.stats.totalCharsSaved += Math.max(0, totalChars - afterChars);
    return { messages: out, pruned: totalChars !== afterChars, invocationDelta: this.diffDelta(delta0) };
  }

  private captureDeltaSnapshot(): TranscriptPruningInvocationDelta {
    return {
      commandsDeduped: this.stats.commandsDeduped,
      fileDeduped: this.stats.fileDeduped,
      toolResultsEvicted: this.stats.toolResultsEvicted,
      assistantCondensed: this.stats.assistantCondensed,
      nearDuplicatesCollapsed: this.stats.nearDuplicatesCollapsed,
      artifactsStored: this.stats.artifactsStored,
    };
  }

  private diffDelta(before: TranscriptPruningInvocationDelta): TranscriptPruningInvocationDelta {
    return {
      commandsDeduped: this.stats.commandsDeduped - before.commandsDeduped,
      fileDeduped: this.stats.fileDeduped - before.fileDeduped,
      toolResultsEvicted: this.stats.toolResultsEvicted - before.toolResultsEvicted,
      assistantCondensed: this.stats.assistantCondensed - before.assistantCondensed,
      nearDuplicatesCollapsed: this.stats.nearDuplicatesCollapsed - before.nearDuplicatesCollapsed,
      artifactsStored: this.stats.artifactsStored - before.artifactsStored,
    };
  }

  /**
   * Compute the message index from which we preserve full content.
   * Uses user-turn boundaries first, then falls back to tool-result count
   * for single-turn agent loops where the turn-based heuristic yields 0.
   *
   * Public so other normalization stages (historical normalizer, tool-ID
   * stabilizer) can use the same boundary for consistency.
   */
  computeKeepFromIndex(messages: MessageLike[], backendModelHint?: string): number {
    const sensitivity = inferCompactionSensitivity(backendModelHint ?? "");
    const keepToolResults = this.effectiveKeepToolResultsForSensitivity(sensitivity);
    const userTurnBoundaries = computeUserTurnBoundaries(messages);
    const turnBased = userTurnBoundaries.length > this.config.keepTurns
      ? userTurnBoundaries[userTurnBoundaries.length - this.config.keepTurns]
      : 0;

    if (turnBased > 0 || keepToolResults <= 0) return turnBased;

    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") toolIndices.push(i);
    }
    if (toolIndices.length <= keepToolResults) return 0;
    return toolIndices[toolIndices.length - keepToolResults];
  }

  private effectiveTranscriptBudgetForSensitivity(sensitivity: CompactionSensitivity): number {
    const base = this.config.budgetChars;
    if (sensitivity === "strict_literals") return Math.min(Math.max(base + 30_000, Math.floor(base * 1.5)), 180_000);
    if (sensitivity === "qwen_coder") return Math.min(Math.max(base + 15_000, Math.floor(base * 1.25)), 140_000);
    return base;
  }

  private effectiveKeepToolResultsForSensitivity(sensitivity: CompactionSensitivity): number {
    const base = this.config.keepToolResults;
    if (base <= 0) return base;
    if (sensitivity === "strict_literals") return Math.min(Math.max(base + 12, Math.ceil(base * 1.8)), 80);
    if (sensitivity === "qwen_coder") return Math.min(Math.max(base + 6, Math.ceil(base * 1.35)), 60);
    return base;
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
      const raw = contentString(m.content);
      const handle = this.retainPayload(raw);
      this.stats.commandsDeduped += 1;
      const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      const escCmd = escapeXmlAttr(shortCmd);
      const handleAttr = handle
        ? ` artifact_handle="${escapeXmlAttr(handle)}" recovery="synesis_artifact_retrieve"`
        : "";
      return {
        ...m,
        content: `<DUPLICATE_CMD_SUPERSEDED cmd="${escCmd}" latest_at_msg=${latest}${handleAttr} />`,
      };
    });
  }

  /**
   * Strategy 2: If the same file was read multiple times, keep only the
   * latest read.  Earlier reads become a one-line stub.
   *
   * This applies GLOBALLY (including the recent window) when file content
   * is identical, and only outside the keep window for modified files.
   */
  private deduplicateFileReads(
    messages: MessageLike[],
    keepFromIndex: number,
    protectedIndices: Set<number>,
  ): MessageLike[] {
    const latestReadIndex = new Map<string, number>();
    const contentByIndex = new Map<number, string>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool" || !isFileOp(m.name)) continue;
      const fp = extractFilePath(m.content);
      if (!fp) continue;
      contentByIndex.set(i, contentString(m.content));
      if (!latestReadIndex.has(fp)) {
        latestReadIndex.set(fp, i);
      }
    }

    return messages.map((m, i) => {
      if (m.role !== "tool" || !isFileOp(m.name)) return m;
      if (protectedIndices.has(i)) return m;
      const fp = extractFilePath(m.content);
      if (!fp) return m;
      if (isPlanFilePath(fp)) return m;
      const latest = latestReadIndex.get(fp);
      if (latest === undefined || latest === i) return m;

      if (i >= keepFromIndex) {
        const currentContent = contentByIndex.get(i) ?? "";
        const latestContent = contentByIndex.get(latest) ?? "";
        if (currentContent.length < 200 || currentContent !== latestContent) return m;
      }

      const raw = contentString(m.content);
      const handle = this.retainPayload(raw);
      this.stats.fileDeduped += 1;
      const pathEsc = escapeXmlAttr(fp);
      const handleAttr = handle
        ? ` artifact_handle="${escapeXmlAttr(handle)}" recovery="synesis_artifact_retrieve"`
        : "";
      return {
        ...m,
        content: `<FILE_SUPERSEDED path="${pathEsc}" latest_at_msg=${latest}${handleAttr} />`,
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
    protectedIndices: Set<number>,
  ): MessageLike[] {
    return messages.map((m, i) => {
      if (i >= keepFromIndex) return m;
      if (protectedIndices.has(i)) return m;
      if (m.role !== "tool") return m;
      const raw = contentString(m.content);
      if (raw.length <= this.config.stubMaxChars) return m;
      if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<DUPLICATE_CMD_SUPERSEDED")) return m;
      const evictPath = isFileOp(m.name) ? extractFilePath(m.content) : null;
      if (evictPath && isPlanFilePath(evictPath)) return m;
      const handle = this.retainPayload(raw);
      this.stats.toolResultsEvicted += 1;
      const lines = raw.split("\n").length;
      const preview = raw.slice(0, 120).replace(/\n/g, " ");
      const toolEsc = escapeXmlAttr(m.name ?? "unknown");
      const handleAttr = handle
        ? ` artifact_handle="${escapeXmlAttr(handle)}" recovery="synesis_artifact_retrieve"`
        : "";
      return {
        ...m,
        content:
          `<TOOL_RESULT_PRUNED tool="${toolEsc}" chars="${raw.length}" lines="${lines}"${handleAttr}>\n`
          + `${preview}...\n`
          + "Recover full output via synesis_artifact_retrieve with artifact_handle when present.\n"
          + "</TOOL_RESULT_PRUNED>",
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
    protectedIndices: Set<number>,
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
      if (m.role !== "tool") return m;
      if (protectedIndices.has(i)) return m;
      const raw = contentString(m.content);
      if (raw.length < 200) return m;
      if (raw.startsWith("<FILE_SUPERSEDED") || raw.startsWith("<DUPLICATE_CMD_SUPERSEDED")
        || raw.startsWith("<TOOL_RESULT_PRUNED") || raw.startsWith("<NEAR_DUPLICATE_OUTPUT")) return m;
      const collapsePath = isFileOp(m.name) ? extractFilePath(m.content) : null;
      if (collapsePath && isPlanFilePath(collapsePath)) return m;
      const fp = contentFingerprint(raw);
      const latest = fingerprintToLatest.get(fp);
      if (latest === undefined || latest === i) return m;
      const rawLatest = contentString(messages[latest].content);
      const failI = looksLikeVerificationFailureOutput(raw);
      const failLatest = looksLikeVerificationFailureOutput(rawLatest);
      if (failI !== failLatest) return m;
      const handle = this.retainPayload(raw);
      this.stats.nearDuplicatesCollapsed += 1;
      const toolEsc = escapeXmlAttr(m.name ?? "unknown");
      const handleAttr = handle
        ? ` artifact_handle="${escapeXmlAttr(handle)}" recovery="synesis_artifact_retrieve"`
        : "";
      return {
        ...m,
        content: `<NEAR_DUPLICATE_OUTPUT tool="${toolEsc}" chars="${raw.length}" same_as_msg=${latest}${handleAttr} />`,
      };
    });
  }

  /**
   * Emergency pruning for context admission warnings.
   *
   * Unlike normal `prune()` which respects a generous keep window, this method
   * uses a minimal keep window and applies all strategies aggressively to get
   * the total context chars under `targetCharBudget`.
   *
   * In `"minimal"` compaction mode, wider keep windows are used (8/4 tool
   * results) to preserve more recent context and reduce turn loss.  In
   * `"aggressive"` mode the original tight windows (4/2) are used.
   */
  emergencyPrune(
    messages: MessageLike[],
    targetCharBudget: number,
    backendModelHint?: string,
    compactionMode: "minimal" | "aggressive" = "minimal",
  ): { messages: MessageLike[]; pruned: boolean; charsBefore: number; charsAfter: number } {
    const charsBefore = messages.reduce((sum, m) => sum + contentLength(m.content), 0);
    if (charsBefore <= targetCharBudget) {
      return { messages, pruned: false, charsBefore, charsAfter: charsBefore };
    }

    const protectedFailIdx = protectedFailingVerificationToolIndices(messages);
    const protectedReadIdx = protectedCurrentTurnReadToolIndices(messages);
    const evictProtectedIdx = new Set<number>([...protectedFailIdx, ...protectedReadIdx]);

    const firstPassKeep = compactionMode === "minimal" ? 8 : 4;
    const secondPassKeep = compactionMode === "minimal" ? 4 : 2;

    const emergencyKeep = this.computeEmergencyKeepFromIndex(messages, firstPassKeep);
    let out = this.deduplicateCommands(messages, emergencyKeep);
    out = this.deduplicateFileReads(out, emergencyKeep, protectedReadIdx);
    out = this.evictStaleToolResults(out, emergencyKeep, evictProtectedIdx);
    out = this.condenseOldAssistant(out, emergencyKeep);
    out = this.collapseNearDuplicateOutputs(out, emergencyKeep, protectedReadIdx);

    let charsAfter = out.reduce((sum, m) => sum + contentLength(m.content), 0);
    if (charsAfter > targetCharBudget) {
      const tinyKeep = this.computeEmergencyKeepFromIndex(out, secondPassKeep);
      out = this.evictStaleToolResults(out, tinyKeep, evictProtectedIdx);
      out = this.condenseOldAssistant(out, tinyKeep);
      charsAfter = out.reduce((sum, m) => sum + contentLength(m.content), 0);
    }

    this.stats.totalCharsSaved += Math.max(0, charsBefore - charsAfter);
    return { messages: out, pruned: charsBefore !== charsAfter, charsBefore, charsAfter };
  }

  private computeEmergencyKeepFromIndex(messages: MessageLike[], keepCount: number): number {
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") toolIndices.push(i);
    }
    if (toolIndices.length <= keepCount) return 0;
    return toolIndices[toolIndices.length - keepCount];
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

function isPlanFilePath(path: string): boolean {
  return path.includes("/.claude/plans/") || path.includes("\\.claude\\plans\\");
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
  const normalized = normalizeCommandOutputForComparison(raw);
  const lines = normalized.split("\n");
  const sampled: string[] = [];
  const step = Math.max(1, Math.floor(lines.length / 20));
  for (let i = 0; i < lines.length; i += step) {
    sampled.push(lines[i].trim().replace(/\d+/g, "#").replace(/\s+/g, " "));
  }
  return sampled.join("\n");
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
