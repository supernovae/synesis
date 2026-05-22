/**
 * Reusable code integrity checks — TypeScript port of integrity_core.py.
 * Pure functions; no framework dependency.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

import path from "node:path";

export class IntegrityResult {
  constructor(
    public category: string = "path",
    public evidence: string = "",
    public remediation: string = "",
  ) {}
}

export class IntegrityReport {
  passed = true;
  failures: IntegrityResult[] = [];

  add(failure: IntegrityResult | null | undefined): void {
    if (failure != null) {
      this.passed = false;
      this.failures.push(failure);
    }
  }
}

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

const _SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|password|token)\s*=\s*['"]?[a-zA-Z0-9_-]{8,}['"]?/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/m,
  /-----BEGIN\s+[A-Z]+\s+PRIVATE\s+KEY-----/m,
];

function maskSecretEvidence(value: string): string {
  return value.replace(/(=)\s*['"]?[a-zA-Z0-9_-]{4,}/g, "$1 ***").replace(/-----BEGIN[\s\S]+?PRIVATE KEY-----/g, "-----BEGIN *** PRIVATE KEY-----");
}

export function checkSecrets(code: string): IntegrityResult | null {
  for (const pat of _SECRET_PATTERNS) {
    const m = code.match(pat);
    if (m) {
      const line = code.slice(0, m.index).split("\n").length;
      const masked = maskSecretEvidence(m[0]);
      const snippet = masked.length > 80 ? `${masked.slice(0, 80)}...` : masked;
      return new IntegrityResult(
        "secret",
        `Line ~${line}: ${snippet}`,
        "Remove the hardcoded API key/secret and use environment variables.",
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Network egress
// ---------------------------------------------------------------------------

const _NETWORK_MODULES_FIRST = new Set(["requests", "urllib", "urllib3", "socket", "httpx"]);

const _NETWORK_BASH_TOKENS = ["curl ", "wget ", "nc ", "netcat ", "/dev/tcp/"] as const;

const _NETWORK_JS: RegExp[] = [/\bfetch\s*\(/, /\baxios\.(get|post|create)\s*\(/, /\brequire\s*\(\s*['"]https?:\/\//];

/** Regex approximation of Python AST import / call checks for network APIs. */
const _PYTHON_NETWORK_IMPORT =
  /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/;

