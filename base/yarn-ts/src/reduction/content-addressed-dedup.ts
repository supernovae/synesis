/**
 * Content-Addressed File Deduplication
 *
 * Maintains a per-session hash map of file contents. When the same file is
 * read again with identical content, replaces the full content with a compact
 * reference stub, saving potentially thousands of tokens per repeated read.
 *
 * The dedup operates on tool-result messages that look like file reads
 * (tool name: read, read_file, etc.) before they enter the transcript.
 *
 * Strategy:
 * 1. Hash each file read result by path + content
 * 2. First occurrence: pass through unchanged, record hash + turn index
 * 3. Subsequent identical reads: replace with `<FILE_UNCHANGED path="..." hash="..." first_seen_turn=N />`
 * 4. Changed reads (same path, different content): pass through, update hash
 */

const READ_TOOL_NAMES = new Set([
  "read", "read_file", "readfile", "file_read",
  "str_replace_editor",
]);

const FILE_PATH_KEYS = ["filePath", "file_path", "path", "file", "fileName", "file_name"];

interface FileEntry {
  hash: string;
  turnIndex: number;
  charCount: number;
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

  constructor(stalenessMargin = 30) {
    this.stalenessMargin = stalenessMargin;
  }

  /** Inform the dedup of the current context window start index (after compaction). */
  setContextWindowStart(turnIndex: number): void {
    this.contextWindowStart = turnIndex;
  }

  /**
   * Process a tool result message. Returns the original content if unique,
   * or a compact stub if the file was already seen with identical content.
   * Plan files (.claude/plans/) are never deduplicated.
   */
  processToolResult(
    toolName: string | undefined,
    content: string,
    turnIndex: number,
  ): { content: string; deduplicated: boolean } {
    const name = (toolName ?? "").toLowerCase();
    if (!READ_TOOL_NAMES.has(name)) return { content, deduplicated: false };

    const filePath = extractFilePath(content);
    if (!filePath) return { content, deduplicated: false };

    if (content.length < 200) return { content, deduplicated: false };

    if (isPlanFile(filePath)) return { content, deduplicated: false };

    this.stats.totalReads += 1;
    const hash = fastHash(content);
    const existing = this.fileMap.get(filePath);

    if (existing && existing.hash === hash) {
      if (existing.turnIndex < this.contextWindowStart - this.stalenessMargin) {
        this.fileMap.set(filePath, { hash, turnIndex, charCount: content.length });
        return { content, deduplicated: false };
      }
      this.stats.deduplicatedReads += 1;
      this.stats.charsSaved += content.length;
      const stub = `<FILE_UNCHANGED path="${filePath}" hash="${hash}" first_seen_turn=${existing.turnIndex} chars=${content.length} />`;
      return { content: stub, deduplicated: true };
    }

    this.fileMap.set(filePath, { hash, turnIndex, charCount: content.length });
    return { content, deduplicated: false };
  }

  /**
   * Process an array of messages, deduplicating file reads in-place.
   */
  processMessages(
    messages: Array<{ role: string; name?: string; content: unknown }>,
  ): { messages: Array<{ role: string; name?: string; content: unknown }>; dedupCount: number } {
    let dedupCount = 0;
    const out = messages.map((m, idx) => {
      if (m.role !== "tool") return m;
      const raw = typeof m.content === "string" ? m.content : "";
      if (!raw) return m;
      const result = this.processToolResult(m.name, raw, idx);
      if (result.deduplicated) {
        dedupCount += 1;
        return { ...m, content: result.content };
      }
      return m;
    });
    return { messages: out, dedupCount };
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
