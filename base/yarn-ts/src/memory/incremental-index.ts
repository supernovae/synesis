/**
 * Incremental Structural Index — builds a repo map from file reads
 * that pass through the Yarn proxy.
 *
 * Since Yarn is a proxy (no filesystem access), it observes file contents
 * from tool results (Read, str_replace_editor, etc.) and extracts symbols
 * incrementally. This produces the same StructuralIndex as the batch builder
 * but grows turn-by-turn as the model reads more files.
 */

import type { StructuralIndex, FileIndexEntry, SymbolEntry } from "./types.js";
import { extractSymbols, detectLanguage } from "./extractors.js";
import { generateFileSummary } from "./summary-store.js";

const CHARS_PER_TOKEN = 4;

export class IncrementalStructuralIndex {
  private files = new Map<string, FileIndexEntry>();
  private contentHashes = new Map<string, string>();
  private allSymbols: SymbolEntry[] = [];
  private symbolRefs: Record<string, number> = {};
  private projectRoot = "";
  private dominantLanguage = "unknown";
  private languageCounts = new Map<string, number>();
  private dirty = false;
  private cachedRender: string | null = null;
  private fileSummaries = new Map<string, string>();

  /**
   * Ingest a file read result. Extracts symbols and updates the index.
   * Returns true if new symbols were extracted (file was new or changed).
   */
  ingestFileRead(filePath: string, content: string, contentHash?: string): boolean {
    if (!filePath || content.length < 20) return false;

    const language = detectLanguage(filePath);
    if (language === "unknown") return false;

    if (contentHash && this.contentHashes.get(filePath) === contentHash) {
      return false;
    }

    const lines = content.split("\n").length;
    const { symbols, imports } = extractSymbols(content, filePath, language);

    if (symbols.length === 0 && imports.length === 0) return false;

    const existing = this.files.get(filePath);
    if (existing) {
      this.allSymbols = this.allSymbols.filter((s) => s.file !== filePath);
    }

    const entry: FileIndexEntry = {
      path: filePath,
      language,
      lines,
      symbols,
      imports,
    };

    this.files.set(filePath, entry);
    if (contentHash) this.contentHashes.set(filePath, contentHash);
    this.allSymbols.push(...symbols);

    this.languageCounts.set(language, (this.languageCounts.get(language) ?? 0) + 1);
    this.dominantLanguage = [...this.languageCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

    if (!this.projectRoot && filePath.includes("/")) {
      const parts = filePath.split("/");
      this.projectRoot = parts.length > 2 ? parts.slice(0, -2).join("/") : parts[0];
    }

    this.fileSummaries.set(filePath, generateFileSummary(filePath, content));

    this.dirty = true;
    this.cachedRender = null;
    return true;
  }

  /** Recompute cross-file symbol references. Call sparingly (O(files * symbols)). */
  recomputeRefs(): void {
    this.symbolRefs = {};
    const symbolDefs = new Map<string, string>();
    for (const sym of this.allSymbols) {
      if (!sym.exported) continue;
      const baseName = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
      if (!symbolDefs.has(baseName)) symbolDefs.set(baseName, sym.file);
    }

    for (const [path, entry] of this.files) {
      const sigText = entry.symbols.map((s) => s.signature).join("\n") +
        "\n" + entry.imports.join("\n");
      for (const [name, defFile] of symbolDefs) {
        if (path === defFile) continue;
        if (name.length < 3) continue;
        if (sigText.includes(name)) {
          this.symbolRefs[name] = (this.symbolRefs[name] ?? 0) + 1;
        }
      }
    }
    this.dirty = false;
  }

  /** Get the current structural index snapshot. */
  getIndex(): StructuralIndex {
    if (this.dirty) this.recomputeRefs();
    return {
      projectRoot: this.projectRoot,
      language: this.dominantLanguage,
      generatedAt: Date.now(),
      contentHash: `inc_${this.files.size}_${Date.now().toString(36)}`,
      files: Array.from(this.files.values()),
      symbolRefs: this.symbolRefs,
    };
  }

  /**
   * Render a compact repo map within a token budget.
   * Caches the result until new files are ingested.
   */
  renderMap(tokenBudget: number, recentFiles?: string[]): string | null {
    if (this.files.size === 0) return null;
    if (this.cachedRender && !this.dirty) return this.cachedRender;

    if (this.dirty) this.recomputeRefs();

    const charBudget = tokenBudget * CHARS_PER_TOKEN;
    const recentSet = new Set(recentFiles ?? []);
    const filesArr = Array.from(this.files.values());

    const ranked = filesArr
      .map((f) => {
        let score = 0;
        for (const sym of f.symbols) {
          if (!sym.exported) continue;
          const baseName = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
          score += (this.symbolRefs[baseName] ?? 0) + 1;
        }
        if (recentSet.has(f.path)) score += 50;
        return { file: f, score };
      })
      .sort((a, b) => b.score - a.score);

    const lines: string[] = [`<STRUCTURAL_INDEX files="${this.files.size}" language="${this.dominantLanguage}">`];
    let chars = lines[0].length;

    for (const { file } of ranked) {
      const exported = file.symbols.filter((s) => s.exported);
      if (exported.length === 0 && file.imports.length === 0) continue;

      const header = `\n${file.path} (${file.lines}L)`;
      const sigLines = exported.map((s) => `  ${s.signature}`);
      const block = [header, ...sigLines].join("\n");

      if (chars + block.length > charBudget - 30) break;
      lines.push(block);
      chars += block.length;
    }

    lines.push("</STRUCTURAL_INDEX>");
    this.cachedRender = lines.join("\n");
    return this.cachedRender;
  }

  /** Get a compact summary of a previously read file. */
  getFileSummary(filePath: string): string | null {
    return this.fileSummaries.get(filePath) ?? null;
  }

  /** Get all file summaries as a compact block for context injection. */
  renderSummaryBlock(maxTokens = 500): string | null {
    if (this.fileSummaries.size === 0) return null;
    const charBudget = maxTokens * CHARS_PER_TOKEN;
    const lines: string[] = [`<FILE_SUMMARIES count="${this.fileSummaries.size}">`];
    let chars = lines[0].length;

    for (const [, summary] of this.fileSummaries) {
      if (chars + summary.length + 1 > charBudget - 30) break;
      lines.push(`  ${summary}`);
      chars += summary.length + 3;
    }

    lines.push("</FILE_SUMMARIES>");
    return lines.join("\n");
  }

  getStats(): { fileCount: number; symbolCount: number; exportedCount: number } {
    const exported = this.allSymbols.filter((s) => s.exported).length;
    return { fileCount: this.files.size, symbolCount: this.allSymbols.length, exportedCount: exported };
  }

  reset(): void {
    this.files.clear();
    this.contentHashes.clear();
    this.allSymbols = [];
    this.symbolRefs = {};
    this.fileSummaries.clear();
    this.dirty = false;
    this.cachedRender = null;
  }
}
