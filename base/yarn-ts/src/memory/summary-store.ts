/**
 * HierarchicalSummaryStore — persistent file/directory/project summaries.
 *
 * When the model reads a file, Yarn generates a compact ~100-token summary
 * and stores it keyed by (path, contentHash). Summaries are invalidated
 * when file content changes. Directory and project summaries aggregate
 * their children.
 *
 * This is the MemGPT "external context" tier — the model pages summaries
 * in instead of re-reading raw files.
 */

import type { Redis } from "ioredis";
import type { FileSummary, SummaryLevel, SummaryStoreStats } from "./types.js";
import { detectLanguage } from "./extractors.js";
import { canonicalMemoryProjectRoot, safeMemoryCachePart } from "./cache-identity.js";

const REDIS_PREFIX = "yarn-ts:summary:";
const DEFAULT_TTL_S = 14_400;
const CHARS_PER_TOKEN = 4;
const MAX_MEMORY_TEXT_CHARS = 4_000;
const MAX_MEMORY_ATTR_CHARS = 512;

function replaceControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : char;
  }
  return out;
}

function memoryText(value: unknown, maxChars = MAX_MEMORY_TEXT_CHARS): string {
  return replaceControlChars(String(value ?? ""))
    .replace(/=/g, ":")
    .replace(/[<>"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function memoryAttr(value: unknown, fallback = "unknown"): string {
  const sanitized = memoryText(value, MAX_MEMORY_ATTR_CHARS)
    .replace(/[^A-Za-z0-9_./@:+ -]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
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

// ---------------------------------------------------------------------------
// Heuristic summarizer (no LLM; deterministic)
// ---------------------------------------------------------------------------

/**
 * Generate a compact summary of a file from its content.
 * Uses heuristic extraction: imports, exported symbol names, and structure.
 */
export function generateFileSummary(
  filePath: string,
  content: string,
  maxTokens = 100,
): string {
  const lang = detectLanguage(filePath);
  const lines = content.split("\n");
  const lineCount = lines.length;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const parts: string[] = [`${filePath} (${lineCount}L, ${lang})`];

  const exportedNames: string[] = [];
  const importPaths: string[] = [];

  for (const line of lines) {
    if (lang === "go") {
      const funcMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
      if (funcMatch && funcMatch[1][0] === funcMatch[1][0].toUpperCase()) {
        exportedNames.push(funcMatch[1]);
      }
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) exportedNames.push(typeMatch[1]);
    } else if (lang === "typescript" || lang === "javascript") {
      const m = line.match(/^export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+(\w+)/);
      if (m) exportedNames.push(m[1]);
    } else if (lang === "python") {
      const m = line.match(/^(?:def|class)\s+(\w+)/);
      if (m && !m[1].startsWith("_")) exportedNames.push(m[1]);
    } else if (lang === "rust") {
      const m = line.match(/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+(\w+)/);
      if (m) exportedNames.push(m[1]);
    } else if (lang === "java" || lang === "kotlin") {
      const m = line.match(/^(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/);
      if (m) exportedNames.push(m[1]);
    } else if (lang === "c" || lang === "cpp") {
      const m = line.match(/^(?:typedef\s+)?(?:struct|class|enum|union)\s+(\w+)/);
      if (m) exportedNames.push(m[1]);
    }

    const impMatch = line.match(/(?:from|import)\s+["']([^"']+)["']/);
    if (impMatch) importPaths.push(impMatch[1]);
    const goImpMatch = line.match(/^\s*"([^"]+)"/);
    if (goImpMatch && lang === "go") importPaths.push(goImpMatch[1]);
    const rustUseMatch = line.match(/^use\s+([^;]+);/);
    if (rustUseMatch && lang === "rust") importPaths.push(rustUseMatch[1].trim());
    const javaImpMatch = line.match(/^import\s+(?:static\s+)?([^;]+);/);
    if (javaImpMatch && (lang === "java" || lang === "kotlin")) importPaths.push(javaImpMatch[1].trim());
    const cIncMatch = line.match(/^#include\s+[<"]([^>"]+)[>"]/);
    if (cIncMatch && (lang === "c" || lang === "cpp")) importPaths.push(cIncMatch[1]);
  }

  if (exportedNames.length > 0) {
    parts.push(`Exports: ${exportedNames.slice(0, 15).join(", ")}`);
  }
  if (importPaths.length > 0) {
    const shortImports = importPaths.slice(0, 8).map((p) => p.split("/").pop() ?? p);
    parts.push(`Imports: ${shortImports.join(", ")}`);
  }

  let summary = parts.join(". ");
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 3) + "...";
  }
  return summary;
}

/**
 * Generate a directory summary by aggregating child file summaries.
 */
export function generateDirectorySummary(
  dirPath: string,
  childSummaries: FileSummary[],
  maxTokens = 150,
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const fileCount = childSummaries.length;
  const totalLines = childSummaries.reduce((n, s) => n + s.lineCount, 0);
  const totalSymbols = childSummaries.reduce((n, s) => n + s.symbolCount, 0);
  const languages = [...new Set(childSummaries.map((s) => s.language))];

  const parts = [
    `${dirPath}/ (${fileCount} files, ${totalLines}L, ${totalSymbols} symbols)`,
    `Languages: ${languages.join(", ")}`,
  ];

  const fileNames = childSummaries.map((s) => s.path.split("/").pop() ?? s.path);
  parts.push(`Files: ${fileNames.slice(0, 12).join(", ")}`);

  let summary = parts.join(". ");
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 3) + "...";
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class HierarchicalSummaryStore {
  private readonly stats: SummaryStoreStats = {
    fileSummaries: 0,
    directorySummaries: 0,
    projectSummaries: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  /**
   * @param keyScope - Session-scoped prefix (e.g. session key) so different conversations do not share Redis keys.
   */
  constructor(
    private readonly redis: Redis | null,
    private readonly maxTokens = 100,
    private readonly ttlSeconds = DEFAULT_TTL_S,
    private readonly keyScope: string = "",
  ) {}

  /**
   * Get or create a file summary. Returns cached summary if content hash
   * matches; generates and stores a new one otherwise.
   */
  async getOrCreateFileSummary(
    filePath: string,
    content: string,
    projectRoot: string,
  ): Promise<FileSummary> {
    const contentHash = fastHash(content);
    const existing = await this.getFileSummary(filePath, projectRoot);

    if (existing && existing.contentHash === contentHash) {
      this.stats.cacheHits += 1;
      return existing;
    }

    this.stats.cacheMisses += 1;
    const lang = detectLanguage(filePath);
    const lines = content.split("\n").length;
    const summaryText = generateFileSummary(filePath, content, this.maxTokens);

    const exportRe = lang === "go"
      ? /^(?:func|type)\s+(\w)/gm
      : lang === "python"
        ? /^(?:def|class)\s+(\w)/gm
        : /^export\s+/gm;
    const symbolCount = (content.match(exportRe) ?? []).length;

    const summary: FileSummary = {
      path: filePath,
      level: "file",
      summary: summaryText,
      contentHash,
      language: lang,
      symbolCount,
      lineCount: lines,
      updatedAt: Date.now(),
    };

    await this.storeFileSummary(summary, projectRoot);
    this.stats.fileSummaries += 1;
    return summary;
  }

  /**
   * Build a directory summary from stored file summaries.
   */
  async getOrCreateDirectorySummary(
    dirPath: string,
    projectRoot: string,
    childPaths: string[],
  ): Promise<FileSummary> {
    const children: FileSummary[] = [];
    for (const p of childPaths) {
      const s = await this.getFileSummary(p, projectRoot);
      if (s) children.push(s);
    }

    const summaryText = generateDirectorySummary(dirPath, children);
    const contentHash = fastHash(children.map((c) => c.contentHash).join(":"));

    const summary: FileSummary = {
      path: dirPath,
      level: "directory",
      summary: summaryText,
      contentHash,
      language: children[0]?.language ?? "unknown",
      symbolCount: children.reduce((n, c) => n + c.symbolCount, 0),
      lineCount: children.reduce((n, c) => n + c.lineCount, 0),
      updatedAt: Date.now(),
    };

    if (this.redis) {
      await this.redis.set(
        this.key(dirPath, projectRoot),
        JSON.stringify(summary),
        "EX",
        this.ttlSeconds,
      );
    }
    this.stats.directorySummaries += 1;
    return summary;
  }

  /**
   * Build a project-level summary from directory summaries.
   */
  async getOrCreateProjectSummary(
    projectRoot: string,
    dirPaths: string[],
  ): Promise<FileSummary> {
    const safeProjectRoot = canonicalMemoryProjectRoot(projectRoot);
    const dirs: FileSummary[] = [];
    for (const d of dirPaths) {
      const s = await this.getDirSummary(d, projectRoot);
      if (s) dirs.push(s);
    }

    const totalFiles = dirs.reduce((n, d) => n + d.symbolCount, 0);
    const totalLines = dirs.reduce((n, d) => n + d.lineCount, 0);
    const languages = [...new Set(dirs.map((d) => d.language))];
    const summaryText = `${safeProjectRoot} (${dirs.length} dirs, ${totalFiles} symbols, ${totalLines}L). Languages: ${languages.join(", ")}. Directories: ${dirs.map((d) => d.path).slice(0, 10).join(", ")}`;

    const summary: FileSummary = {
      path: safeProjectRoot,
      level: "project",
      summary: summaryText,
      contentHash: fastHash(dirs.map((d) => d.contentHash).join(":")),
      language: languages[0] ?? "unknown",
      symbolCount: totalFiles,
      lineCount: totalLines,
      updatedAt: Date.now(),
    };

    if (this.redis) {
      await this.redis.set(
        this.key("__project__", projectRoot),
        JSON.stringify(summary),
        "EX",
        this.ttlSeconds,
      );
    }
    this.stats.projectSummaries += 1;
    return summary;
  }

  /**
   * Query summaries at a given scope level.
   */
  async query(
    scope: SummaryLevel,
    path: string,
    projectRoot: string,
  ): Promise<FileSummary | null> {
    switch (scope) {
      case "file":
        return this.getFileSummary(path, projectRoot);
      case "directory":
        return this.getDirSummary(path, projectRoot);
      case "project":
        return this.getProjectSummary(projectRoot);
      default:
        return null;
    }
  }

  /**
   * Format a summary result as a compact block for model context.
   */
  formatSummaryBlock(summary: FileSummary | null, scope: SummaryLevel, path: string): string {
    const safeScope = memoryAttr(scope);
    const safePath = memoryAttr(path);
    if (!summary) {
      return `<PROJECT_MEMORY scope="${safeScope}" path="${safePath}">No summary available for this ${safeScope}.</PROJECT_MEMORY>`;
    }
    return [
      `<PROJECT_MEMORY scope="${safeScope}" path="${safePath}">`,
      memoryText(summary.summary),
      `</PROJECT_MEMORY>`,
    ].join("\n");
  }

  getStats(): SummaryStoreStats {
    return { ...this.stats };
  }

  // -- private helpers --

  private async getFileSummary(filePath: string, projectRoot: string): Promise<FileSummary | null> {
    return this.loadFromRedis(this.key(filePath, projectRoot));
  }

  private async getDirSummary(dirPath: string, projectRoot: string): Promise<FileSummary | null> {
    return this.loadFromRedis(this.key(dirPath, projectRoot));
  }

  private async getProjectSummary(projectRoot: string): Promise<FileSummary | null> {
    return this.loadFromRedis(this.key("__project__", projectRoot));
  }

  private async storeFileSummary(summary: FileSummary, projectRoot: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(
      this.key(summary.path, projectRoot),
      JSON.stringify(summary),
      "EX",
      this.ttlSeconds,
    );
  }

  private async loadFromRedis(key: string): Promise<FileSummary | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FileSummary;
    } catch {
      return null;
    }
  }

  private key(path: string, projectRoot: string): string {
    return summaryStoreRedisKey(projectRoot, path, this.keyScope);
  }
}

export function summaryStoreRedisKey(projectRoot: string, path: string, keyScope = ""): string {
  const scope = keyScope ? `${safeMemoryCachePart(keyScope, "scope")}:` : "";
  const safeRoot = safeMemoryCachePart(canonicalMemoryProjectRoot(projectRoot), "workspace");
  const safePath = safeMemoryCachePart(path, "path", 240);
  return `${REDIS_PREFIX}${scope}${safeRoot}:${safePath}`;
}

/** Create a store scoped to a single session (avoids key collisions across users/conversations). */
export function createHierarchicalSummaryStore(
  redis: Redis | null,
  maxTokens: number,
  ttlSeconds: number,
  sessionKey: string,
): HierarchicalSummaryStore {
  const scope = sessionKey.replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 200);
  return new HierarchicalSummaryStore(redis, maxTokens, ttlSeconds, scope);
}
