/**
 * Content-Addressed File Deduplication
 *
 * Maintains a per-session hash map of file contents. When the same file is
 * read again with identical content, replaces the full content with a compact
 * reference stub, saving potentially thousands of tokens per repeated read.
 *
 * Also feeds file reads into an optional IncrementalStructuralIndex to build
 * a live repo map from observed tool results.
 *
 * Strategy:
 * 1. Hash each file read result by path + content
 * 2. First occurrence: pass through unchanged, record hash + turn index
 * 3. Subsequent identical reads: replace with `<FILE_UNCHANGED path="..." hash="..." first_seen_turn=N />`
 * 4. Changed reads (same path, different content): pass through, update hash
 */

import type { IncrementalStructuralIndex } from "../memory/incremental-index.js";

const READ_TOOL_NAMES = new Set([
  "read", "read_file", "readfile", "file_read",
  "str_replace_editor",
]);

const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file", "fileName", "file_name"];

interface FileEntry {
  hash: string;
  turnIndex: number;
  charCount: number;
  unchangedReadCount: number;
}

export interface ContentDedupStats {
  totalReads: number;
  deduplicatedReads: number;
  charsSaved: number;
}

export class ContentAddressedDedup {
  private fileMap = new Map<string, FileEntry>();
  private readonly stats: ContentDedupStats = {
    totalReads: 0,
    deduplicatedReads: 0,
    charsSaved: 0,
  };
  private contextWindowStart = 0;
  private readonly stalenessMargin: number;
  private structuralIndex: IncrementalStructuralIndex | null = null;

  constructor(stalenessMargin = 30) {
    this.stalenessMargin = stalenessMargin;
  }

  /** Attach a structural index builder to receive file contents on first read. */
  attachStructuralIndex(index: IncrementalStructuralIndex): void {
    this.structuralIndex = index;
  }

  getStructuralIndex(): IncrementalStructuralIndex | null {
    return this.structuralIndex;
  }

  /** Inform the dedup of the current context window start index (after compaction). */
  setContextWindowStart(turnIndex: number): void {
    this.contextWindowStart = turnIndex;
  }

  /**
   * Process a tool result message. Returns the original content if unique,
   * or a compact stub if the file was already seen with identical content.
   * Plan files (.claude/plans/) are never deduplicated.
   *
   * @param resolvedPath - File path resolved from tool_call arguments (preferred over content extraction)
   */
  processToolResult(
    toolName: string | undefined,
    content: string,
    turnIndex: number,
    resolvedPath?: string,
  ): { content: string; deduplicated: boolean; filePath?: string } {
    const name = (toolName ?? "").toLowerCase();
    if (!READ_TOOL_NAMES.has(name)) return { content, deduplicated: false };

    const filePath = resolvedPath || extractFilePath(content);
    if (!filePath) return { content, deduplicated: false };

    if (content.length < 200) return { content, deduplicated: false };

    if (isPlanFile(filePath)) return { content, deduplicated: false };

    this.stats.totalReads += 1;
    const hash = fastHash(content);
    const existing = this.fileMap.get(filePath);

    if (existing && existing.hash === hash) {
      if (existing.turnIndex < this.contextWindowStart - this.stalenessMargin) {
        this.fileMap.set(filePath, { hash, turnIndex, charCount: content.length, unchangedReadCount: 0 });
        return { content, deduplicated: false };
      }
      existing.unchangedReadCount += 1;
      this.stats.deduplicatedReads += 1;
      this.stats.charsSaved += content.length;
      const HARD_BLOCK_THRESHOLD = 3;
      if (existing.unchangedReadCount >= HARD_BLOCK_THRESHOLD) {
        const stub = `<FILE_READ_BLOCKED path="${filePath}" reads="${existing.unchangedReadCount}" />\nYou have read this file ${existing.unchangedReadCount} times and it has not changed. The content is already in your context. STOP re-reading it and use the information you already have. Make a decision and act on it.`;
        return { content: stub, deduplicated: true, filePath };
      }
      const stub = [
        `<FILE_UNCHANGED path="${filePath}" hash="${hash}" first_seen_turn=${existing.turnIndex} chars=${content.length} repeat=${existing.unchangedReadCount} />`,
        `[Unchanged since last read — you already have this file's content. Do NOT re-read it. Use what you have or make an edit.]`,
      ].join("\n");
      return { content: stub, deduplicated: true, filePath };
    }

    this.fileMap.set(filePath, { hash, turnIndex, charCount: content.length, unchangedReadCount: 0 });
    this.structuralIndex?.ingestFileRead(filePath, content, hash);
    return { content, deduplicated: false };
  }

