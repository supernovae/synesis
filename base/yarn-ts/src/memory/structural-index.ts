/**
 * ProjectStructuralIndex — persistent, compact codebase representation.
 *
 * Builds an index of exported symbols (functions, types, classes) across
 * a project's source files and renders a token-budgeted "repo map" for
 * injection into the model's system context.
 *
 * Storage: Redis, keyed by project root content hash.
 * Rendering: PageRank-style relevance scoring weights cross-file symbols.
 */

import type { Redis } from "ioredis";
import type {
  FileIndexEntry,
  StructuralIndex,
  StructuralIndexStats,
  SymbolEntry,
} from "./types.js";
import { detectLanguage, extractSymbols } from "./extractors.js";
import { canonicalMemoryProjectRoot, safeMemoryCachePart } from "./cache-identity.js";

const REDIS_PREFIX = "yarn-ts:structural-index:";
const CHARS_PER_TOKEN_ESTIMATE = 4;
const STRUCTURAL_TEXT_LIMIT = 240;
const STRUCTURAL_SIGNATURE_LIMIT = 500;
const STRUCTURAL_FILES_LIMIT = 2000;
const STRUCTURAL_SYMBOLS_PER_FILE_LIMIT = 200;
const STRUCTURAL_IMPORTS_PER_FILE_LIMIT = 200;
const SYMBOL_KINDS = new Set([
  "function",
  "method",
  "type",
  "interface",
  "class",
  "const",
  "variable",
  "module",
]);

// ---------------------------------------------------------------------------
// Index builder
// ---------------------------------------------------------------------------

export interface FileInput {
  path: string;
  content: string;
}

