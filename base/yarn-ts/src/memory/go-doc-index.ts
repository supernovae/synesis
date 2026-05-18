/**
 * Go Doc Repomap — immediate pragmatic structural index for Go projects.
 *
 * Uses `go doc ./...` output as a zero-dependency structural index.
 * Go's built-in doc tool produces a natural API surface listing that
 * serves as a repo map without any tree-sitter or AST parsing.
 *
 * For Go projects, this can be used immediately (Phase 0) before the
 * full structural index service is wired up.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileInput } from "./structural-index.js";
import type { StructuralIndex, FileIndexEntry, SymbolEntry } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 32_000;
const TIMEOUT_MS = 10_000;

/**
 * Run `go doc ./...` in the project root and return the raw output.
 * Returns null if the command fails (no Go toolchain, not a Go project, etc.).
 */
export async function runGoDoc(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("go", ["doc", "./..."], {
      cwd: projectRoot,
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      maxBuffer: MAX_OUTPUT_CHARS * 2,
    });
    return stdout.slice(0, MAX_OUTPUT_CHARS);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser: convert `go doc ./...` output into a StructuralIndex
// ---------------------------------------------------------------------------

const PKG_HEADER_RE = /^package\s+(\S+)\s+\/\/\s+import\s+"([^"]+)"/;
const FUNC_RE = /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+(\S+))?/;
const TYPE_RE = /^type\s+(\w+)\s+(struct|interface|int|string|bool|float64|byte|.*)/;
const CONST_RE = /^(?:const|var)\s+(\w+)\s/;

/**
 * Parse `go doc ./...` output into a lightweight StructuralIndex.
 */
export function parseGoDocOutput(
  goDocOutput: string,
  projectRoot: string,
): StructuralIndex {
  const files: FileIndexEntry[] = [];
  const allSymbols: SymbolEntry[] = [];
  let currentPkg: { name: string; importPath: string; symbols: SymbolEntry[] } | null = null;

  const lines = goDocOutput.split("\n");

  for (const line of lines) {
    const pkgMatch = line.match(PKG_HEADER_RE);
    if (pkgMatch) {
      if (currentPkg) {
        files.push({
          path: currentPkg.importPath,
          language: "go",
          lines: 0,
          symbols: currentPkg.symbols,
          imports: [],
        });
      }
      currentPkg = { name: pkgMatch[1], importPath: pkgMatch[2], symbols: [] };
      continue;
    }

    if (!currentPkg) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const funcMatch = trimmed.match(FUNC_RE);
    if (funcMatch) {
      const receiver = funcMatch[2];
      const name = funcMatch[3];
      const sym: SymbolEntry = {
        name: receiver ? `${receiver}.${name}` : name,
        kind: receiver ? "method" : "function",
        file: currentPkg.importPath,
        line: 0,
        signature: trimmed,
        exported: name[0] === name[0].toUpperCase(),
      };
      currentPkg.symbols.push(sym);
      allSymbols.push(sym);
      continue;
    }

    const typeMatch = trimmed.match(TYPE_RE);
    if (typeMatch) {
      const name = typeMatch[1];
      const typeKind = typeMatch[2];
      const sym: SymbolEntry = {
        name,
        kind: typeKind === "interface" ? "interface" : "type",
        file: currentPkg.importPath,
        line: 0,
        signature: `type ${name} ${typeKind}`,
        exported: name[0] === name[0].toUpperCase(),
      };
      currentPkg.symbols.push(sym);
      allSymbols.push(sym);
      continue;
    }

    const constMatch = trimmed.match(CONST_RE);
    if (constMatch) {
      const name = constMatch[1];
      if (name[0] === name[0].toUpperCase()) {
        const sym: SymbolEntry = {
          name,
          kind: "const",
          file: currentPkg.importPath,
          line: 0,
          signature: trimmed.slice(0, 120),
          exported: true,
        };
        currentPkg.symbols.push(sym);
        allSymbols.push(sym);
      }
    }
  }

  if (currentPkg) {
    files.push({
      path: currentPkg.importPath,
      language: "go",
      lines: 0,
      symbols: currentPkg.symbols,
      imports: [],
    });
  }

  return {
    projectRoot,
    language: "go",
    generatedAt: Date.now(),
    contentHash: `godoc_${Date.now().toString(36)}`,
    files,
    symbolRefs: {},
  };
}

/**
 * All-in-one: run go doc, parse, return a structural index.
 * Returns null if go doc fails or produces no output.
 */
export async function buildGoDocIndex(projectRoot: string): Promise<StructuralIndex | null> {
  const output = await runGoDoc(projectRoot);
  if (!output || output.trim().length < 20) return null;

  const index = parseGoDocOutput(output, projectRoot);
  if (index.files.length === 0) return null;

  return index;
}

/**
 * Render a compact go-doc-based repo map for system context injection.
 */
export function renderGoDocMap(
  goDocOutput: string,
  tokenBudget: number,
): string {
  const charBudget = tokenBudget * 4;
  let output = goDocOutput;
  if (output.length > charBudget) {
    output = output.slice(0, charBudget - 30) + "\n... (truncated)";
  }
  return [
    "<GO_DOC_INDEX>",
    output.trim(),
    "</GO_DOC_INDEX>",
  ].join("\n");
}