const _PYTHON_NETWORK_CALL_PATTERNS: RegExp[] = [
  /\brequests\.(get|post|put|delete|request|head|patch)\s*\(/,
  /\burllib\.request\.(urlopen|Request)\s*\(/,
  /\burllib3\.request\s*\(/,
  /\bsocket\.(connect|create_connection|connect_ex)\s*\(/,
  /\bhttpx\.(get|post)\s*\(/,
  /\bhttpx\.(AsyncClient|Client)\s*\(/,
  /\bhttp\.client\.(HTTPConnection|HTTPSConnection)\s*\(/,
];

function _stripSingleLineComment(line: string, lang: string): string {
  if (["bash", "shell", "sh", "python", "py"].includes(lang)) {
    return line.split("#")[0] ?? "";
  }
  if (["javascript", "typescript", "js", "ts"].includes(lang)) {
    return line.split("//")[0] ?? "";
  }
  return line;
}

function _isLikelyCommentOrString(line: string, lang: string): boolean {
  const stripped = line.trim();
  if (!stripped) return true;
  if (["python", "py"].includes(lang)) {
    if (stripped.startsWith('"""') || stripped.startsWith("'''") || stripped.startsWith("#")) {
      return true;
    }
  }
  if (["bash", "shell", "sh"].includes(lang) && stripped.startsWith("#")) {
    return true;
  }
  if (["javascript", "typescript", "js", "ts"].includes(lang)) {
    if (stripped.startsWith("//") || stripped.startsWith("*")) {
      return true;
    }
  }
  return false;
}

function _stripStringsBashJs(line: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const end = c;
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === end) {
          i += 1;
          break;
        }
        i += 1;
      }
      result.push(" ");
      continue;
    }
    result.push(c);
    i += 1;
  }
  return result.join("");
}

function _firstModSegment(name: string): string {
  return name.trim().split(".")[0] ?? "";
}

function _splitAliasTarget(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  const asIdx = lowered.indexOf(" as ");
  return asIdx >= 0 ? trimmed.slice(0, asIdx).trim() : trimmed;
}

function _parsePythonImportLine(line: string): string[] {
  const m = line.match(_PYTHON_NETWORK_IMPORT);
  if (!m) return [];
  if (m[1]) {
    return [m[1].trim()];
  }
  const block = (m[2] ?? "").trim();
  if (!block) return [];
  return block.split(",").map((s) => _firstModSegment(_splitAliasTarget(s)));
}

function _checkNetworkPythonRegex(code: string): IntegrityResult | null {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (_isLikelyCommentOrString(raw, "python")) continue;
    let codePart = _stripSingleLineComment(raw, "python");
    codePart = _stripStringsBashJs(codePart);

    const importedRoots = _parsePythonImportLine(codePart.trim());
    for (const modPath of importedRoots) {
      if (!modPath) continue;
      const first = _firstModSegment(modPath);
      if (modPath.startsWith("http.client") || modPath === "http.client") {
        return new IntegrityResult(
          "network",
          `Line ~${i + 1}: import / from ${modPath}`,
          `Package '${modPath}' makes network calls. Use internal MockClient or declare as external tool requirement.`,
        );
      }
      if (_NETWORK_MODULES_FIRST.has(first) || _NETWORK_MODULES_FIRST.has(modPath)) {
        return new IntegrityResult(
          "network",
          `Line ~${i + 1}: import / from ${modPath}`,
          `Package '${modPath}' makes network calls. Use internal MockClient or declare as external tool requirement.`,
        );
      }
    }

    for (const pat of _PYTHON_NETWORK_CALL_PATTERNS) {
      const m = codePart.match(pat);
      if (m) {
        const symbol = m[0].trim().slice(0, 60);
        return new IntegrityResult(
          "network",
          `Line ~${i + 1}: ${symbol}`,
          `Call '${symbol.slice(0, 40)}' makes network calls. Use internal MockClient or declare as external tool requirement.`,
        );
      }
    }
  }
  return null;
}

export function checkNetwork(code: string, language: string): IntegrityResult | null {
  const lang = (language || "bash").toLowerCase();
  if (lang === "python" || lang === "py") {
    return _checkNetworkPythonRegex(code);
  }
  const isShell = ["bash", "shell", "sh"].includes(lang);
  const patterns = _NETWORK_JS;
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (_isLikelyCommentOrString(line, lang)) continue;
    let codePart = _stripSingleLineComment(line, lang);
    codePart = _stripStringsBashJs(codePart);
    if (isShell) {
      const lowered = ` ${codePart.toLowerCase()} `;
      const token = _NETWORK_BASH_TOKENS.find((t) => lowered.includes(t));
      const hasSubshellCurl = lowered.includes("$(") && lowered.includes("curl");
      if (token || hasSubshellCurl) {
        const symbol = token ?? "$( ... curl ... )";
        return new IntegrityResult(
          "network",
          `Line ~${i + 1}: ${symbol.slice(0, 60)}`,
          `Call '${symbol.slice(0, 40)}' makes network calls. Use internal MockClient or declare as external tool requirement.`,
        );
      }
      continue;
    }
    for (const pat of patterns) {
      const m = codePart.match(pat);
      if (!m) continue;
      const symbol = m[0].trim();
      return new IntegrityResult(
        "network",
        `Line ~${i + 1}: ${symbol.slice(0, 60)}`,
        `Call '${symbol.slice(0, 40)}' makes network calls. Use internal MockClient or declare as external tool requirement.`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------

export function checkDangerousCommands(code: string, language: string): IntegrityResult | null {
  const lang = (language || "bash").toLowerCase();
  if (!["bash", "shell", "sh"].includes(lang)) return null;
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (_isLikelyCommentOrString(line, lang)) continue;
    const codePart = _stripSingleLineComment(line, lang).toLowerCase();
    const trimmed = codePart.trim();
    if (trimmed.includes("rm -rf ") || trimmed.includes("rm --recursive ")) {
      return new IntegrityResult(
        "dangerous",
        `Line ~${i + 1}: ${trimmed.slice(0, 60)}`,
        "Remove rm -rf, curl|bash, or fork bombs. Use safer alternatives.",
      );
    }
    const hasPipeToShell =
      (trimmed.includes("curl") || trimmed.includes("wget"))
      && trimmed.includes("|")
      && (trimmed.includes("| bash") || trimmed.includes("| sh"));
    if (hasPipeToShell || trimmed.includes(":(){ :|")) {
      return new IntegrityResult(
        "dangerous",
        `Line ~${i + 1}: ${trimmed.slice(0, 60)}`,
        "Remove rm -rf, curl|bash, or fork bombs. Use safer alternatives.",
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

export function checkMaxSize(code: string, limit = 100_000): IntegrityResult | null {
  if (code.length > limit) {
    return new IntegrityResult(
      "size",
      `Code length ${code.length} exceeds limit ${limit}`,
      "Produce a shorter script or split into smaller units.",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const _PATH_DENYLIST_REGEX = /\b\S+\.lock\b/i;
const _DEFAULT_DENYLIST = [
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "pnpm-lock.yaml",
] as const;

function _hasWriteIndicator(line: string): boolean {
  const lowered = ` ${line.toLowerCase()} `;
  return lowered.includes(" >")
    || lowered.includes(" >>")
    || lowered.includes(" cp ")
    || lowered.includes(" mv ")
    || (lowered.includes(" sed ") && lowered.includes(" -i"));
}

export function checkPathDenylist(
  code: string,
  denylist: readonly string[] = _DEFAULT_DENYLIST,
): IntegrityResult | null {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!_hasWriteIndicator(line)) continue;
    for (const name of denylist) {
      if (line.includes(name)) {
        return new IntegrityResult(
          "path",
          `Line ~${i + 1}: ${line.trim().slice(0, 60)}`,
          "Remove edits to lockfiles (package-lock.json, yarn.lock, etc.).",
        );
      }
    }
    if (_PATH_DENYLIST_REGEX.test(line)) {
      return new IntegrityResult(
        "path",
        `Line ~${i + 1}: ${line.trim().slice(0, 60)}`,
        "Remove edits to denylisted paths.",
      );
    }
  }
  return null;
}

const _ALLOWED_PATCH_OPS = new Set(["add", "modify", "delete", "create", "update"]);

export interface PatchOpInput {
  path?: string;
  op?: string;
  text?: string;
  content?: string;
}

function _patchOpPath(op: PatchOpInput): string {
  return typeof op.path === "string" ? op.path : "";
}

function _patchOpType(op: PatchOpInput): string {
  const t = op.op ?? "modify";
  return t || "modify";
}

function _patchOpText(op: PatchOpInput): string {
  return (op.text ?? op.content ?? "") || "";
}

export function checkPatchOpConstraints(patchOps: PatchOpInput[]): IntegrityResult | null {
  if (!patchOps.length) return null;
  for (const op of patchOps) {
    const path = _patchOpPath(op);
    const opType = _patchOpType(op);
    if (!_ALLOWED_PATCH_OPS.has(opType)) {
      return new IntegrityResult(
        "path",
        `Invalid op '${opType}' for path ${path}`,
        "Use only add, modify, or delete. No line-range edits.",
      );
    }
    if (path.includes("..") || path.includes("//")) {
      return new IntegrityResult(
        "path",
        `Path traversal: ${path}`,
        "Use relative paths under workspace. No '../' or '//'. Absolute paths validated by workspace boundary.",
      );
    }
    const text = _patchOpText(op);
    if (text && (text.includes("ln -s") || text.includes("ln -s\t"))) {
      return new IntegrityResult(
        "path",
        `Symlink creation (ln -s) in patch content for ${path}`,
        "Forbid symlink creation. Use regular files only.",
      );
    }
  }
  return null;
}

export function checkWorkspaceBoundary(
  filesTouched: string[],
  patchOps: PatchOpInput[],
  targetWorkspace: string,
): IntegrityResult | null {
  if (!targetWorkspace || !targetWorkspace.trim()) return null;
  let prefix = path.posix.normalize(targetWorkspace.replaceAll("\\", "/"));
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  while (prefix.endsWith("/") && prefix.length > 1) {
    prefix = prefix.slice(0, -1);
  }
  if (!prefix) return null;

  const paths: string[] = [];
  for (const ft of filesTouched ?? []) {
    const p = (ft ?? "").trim();
    if (p && !p.startsWith("#")) paths.push(p);
  }
  for (const op of patchOps ?? []) {
    const path = _patchOpPath(op).trim();
    if (path) paths.push(path);
  }

  for (const p of paths) {
    if (!p) continue;
    const normalizedPath = path.posix.normalize(p.replaceAll("\\", "/"));
    const norm = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
    if (!norm.startsWith(`${prefix}/`) && norm !== prefix) {
      return new IntegrityResult(
        "workspace",
        `Path ${p} is outside target_workspace ${targetWorkspace}`,
        "All paths must be under the workspace root.",
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import integrity / Python syntax — skipped (no Python AST in TS)
// ---------------------------------------------------------------------------

export function checkImportIntegrity(
  _code: string,
  _language: string,
  _trustedPackages?: Set<string> | null,
): IntegrityResult | null {
  return null;
}

export function checkPythonSyntax(_code: string, _language: string): IntegrityResult | null {
  return null;
}

// ---------------------------------------------------------------------------
// UTF-8 validation
// ---------------------------------------------------------------------------

export function checkUtf8(code: string): IntegrityResult | null {
  const illFormed = (): IntegrityResult =>
    new IntegrityResult(
      "binary",
      "Invalid UTF-8 or binary content",
      "Produce valid UTF-8 text only. No binary edits.",
    );
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= code.length) return illFormed();
      const d = code.charCodeAt(i + 1);
      if (d < 0xdc00 || d > 0xdfff) return illFormed();
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return illFormed();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Experiment commands
// ---------------------------------------------------------------------------

const _HIGH_RISK_EXPERIMENT_CMDS = [
  "pip install",
  "pip3 install",
  "npm install",
  "yarn add",
  "go get",
  "cargo add",
] as const;

export function checkExperimentCommands(commands: string[]): IntegrityResult | null {
  for (const cmd of commands ?? []) {
    const c = (cmd ?? "").trim().toLowerCase();
    for (const risky of _HIGH_RISK_EXPERIMENT_CMDS) {
      if (c.includes(risky.toLowerCase())) {
        return new IntegrityResult(
          "dangerous",
          `High-risk command: ${(cmd ?? "").slice(0, 80)}`,
          "Experiments may not run pip install, npm install, go get, etc. Use pre-installed deps.",
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// run_all_checks
// ---------------------------------------------------------------------------

export function runAllChecks(
  code: string,
  language = "python",
  patchOps: PatchOpInput[] | null = null,
  filesTouched: string[] | null = null,
  targetWorkspace = "",
  commands: string[] | null = null,
  trustedPackages: Set<string> | null = null,
  maxCodeChars = 100_000,
): IntegrityReport {
  const report = new IntegrityReport();
  const ops = patchOps ?? [];

  report.add(checkWorkspaceBoundary(filesTouched ?? [], ops, targetWorkspace));
  report.add(checkPatchOpConstraints(ops));
  report.add(checkMaxSize(code, maxCodeChars));
  report.add(checkPathDenylist(code));
  report.add(checkImportIntegrity(code, language, trustedPackages));
  report.add(checkUtf8(code));
  report.add(checkSecrets(code));
  report.add(checkNetwork(code, language));
  report.add(checkDangerousCommands(code, language));
  report.add(checkPythonSyntax(code, language));

  if (commands?.length) {
    report.add(checkExperimentCommands(commands));
  }

  return report;
}