function fastContentHash(files: FileInput[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const f of files) {
    for (let i = 0; i < f.path.length; i++) {
      const ch = f.path.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    const sample = f.content.slice(0, 512) + f.content.slice(-512);
    for (let i = 0; i < sample.length; i++) {
      const ch = sample.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h1 >>> 0) * 0x100000000 + (h2 >>> 0)).toString(36);
}

export function buildStructuralIndex(
  projectRoot: string,
  files: FileInput[],
  primaryLanguage: string,
): StructuralIndex {
  const safeProjectRoot = canonicalMemoryProjectRoot(projectRoot);
  const fileEntries: FileIndexEntry[] = [];
  const allSymbols: SymbolEntry[] = [];
  const fileContentMap = new Map<string, string>();

  for (const file of files) {
    const lang = detectLanguage(file.path);
    if (lang === "unknown") continue;

    const lines = file.content.split("\n").length;
    const { symbols, imports } = extractSymbols(file.content, file.path, lang);
    fileEntries.push({ path: file.path, language: lang, lines, symbols, imports });
    allSymbols.push(...symbols);
    fileContentMap.set(file.path, file.content);
  }

  const symbolRefs = computeSymbolRefs(allSymbols, fileEntries, fileContentMap);

  return {
    projectRoot: safeProjectRoot,
    language: primaryLanguage,
    generatedAt: Date.now(),
    contentHash: fastContentHash(files),
    files: fileEntries,
    symbolRefs,
  };
}

/**
 * Count cross-file references for each exported symbol name.
 * A symbol referenced in files other than its definition file gets a higher score.
 */
function computeSymbolRefs(
  symbols: SymbolEntry[],
  files: FileIndexEntry[],
  fileContentMap: Map<string, string>,
): Record<string, number> {
  const refs: Record<string, number> = {};
  const symbolDefs = new Map<string, string>();

  for (const sym of symbols) {
    if (!sym.exported) continue;
    const baseName = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
    if (!symbolDefs.has(baseName)) {
      symbolDefs.set(baseName, sym.file);
    }
  }

  for (const file of files) {
    const fullContent = fileContentMap.get(file.path) ?? "";

    for (const [name, defFile] of symbolDefs) {
      if (file.path === defFile) continue;
      if (name.length < 3) continue;
      if (fullContent.includes(name)) {
        refs[name] = (refs[name] ?? 0) + 1;
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Token-budgeted rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  tokenBudget: number;
  recentFiles?: string[];
}

/**
 * Render a compact repo map string that fits within the token budget.
 * Prioritizes symbols with high cross-file reference counts and files
 * the model has recently interacted with.
 */
export function renderStructuralMap(
  index: StructuralIndex,
  opts: RenderOptions,
): string {
  const { tokenBudget, recentFiles = [] } = opts;
  const charBudget = tokenBudget * CHARS_PER_TOKEN_ESTIMATE;
  const recentSet = new Set(recentFiles);

  const rankedFiles = [...index.files]
    .map((f) => {
      let score = 0;
      for (const sym of f.symbols) {
        if (!sym.exported) continue;
        const baseName = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
        score += (index.symbolRefs[baseName] ?? 0) + 1;
      }
      if (recentSet.has(f.path)) score += 50;
      return { file: f, score };
    })
    .sort((a, b) => b.score - a.score);

  const lines: string[] = ["<STRUCTURAL_INDEX>"];
  let chars = lines[0].length;

  for (const { file } of rankedFiles) {
    const exportedSymbols = file.symbols.filter((s) => s.exported);
    if (exportedSymbols.length === 0 && file.imports.length === 0) continue;

    const header = `\n${structuralText(file.path)} (${safeNonNegativeInt(file.lines)}L, ${structuralText(file.language)})`;
    const sigLines = exportedSymbols.map((s) => `  ${structuralText(s.signature, STRUCTURAL_SIGNATURE_LIMIT)}`);
    const block = [header, ...sigLines].join("\n");

    if (chars + block.length > charBudget - 30) break;
    lines.push(block);
    chars += block.length;
  }

  lines.push("</STRUCTURAL_INDEX>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Redis persistence
// ---------------------------------------------------------------------------

export class ProjectStructuralIndexService {
  private readonly stats: StructuralIndexStats = {
    totalFiles: 0,
    totalSymbols: 0,
    totalImports: 0,
    generationMs: 0,
    tokenEstimate: 0,
  };

  constructor(
    private readonly redis: Redis | null,
    private readonly ttlSeconds: number,
  ) {}

  async get(projectRoot: string): Promise<StructuralIndex | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(this.key(projectRoot));
    if (!raw) return null;
    try {
      return normalizeStructuralIndex(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async store(index: StructuralIndex): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(
      this.key(index.projectRoot),
      JSON.stringify(index),
      "EX",
      this.ttlSeconds,
    );
    this.stats.totalFiles = index.files.length;
    this.stats.totalSymbols = index.files.reduce((n, f) => n + f.symbols.length, 0);
    this.stats.totalImports = index.files.reduce((n, f) => n + f.imports.length, 0);
  }

  /**
   * Build an index from file inputs and persist it.
   * Returns the rendered map string within the given token budget.
   */
  async buildAndStore(
    projectRoot: string,
    files: FileInput[],
    primaryLanguage: string,
    renderOpts: RenderOptions,
  ): Promise<{ index: StructuralIndex; map: string }> {
    const start = Date.now();
    const index = buildStructuralIndex(projectRoot, files, primaryLanguage);
    this.stats.generationMs = Date.now() - start;

    await this.store(index);

    const map = renderStructuralMap(index, renderOpts);
    this.stats.tokenEstimate = Math.ceil(map.length / CHARS_PER_TOKEN_ESTIMATE);
    return { index, map };
  }

  async getRenderedMap(
    projectRoot: string,
    renderOpts: RenderOptions,
  ): Promise<string | null> {
    const index = await this.get(projectRoot);
    if (!index) return null;
    return renderStructuralMap(index, renderOpts);
  }

  getStats(): StructuralIndexStats {
    return { ...this.stats };
  }

  private key(projectRoot: string): string {
    return structuralIndexRedisKey(projectRoot);
  }
}

export function structuralIndexRedisKey(projectRoot: string): string {
  return `${REDIS_PREFIX}${safeMemoryCachePart(canonicalMemoryProjectRoot(projectRoot), "workspace")}`;
}

function normalizeStructuralIndex(value: unknown): StructuralIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const projectRoot = canonicalMemoryProjectRoot(asString(row.projectRoot, "no-workspace"));
  const language = structuralText(asString(row.language, "unknown"));
  const generatedAt = safeNonNegativeInt(row.generatedAt);
  const contentHash = structuralText(asString(row.contentHash, ""), 128);
  const rawFiles = Array.isArray(row.files) ? row.files.slice(0, STRUCTURAL_FILES_LIMIT) : [];
  const files: FileIndexEntry[] = [];
  for (const rawFile of rawFiles) {
    const file = normalizeFileIndexEntry(rawFile);
    if (file) files.push(file);
  }
  return {
    projectRoot,
    language,
    generatedAt,
    contentHash,
    files,
    symbolRefs: normalizeSymbolRefs(row.symbolRefs),
  };
}

function normalizeFileIndexEntry(value: unknown): FileIndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const path = structuralText(asString(row.path, ""), STRUCTURAL_TEXT_LIMIT);
  if (!path) return null;
  const rawSymbols = Array.isArray(row.symbols) ? row.symbols.slice(0, STRUCTURAL_SYMBOLS_PER_FILE_LIMIT) : [];
  const symbols: SymbolEntry[] = [];
  for (const rawSymbol of rawSymbols) {
    const symbol = normalizeSymbolEntry(rawSymbol, path);
    if (symbol) symbols.push(symbol);
  }
  const imports = (Array.isArray(row.imports) ? row.imports : [])
    .map((item) => structuralText(asString(item, ""), STRUCTURAL_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, STRUCTURAL_IMPORTS_PER_FILE_LIMIT);
  return {
    path,
    language: structuralText(asString(row.language, "unknown")),
    lines: safeNonNegativeInt(row.lines),
    symbols,
    imports,
  };
}

function normalizeSymbolEntry(value: unknown, fallbackFile: string): SymbolEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = structuralText(asString(row.name, ""), STRUCTURAL_TEXT_LIMIT);
  const kind = asString(row.kind, "");
  const signature = structuralText(asString(row.signature, ""), STRUCTURAL_SIGNATURE_LIMIT);
  if (!name || !SYMBOL_KINDS.has(kind) || !signature) return null;
  return {
    name,
    kind: kind as SymbolEntry["kind"],
    file: structuralText(asString(row.file, fallbackFile), STRUCTURAL_TEXT_LIMIT) || fallbackFile,
    line: safeNonNegativeInt(row.line),
    signature,
    exported: row.exported === true,
  };
}

function normalizeSymbolRefs(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const refs: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = structuralText(rawKey, STRUCTURAL_TEXT_LIMIT);
    if (!key) continue;
    refs[key] = Math.min(10_000, safeNonNegativeInt(rawValue));
  }
  return refs;
}

function structuralText(value: unknown, limit = STRUCTURAL_TEXT_LIMIT): string {
  return replaceControlCharsWithSpace(String(value ?? ""))
    .replace(/[<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .trim();
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function safeNonNegativeInt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}
