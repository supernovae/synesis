import path from "node:path";
import {
  constrainFileToolPathToProjectRoot,
  normalizeFileToolArgs,
  validateToolArgs,
} from "../providers/model-adapter.js";
import { canonicalValidationToolName } from "../tool-aliases.js";

export interface GovernToolCallOptions {
  toolName: string;
  input: Record<string, unknown>;
  projectRoot?: string | null;
  shellCwd?: string | null;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  strictBashBlock?: boolean;
  strictValidationBlock?: boolean;
  blockWriteCapableTools?: boolean;
}

export interface GovernedToolCall {
  toolName: string;
  input: Record<string, unknown>;
  normalizedPath: boolean;
  constrainedToRoot: boolean;
  blockedBashDrift: boolean;
  validationMissing: string[];
}

/** One-line JSON on stderr + exit 2 — parseable by agents (schema_version bumps are breaking). */
export function buildStructuredErrorBashCommand(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return `printf '%s\\n' ${shellEscape(json)} >&2; exit 2`;
}

export function governToolCall(opts: GovernToolCallOptions): GovernedToolCall {
  const logicalName = canonicalValidationToolName(opts.toolName);
  const out: GovernedToolCall = {
    toolName: opts.toolName,
    input: { ...opts.input },
    normalizedPath: false,
    constrainedToRoot: false,
    blockedBashDrift: false,
    validationMissing: [],
  };

  const pathNorm = normalizeFileToolArgs(logicalName, out.input);
  if (pathNorm.normalized) {
    out.input = pathNorm.input;
    out.normalizedPath = true;
  }

  const anchorRoot = resolvedAnchorRoot(opts.projectRoot, opts.shellCwd);
  if (opts.enforcePathRoot && anchorRoot) {
    const rootClamp = constrainFileToolPathToProjectRoot(anchorRoot, logicalName, out.input);
    if (rootClamp.constrained) {
      out.input = rootClamp.input;
      out.constrainedToRoot = true;
    }
  }

  if (opts.blockWriteCapableTools && isWriteCapableTool(logicalName)) {
    const message = `Synesis Yarn blocked write-capable tool '${logicalName}' for this client safety profile.`;
    out.toolName = "Bash";
    out.input = {
      command: buildStructuredErrorBashCommand({
        synesis_error: true,
        schema_version: 1,
        category: "policy",
        reason: "write_capable_blocked",
        original_tool: logicalName,
        message,
        retryable: false,
      }),
      description: "Blocked write-capable tool for safety profile",
    };
    out.blockedBashDrift = true;
    return out;
  }

  if ((opts.blockBashPathDrift || opts.strictBashBlock) && logicalName === "Bash") {
    const command = out.input.command;
    if (typeof command === "string" && command.trim()) {
      const rewritten = rewriteRedundantCdPrefix(command, opts.shellCwd);
      const effectiveCommand = rewritten?.rewrittenCommand ?? command;
      if (rewritten) {
        out.input = { ...out.input, command: effectiveCommand };
      }
      const drift = detectBashPathDrift(effectiveCommand, opts.shellCwd);
      if (drift) {
        const message = `Synesis Yarn blocked risky shell path drift: ${drift.reason}. Stay in the current project root and use relative paths.`;
        out.input = {
          command: buildStructuredErrorBashCommand({
            synesis_error: true,
            schema_version: 1,
            category: "policy",
            reason: "bash_path_drift",
            message,
            retryable: true,
          }),
          description: "Blocked risky mkdir/cd path drift",
        };
        out.blockedBashDrift = true;
      }
      const dangerous = detectDangerousBash(effectiveCommand);
      if (dangerous) {
        const message = `Synesis Yarn blocked unsafe shell command: ${dangerous.reason}. Use safe structured tools from project root.`;
        out.input = {
          command: buildStructuredErrorBashCommand({
            synesis_error: true,
            schema_version: 1,
            category: "policy",
            reason: "unsafe_shell",
            detail: dangerous.reason,
            message,
            retryable: true,
          }),
          description: "Blocked unsafe shell command",
        };
        out.blockedBashDrift = true;
      }
    }
  }

  const validation = validateToolArgs(logicalName, out.input);
  if (!validation.valid) {
    out.validationMissing = validation.missing;
    if (opts.strictValidationBlock !== false) {
      const human = `Synesis Yarn blocked invalid tool arguments for ${out.toolName}: missing ${validation.missing.join(", ")}`;
      out.toolName = "Bash";
      out.input = {
        command: buildStructuredErrorBashCommand({
          synesis_error: true,
          schema_version: 1,
          category: "validation",
          original_tool: logicalName,
          missing: validation.missing,
          message: human,
          hint: `Provide required fields (${validation.missing.join(", ")}) using exact parameter names from the tool schema (e.g. file_path and content for Write).`,
          retryable: true,
        }),
        description: "Blocked invalid tool arguments",
      };
    }
  }
  return out;
}

