/**
 * Path Sandbox — Filesystem Boundary Enforcement
 *
 * Restricts agent file operations to the project root and a curated set of
 * external paths required by IDE tooling (~/.claude, ~/.cursor, etc.).
 *
 * Deny list takes priority over allow list. Allow list takes priority over
 * the implicit "everything else is blocked" default. The project root
 * always has full read+write access regardless of other rules.
 *
 * Design:
 *   - Project root is the sandbox root and always wins
 *   - ~/.claude/** is read-allowed (plans, settings, history, CLAUDE.md)
 *   - ~/.claude/plans/**, ~/.claude/settings.json are write-allowed
 *   - Other projects' CLAUDE.md / .cursorrules / AGENTS.md are blocked
 *   - System paths (/etc, /usr, /var, /proc, /sys) are always blocked
 *   - Traversal attacks (../../) resolved before matching
 *
 * If a path is blocked, the caller gets a structured reason for the
 * governor to inject as a tool-call error.
 */

import path from "node:path";
import os from "node:os";

export type PathOperation = "read" | "write";

export interface PathSandboxPolicy {
  projectRoot: string;
  homeDir: string;
  allowedReadGlobs: string[];
  allowedWriteGlobs: string[];
  blockedGlobs: string[];
}

export interface PathSandboxResult {
  allowed: boolean;
  reason: string;
  resolvedPath: string;
  nudge?: string;
}

const HOME_PLACEHOLDER = "~";

function expandHome(pattern: string, homeDir: string): string {
  if (pattern.startsWith("~/")) return path.join(homeDir, pattern.slice(2));
  if (pattern === "~") return homeDir;
  return pattern;
}

function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const rel = filePath.startsWith(prefix + "/") ? filePath.slice(prefix.length + 1) : null;
    return rel !== null && !rel.includes("/");
  }
  return filePath === pattern;
}

function isUnderDirectory(filePath: string, dir: string): boolean {
  const norm = dir.endsWith("/") ? dir : dir + "/";
  return filePath === dir || filePath.startsWith(norm);
}

// Patterns for agent config files that should only be read from the project root
const AGENT_CONFIG_NAMES = new Set([
  "claude.md", "CLAUDE.md", "Claude.md",
  ".cursorrules", "cursorrules",
  "AGENTS.md", "agents.md",
  ".windsurfrules",
  "CONVENTIONS.md",
  "RULES.md",
]);

function isAgentConfigFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return AGENT_CONFIG_NAMES.has(base);
}

/**
 * Derive a safe `/tmp` subdirectory name from the project root.
 * e.g. `/Users/me/src/myproject` → `myproject`
 */
export function projectTmpDir(projectRoot: string): string {
  const base = path.basename(path.resolve(projectRoot));
  return `/tmp/${base || "synesis-scratch"}`;
}

export function buildDefaultPolicy(projectRoot: string): PathSandboxPolicy {
  const homeDir = os.homedir();
  return {
    projectRoot: path.resolve(projectRoot),
    homeDir,
    allowedReadGlobs: [
      `${projectRoot}/**`,
      "~/.claude/**",
      "~/.cursor/**",
      "~/.config/opencode/**",
      "~/.vscode/**",
      "~/.local/share/code-server/**",
      "/tmp/**",
    ],
    allowedWriteGlobs: [
      `${projectRoot}/**`,
      "~/.claude/plans/**",
      "~/.claude/settings.json",
      "~/.claude/history/**",
      "/tmp/**",
    ],
    blockedGlobs: [
      "/etc/**",
      "/usr/**",
      "/var/**",
      "/proc/**",
      "/sys/**",
      "/dev/**",
      "/private/var/**",
      "/private/etc/**",
      "/System/**",
      "/Library/**",
    ],
  };
}

