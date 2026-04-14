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
// Rust
// ---------------------------------------------------------------------------

const RUST_FN_RE = /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*(\S+))?\s*\{?/gm;
const RUST_TYPE_RE = /^(?:pub(?:\(crate\))?\s+)?(?:struct|enum|trait)\s+(\w+)/gm;
const RUST_IMPL_RE = /^impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/gm;
const RUST_USE_RE = /^use\s+([^;]+);/gm;

function extractRustSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    RUST_FN_RE.lastIndex = 0;
    m = RUST_FN_RE.exec(line);
    if (m) {
      const name = m[1];
      const params = m[2].trim();
      const ret = m[3] ? ` -> ${m[3]}` : "";
      const exported = line.trimStart().startsWith("pub");
      symbols.push({ name, kind: "function", file: filePath, line: i + 1, signature: `fn ${name}(${params})${ret}`, exported });
      continue;
    }

    RUST_TYPE_RE.lastIndex = 0;
    m = RUST_TYPE_RE.exec(line);
    if (m) {
      const name = m[1];
      const kind: SymbolKind = line.includes("trait") ? "interface" : "type";
      const exported = line.trimStart().startsWith("pub");
      symbols.push({ name, kind, file: filePath, line: i + 1, signature: line.trim().replace(/\s*\{$/, ""), exported });
      continue;
    }

    RUST_USE_RE.lastIndex = 0;
    m = RUST_USE_RE.exec(line);
    if (m) imports.push(m[1].trim());
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Java / Kotlin
// ---------------------------------------------------------------------------

const JAVA_CLASS_RE = /^(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/;
const JAVA_METHOD_RE = /^\s+(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?(\w[\w<>[\],\s]*?)\s+(\w+)\s*\(/;
const JAVA_IMPORT_RE = /^import\s+(?:static\s+)?([^;]+);/;

function extractJavaSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const impMatch = line.match(JAVA_IMPORT_RE);
    if (impMatch) { imports.push(impMatch[1].trim()); continue; }

    const classMatch = line.match(JAVA_CLASS_RE);
    if (classMatch) {
      const name = classMatch[1];
      currentClass = name;
      const kind: SymbolKind = line.includes("interface") ? "interface" : "class";
      const exported = line.includes("public");
      symbols.push({ name, kind, file: filePath, line: i + 1, signature: line.trim().replace(/\s*\{$/, ""), exported });
      continue;
    }

    const methodMatch = line.match(JAVA_METHOD_RE);
    if (methodMatch && currentClass) {
      const retType = methodMatch[1];
      const name = methodMatch[2];
      const exported = line.includes("public");
      const fullName = `${currentClass}.${name}`;
      symbols.push({ name: fullName, kind: "method", file: filePath, line: i + 1, signature: `${retType} ${name}(...)`, exported });
    }

    if (currentClass && !line.startsWith(" ") && !line.startsWith("\t") && line.trim() === "}") {
      currentClass = null;
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// C / C++ (lightweight)
// ---------------------------------------------------------------------------

const C_FUNC_RE = /^(?:static\s+)?(?:inline\s+)?(?:extern\s+)?(?:const\s+)?(\w[\w*\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*[{;]?/;
const C_STRUCT_RE = /^(?:typedef\s+)?(?:struct|class|enum|union)\s+(\w+)/;
const C_INCLUDE_RE = /^#include\s+[<"]([^>"]+)[>"]/;

function extractCSymbols(content: string, filePath: string): { symbols: SymbolEntry[]; imports: string[] } {
  const symbols: SymbolEntry[] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  const isHeader = filePath.endsWith(".h") || filePath.endsWith(".hpp");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const incMatch = line.match(C_INCLUDE_RE);
    if (incMatch) { imports.push(incMatch[1]); continue; }

    const structMatch = line.match(C_STRUCT_RE);
    if (structMatch) {
      const name = structMatch[1];
      symbols.push({ name, kind: "type", file: filePath, line: i + 1, signature: line.trim().replace(/\s*\{$/, ""), exported: isHeader || !line.includes("static") });
      continue;
    }

    if (line.startsWith("#") || line.startsWith("//") || line.startsWith("/*")) continue;

    const funcMatch = line.match(C_FUNC_RE);
    if (funcMatch) {
      const name = funcMatch[2];
      if (name === "if" || name === "for" || name === "while" || name === "switch" || name === "return") continue;
      const params = funcMatch[3].trim();
      const exported = !line.includes("static");
      symbols.push({ name, kind: "function", file: filePath, line: i + 1, signature: `${funcMatch[1].trim()} ${name}(${params})`, exported });
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
    case "rust":
      return extractRustSymbols(content, filePath);
    case "java":
    case "kotlin":
      return extractJavaSymbols(content, filePath);
    case "c":
    case "cpp":
      return extractCSymbols(content, filePath);
    default:
      return { symbols: [], imports: [] };
  }
}

export function detectLanguage(filePath: string): string {
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".rs")) return "rust";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".kt") || filePath.endsWith(".kts")) return "kotlin";
  if (filePath.endsWith(".c") || filePath.endsWith(".h")) return "c";
  if (filePath.endsWith(".cpp") || filePath.endsWith(".cc") || filePath.endsWith(".cxx") || filePath.endsWith(".hpp")) return "cpp";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".md")) return "markdown";
  if (filePath.endsWith(".sh") || filePath.endsWith(".bash")) return "shell";
  if (filePath.endsWith(".sql")) return "sql";
  if (filePath.endsWith(".rb")) return "ruby";
  if (filePath.endsWith(".php")) return "php";
  if (filePath.endsWith(".swift")) return "swift";
  if (filePath.endsWith(".cs")) return "csharp";
  return "unknown";
}
