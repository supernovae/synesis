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
}

export interface GovernedToolCall {
  toolName: string;
  input: Record<string, unknown>;
  normalizedPath: boolean;
  constrainedToRoot: boolean;
  blockedBashDrift: boolean;
  validationMissing: string[];
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

  if ((opts.blockBashPathDrift || opts.strictBashBlock) && logicalName === "Bash") {
    const command = out.input.command;
    if (typeof command === "string" && command.trim()) {
      const drift = detectBashPathDrift(command, opts.shellCwd);
      if (drift) {
        const msg = `Synesis Yarn blocked risky shell path drift: ${drift.reason}. Stay in the current project root and use relative paths.`;
        out.input = {
          command: `echo ${shellEscape(msg)} >&2; exit 2`,
          description: "Blocked risky mkdir/cd path drift",
        };
        out.blockedBashDrift = true;
      }
      const dangerous = detectDangerousBash(command);
      if (dangerous) {
        const msg = `Synesis Yarn blocked unsafe shell command: ${dangerous.reason}. Use safe structured tools from project root.`;
        out.input = {
          command: `echo ${shellEscape(msg)} >&2; exit 2`,
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
      const msg = `Synesis Yarn blocked invalid tool arguments for ${out.toolName}: missing ${validation.missing.join(", ")}`;
      out.toolName = "Bash";
      out.input = {
        command: `echo ${shellEscape(msg)} >&2; exit 2`,
        description: "Blocked invalid tool arguments",
      };
    }
  }
  return out;
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