export function evaluatePathAccess(
  rawPath: string,
  operation: PathOperation,
  policy: PathSandboxPolicy,
): PathSandboxResult {
  const { projectRoot, homeDir } = policy;
  const expanded = expandHome(rawPath.trim(), homeDir);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(projectRoot, expanded);
  const normalized = resolved.replace(/\\/g, "/");

  // 1. Always allow project root
  if (isUnderDirectory(normalized, projectRoot)) {
    return { allowed: true, reason: "project_root", resolvedPath: normalized };
  }

  // 2. Block system paths (deny list takes priority)
  for (const glob of policy.blockedGlobs) {
    const expandedGlob = expandHome(glob, homeDir);
    if (matchesGlob(normalized, expandedGlob)) {
      return {
        allowed: false,
        reason: `blocked_system_path: ${glob}`,
        resolvedPath: normalized,
      };
    }
  }

  // 3. Block agent config files from other projects
  if (isAgentConfigFile(normalized) && !isUnderDirectory(normalized, projectRoot)) {
    const inDotClaude = isUnderDirectory(normalized, path.join(homeDir, ".claude"));
    if (!inDotClaude) {
      return {
        allowed: false,
        reason: "cross_project_agent_config",
        resolvedPath: normalized,
        nudge: `Reading agent config from outside the project is blocked for safety. If you need a ${path.basename(normalized)}, place it inside your project root at ${projectRoot}/${path.basename(normalized)}.`,
      };
    }
  }

  // 4. Block reads from other users' home directories
  const usersPattern = /^\/(Users|home)\/([^/]+)/;
  const usersMatch = usersPattern.exec(normalized);
  if (usersMatch) {
    const targetHome = `/${usersMatch[1]}/${usersMatch[2]}`;
    if (targetHome !== homeDir && !isUnderDirectory(normalized, projectRoot)) {
      return {
        allowed: false,
        reason: "other_user_home",
        resolvedPath: normalized,
      };
    }
  }

  // 5. Check allow lists
  const allowGlobs = operation === "write" ? policy.allowedWriteGlobs : policy.allowedReadGlobs;
  for (const glob of allowGlobs) {
    const expandedGlob = expandHome(glob, homeDir);
    if (matchesGlob(normalized, expandedGlob)) {
      const result: PathSandboxResult = { allowed: true, reason: `allowed_${operation}: ${glob}`, resolvedPath: normalized };
      // Nudge /tmp usage toward a project-scoped subdirectory
      if (normalized.startsWith("/tmp/")) {
        const scopedDir = projectTmpDir(projectRoot);
        if (!normalized.startsWith(scopedDir + "/") && normalized !== scopedDir) {
          result.nudge = `Prefer using ${scopedDir}/ for temp files to avoid collisions with other projects.`;
        }
      }
      return result;
    }
  }

  // 6. Path traversal detection: anything that resolved outside project root
  //    and isn't in an explicit allow list
  const rel = path.relative(projectRoot, normalized);
  if (rel.startsWith("..")) {
    return {
      allowed: false,
      reason: "outside_sandbox",
      resolvedPath: normalized,
      nudge: `File access outside the project root (${projectRoot}) requires an explicit allowlist entry. Use files within the project or ~/.claude/ instead.`,
    };
  }

  return {
    allowed: false,
    reason: "not_in_allowlist",
    resolvedPath: normalized,
  };
}

/**
 * Extract file paths from a Bash command for sandbox checking.
 * Returns paths that appear as arguments to file-operating commands.
 */
export function extractBashFilePaths(command: string): string[] {
  const paths: string[] = [];

  // cat/head/tail/less/more with file args
  const fileReadCmd = /\b(?:cat|head|tail|less|more|source|\.)\s+([^\s|;&><]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fileReadCmd.exec(command)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, "");
    if (p && !p.startsWith("-")) paths.push(p);
  }

  // Redirect writes: > or >> file
  const redirectWrite = />{1,2}\s*([^\s|;&]+)/g;
  while ((m = redirectWrite.exec(command)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, "");
    if (p && !p.startsWith("-") && !p.startsWith("&")) paths.push(p);
  }

  // cp/mv source and destination
  const cpMv = /\b(?:cp|mv)\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)\s+([^\s|;&]+)/g;
  while ((m = cpMv.exec(command)) !== null) {
    paths.push(m[1].replace(/^["']|["']$/g, ""));
    paths.push(m[2].replace(/^["']|["']$/g, ""));
  }

  return paths.filter((p) => p.length > 0 && p !== "." && p !== "..");
}