function isWriteCapableTool(logicalName: string): boolean {
  return logicalName === "Write"
    || logicalName === "Edit"
    || logicalName === "Update";
}

function resolvedAnchorRoot(projectRoot?: string | null, shellCwd?: string | null): string | null {
  const root = (projectRoot ?? "").trim();
  if (root) return root;
  const cwd = (shellCwd ?? "").trim();
  return cwd || null;
}

function detectBashPathDrift(command: string, shellCwd?: string | null): { reason: string } | null {
  const shellBase = normalizedBase(shellCwd);
  const mkdirCd = command.match(/mkdir(?:\s+-p)?\s+([^\s;&|]+)\s*&&\s*cd\s+([^\s;&|]+)/);
  if (mkdirCd) {
    const mkdirTarget = stripQuotes(mkdirCd[1]);
    const cdTarget = stripQuotes(mkdirCd[2]);
    if (mkdirTarget === cdTarget && shellBase && path.basename(mkdirTarget) === shellBase) {
      return { reason: `mkdir&&cd repeats current directory segment '${shellBase}'` };
    }
    if (hasDuplicateAdjacentSegment(mkdirTarget) || hasDuplicateAdjacentSegment(cdTarget)) {
      return { reason: "mkdir/cd target contains duplicated adjacent segments" };
    }
  }

  const cdMatches = command.matchAll(/(?:^|[;&|]\s*|\s+)cd\s+([^\s;&|]+)/g);
  for (const m of cdMatches) {
    const target = stripQuotes(m[1]);
    if (hasDuplicateAdjacentSegment(target)) {
      return { reason: `cd target '${target}' contains duplicated adjacent segments` };
    }
  }

  return null;
}

function detectDangerousBash(command: string): { reason: string } | null {
  const c = command.trim().toLowerCase();
  if (/(^|[;&|]\s*|\s+)cd\s+/.test(c)) {
    return { reason: "cd is disallowed in strict mode" };
  }
  if (/\brm\s+-rf\s+/.test(c)) {
    return { reason: "rm -rf is disallowed" };
  }
  if (/\bgit\s+clean\s+-f/.test(c)) {
    return { reason: "git clean -f is disallowed" };
  }
  if (/\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/.test(c)) {
    return { reason: "destructive system command detected" };
  }
  return null;
}

function rewriteRedundantCdPrefix(
  command: string,
  shellCwd?: string | null,
): { rewrittenCommand: string } | null {
  const cwd = (shellCwd ?? "").trim();
  if (!cwd) return null;
  const m = command.match(/^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+)$/);
  if (!m) return null;
  const cdTarget = stripQuotes(m[1]);
  const remainder = String(m[2] ?? "").trim();
  if (!cdTarget || !remainder) return null;
  const cwdAbs = path.resolve(cwd);
  const targetAbs = path.isAbsolute(cdTarget)
    ? path.resolve(cdTarget)
    : path.resolve(cwdAbs, cdTarget);
  if (targetAbs !== cwdAbs) return null;
  return { rewrittenCommand: remainder };
}

function normalizedBase(raw?: string | null): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const b = path.basename(t);
  return b && b !== "." && b !== ".." ? b : null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]+|['"`]+$/g, "").trim();
}

function hasDuplicateAdjacentSegment(rawPath: string): boolean {
  const cleaned = stripQuotes(rawPath).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const parts = cleaned
    .split("/")
    .filter((p) => p.length > 0 && p !== "." && p !== ".." && p !== "~")
    .map((p) => p.replace(/\*+$/g, ""));
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i] && parts[i] === parts[i - 1]) return true;
  }
  return false;
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