  /**
   * Process an array of messages, deduplicating file reads in-place.
   * Resolves file paths from tool_call arguments when available, falling
   * back to content extraction.
   */
  processMessages(
    messages: Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
  ): { messages: Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>; dedupCount: number; dedupPaths: string[] } {
    const toolCallPathMap = buildToolCallFilePathMap(messages);
    let dedupCount = 0;
    const dedupPaths: string[] = [];
    const out = messages.map((m, idx) => {
      if (m.role !== "tool") return m;
      const raw = typeof m.content === "string" ? m.content : "";
      if (!raw) return m;
      const resolvedPath = m.tool_call_id ? toolCallPathMap.get(m.tool_call_id) : undefined;
      const result = this.processToolResult(m.name, raw, idx, resolvedPath);
      if (result.deduplicated) {
        dedupCount += 1;
        if (result.filePath) dedupPaths.push(result.filePath);
        return { ...m, content: result.content };
      }
      return m;
    });
    return { messages: out, dedupCount, dedupPaths };
  }

  /** Reset the hash map (e.g., on session compaction). */
  reset(): void {
    this.fileMap.clear();
  }

  getStats(): ContentDedupStats {
    return { ...this.stats };
  }

  getTrackedFileCount(): number {
    return this.fileMap.size;
  }

  /**
   * Generate a compact listing of all files the session has already read.
   * Useful for injection when the model is looping on exploration,
   * giving it a structural overview without re-reading.
   */
  generateFilesSummaryBlock(): string | null {
    if (this.fileMap.size === 0) return null;
    const entries = Array.from(this.fileMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, entry]) => {
        const sizeNote = entry.charCount > 5000 ? ` (${Math.round(entry.charCount / 1000)}k chars)` : "";
        return `  ${path}${sizeNote}`;
      });
    return [
      `<FILES_ALREADY_READ count="${entries.length}">`,
      "You have already read these files in this session. Their content is in your context — do NOT re-read them.",
      ...entries,
      "</FILES_ALREADY_READ>",
    ].join("\n");
  }
}

/**
 * Walk messages to build a map from tool_call_id to the file path
 * from the tool call's arguments. This gives us the ACTUAL file path
 * the tool was invoked with, not a regex guess from the content.
 */
function buildToolCallFilePathMap(
  messages: Array<{ role: string; content: unknown }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const id = typeof tc?.id === "string" ? tc.id : "";
      const fnName = typeof tc?.function?.name === "string" ? tc.function.name.toLowerCase() : "";
      if (!id || !READ_TOOL_NAMES.has(fnName)) continue;
      const argsStr = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "";
      if (!argsStr) continue;
      try {
        const args = JSON.parse(argsStr) as Record<string, unknown>;
        for (const key of FILE_PATH_KEYS) {
          if (typeof args[key] === "string" && args[key]) {
            map.set(id, args[key] as string);
            break;
          }
        }
      } catch { /* not valid JSON */ }
    }
  }
  return map;
}

function isPlanFile(filePath: string): boolean {
  return filePath.includes("/.claude/plans/") || filePath.includes("\\.claude\\plans\\");
}

function extractFilePath(content: string): string | null {
  if (content.startsWith("{")) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      for (const key of FILE_PATH_KEYS) {
        if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
      }
    } catch { /* not JSON */ }
  }

  const match = content.match(/(?:filePath|file_path|path)\s*[:=]\s*"?([^\s"',}{]+)/i);
  return match?.[1] ?? null;
}

function fastHash(content: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h1 >>> 0) * 0x100000000 + (h2 >>> 0)).toString(36);
}
