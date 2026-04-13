/**
 * Lightweight regex-based signature extractors for Go, TypeScript, and Python.
 *
 * These produce compact symbol tables without requiring tree-sitter or
 * language-specific parsers. Accuracy is "good enough for navigation" —
 * the model uses these to know *what exists and where*, not for compilation.
 */

import type { SymbolEntry, SymbolKind } from "./types.js";

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_FUNC_RE = /^(func)\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+(\S+))?\s*\{?/gm;
const GO_TYPE_RE = /^type\s+(\w+)\s+(struct|interface)\s*\{/gm;
const GO_CONST_RE = /^(?:var|const)\s+(\w+)\s/gm;
const GO_IMPORT_RE = /^\s*"([^"]+)"/gm;

export function extractGoSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let m: RegExpExecArray | null;
    GO_FUNC_RE.lastIndex = 0;
    m = GO_FUNC_RE.exec(line);
    if (m) {
      const receiver = m[3];
      const name = m[4];
      const params = m[5] ?? "";
      const retMulti = m[6];
      const retSingle = m[7];
      const ret = retMulti ? `(${retMulti})` : retSingle ?? "";
      const kind: SymbolKind = receiver ? "method" : "function";
      const sig = receiver
        ? `func (${m[2]} ${m[3]}) ${name}(${params}) ${ret}`.trim()
        : `func ${name}(${params}) ${ret}`.trim();
      symbols.push({ name: receiver ? `${receiver}.${name}` : name, kind, file: filePath, line: i + 1, signature: sig, exported: name[0] === name[0].toUpperCase() });
      continue;
    }

    GO_TYPE_RE.lastIndex = 0;
    m = GO_TYPE_RE.exec(line);
    if (m) {
      const kind: SymbolKind = m[2] === "interface" ? "interface" : "type";
      symbols.push({ name: m[1], kind, file: filePath, line: i + 1, signature: `type ${m[1]} ${m[2]}`, exported: m[1][0] === m[1][0].toUpperCase() });
      continue;
    }

    GO_CONST_RE.lastIndex = 0;
    m = GO_CONST_RE.exec(line);
    if (m) {
      const name = m[1];
      if (name[0] === name[0].toUpperCase()) {
        symbols.push({ name, kind: "const", file: filePath, line: i + 1, signature: line.trim(), exported: true });
      }
    }

    GO_IMPORT_RE.lastIndex = 0;
    m = GO_IMPORT_RE.exec(line);
    if (m) {
      imports.push(m[1]);
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_EXPORT_FUNC_RE = /^export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const TS_EXPORT_CLASS_RE = /^export\s+(?:abstract\s+)?class\s+(\w+)/;
const TS_EXPORT_INTERFACE_RE = /^export\s+(?:interface|type)\s+(\w+)/;
const TS_EXPORT_CONST_RE = /^export\s+(?:const|let|var)\s+(\w+)/;
const TS_METHOD_RE = /^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)/;
const TS_IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/;

export function extractTypeScriptSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    m = line.match(TS_IMPORT_RE);
    if (m) {
      imports.push(m[1]);
      continue;
    }

    m = line.match(TS_EXPORT_FUNC_RE);
    if (m) {
      symbols.push({ name: m[1], kind: "function", file: filePath, line: i + 1, signature: `export function ${m[1]}(${m[2]})`, exported: true });
      currentClass = null;
      continue;
    }

    m = line.match(TS_EXPORT_CLASS_RE);
    if (m) {
      symbols.push({ name: m[1], kind: "class", file: filePath, line: i + 1, signature: line.trim(), exported: true });
      currentClass = m[1];
      continue;
    }

    m = line.match(TS_EXPORT_INTERFACE_RE);
    if (m) {
      const kind: SymbolKind = line.includes("interface") ? "interface" : "type";
      symbols.push({ name: m[1], kind, file: filePath, line: i + 1, signature: line.trim(), exported: true });
      currentClass = null;
      continue;
    }

    m = line.match(TS_EXPORT_CONST_RE);
    if (m) {
      symbols.push({ name: m[1], kind: "const", file: filePath, line: i + 1, signature: line.trim().slice(0, 120), exported: true });
      currentClass = null;
      continue;
    }

    if (currentClass) {
      m = line.match(TS_METHOD_RE);
      if (m && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
        symbols.push({ name: `${currentClass}.${m[1]}`, kind: "method", file: filePath, line: i + 1, signature: `${m[1]}(${m[2]})`, exported: true });
      }
    }

    if (/^\}\s*$/.test(line) && currentClass) {
      currentClass = null;
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_DEF_RE = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)/;
const PY_CLASS_RE = /^class\s+(\w+)/;
const PY_IMPORT_RE = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/;

export function extractPythonSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    m = line.match(PY_IMPORT_RE);
    if (m) {
      imports.push(m[1] ?? m[2]);
      continue;
    }

    m = line.match(PY_CLASS_RE);
    if (m) {
      symbols.push({ name: m[1], kind: "class", file: filePath, line: i + 1, signature: line.trim(), exported: !m[1].startsWith("_") });
      currentClass = m[1];
      continue;
    }

    m = line.match(PY_DEF_RE);
    if (m) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3];
      const isMethod = indent > 0 && currentClass !== null;
      const kind: SymbolKind = isMethod ? "method" : "function";
      const fullName = isMethod ? `${currentClass}.${name}` : name;
      symbols.push({ name: fullName, kind, file: filePath, line: i + 1, signature: `def ${name}(${params})`, exported: !name.startsWith("_") });
      continue;
    }

    if (currentClass && !line.startsWith(" ") && !line.startsWith("\t") && line.trim().length > 0) {
      currentClass = null;
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function extractSymbols(
  content: string,
  filePath: string,
  language: string,
): { symbols: SymbolEntry[]; imports: string[] } {
  switch (language) {
    case "go":
      return extractGoSymbols(content, filePath);
    case "typescript":
    case "javascript":
      return extractTypeScriptSymbols(content, filePath);
    case "python":
      return extractPythonSymbols(content, filePath);
    default:
      return { symbols: [], imports: [] };
  }
}

export function detectLanguage(filePath: string): string {
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  return "unknown";
}
