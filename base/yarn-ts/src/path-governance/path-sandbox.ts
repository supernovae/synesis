/**
 * Path Sandbox — Filesystem Boundary Enforcement
 *
 * Restricts agent file operations to the project root and a curated set of
 * external paths required by IDE/agent tooling.
 *
 * Deny list takes priority over allow list. Allow list takes priority over
 * the implicit "everything else is blocked" default. The project root
 * always has full read+write access regardless of other rules.
 *
 * Harness compatibility matrix (researched Apr 2026):
 *
 *   Claude Code   ~/.claude/**              /tmp/claude, /private/tmp/claude
 *   Cursor        ~/.cursor/**              (no dedicated temp)
 *   Gemini CLI    ~/.gemini/**              ~/.gemini/tmp/
 *   Codex CLI     ~/.codex/**               $TMPDIR, /tmp
 *   OpenCode      ~/.config/opencode/**     OPENCODE_STATE_DIR / OPENCODE_CACHE_DIR
 *   Windsurf      ~/.codeium/**             (no dedicated temp)
 *   Aider         ~/.aider/**               (no dedicated temp)
 *   VS Code       ~/.vscode/**              (no dedicated temp)
 *   code-server   ~/.local/share/code-server/**
 *
 * macOS note: $TMPDIR resolves to /private/var/folders/.../T/ which is
 * separate from /tmp. Both are allowed for read+write.
 *
 * Design:
 *   - Project root is the sandbox root and always wins
 *   - All harness config dirs above are read-allowed
 *   - Harness-specific write paths are individually listed
 *   - /tmp/**, /private/tmp/**, and $TMPDIR are read+write allowed
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

// Agent config files that should only be read from the project root or
// their harness's own config dir — never from a sibling project.
const AGENT_CONFIG_NAMES = new Set([
  "claude.md", "CLAUDE.md", "Claude.md",
  ".cursorrules", "cursorrules",
  "AGENTS.md", "agents.md",
  ".windsurfrules",
  ".gemini",        // Gemini CLI config dir (at project root)
  "GEMINI.md",
  ".aider.conf.yml",
  "CONVENTIONS.md",
  "RULES.md",
]);

function isAgentConfigFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return AGENT_CONFIG_NAMES.has(base);
}

/** Home-level harness config directories where agent configs are legitimate. */
const HARNESS_CONFIG_DIRS = [
  "~/.claude",
  "~/.cursor",
  "~/.gemini",
  "~/.codex",
  "~/.config/opencode",
  "~/.codeium",
  "~/.aider",
];

/**
 * Derive a safe `/tmp` subdirectory name from the project root.
 * e.g. `/Users/me/src/myproject` → `myproject`
 */
export function projectTmpDir(projectRoot: string): string {
  const base = path.basename(path.resolve(projectRoot));
  return `/tmp/${base || "synesis-scratch"}`;
}

/**
 * Resolve the macOS $TMPDIR (e.g. /private/var/folders/xx/yy/T/) so we
 * can allowlist it alongside /tmp.  Returns null on non-Darwin or if
 * $TMPDIR is already under /tmp.
 */
function resolveSessionTmpDir(): string | null {
  const envTmp = process.env.TMPDIR;
  if (!envTmp) return null;
  const resolved = path.resolve(envTmp);
  if (resolved.startsWith("/tmp")) return null;
  return resolved;
}

export function buildDefaultPolicy(projectRoot: string): PathSandboxPolicy {
  const homeDir = os.homedir();

  // Harness config directories — read-only access for all major agents/IDEs
  const harnessReadGlobs = [
    "~/.claude/**",           // Claude Code
    "~/.cursor/**",           // Cursor IDE
    "~/.gemini/**",           // Gemini CLI
    "~/.codex/**",            // Codex CLI (OpenAI)
    "~/.config/opencode/**",  // OpenCode
    "~/.codeium/**",          // Windsurf / Codeium
    "~/.aider/**",            // Aider
    "~/.vscode/**",           // VS Code
    "~/.local/share/code-server/**",  // code-server
  ];

  // Harness-specific write paths — only the subdirs that agents actually
  // need to modify outside the project root
  const harnessWriteGlobs = [
    // Claude Code
    "~/.claude/plans/**",
    "~/.claude/settings.json",
    "~/.claude/settings.local.json",
    "~/.claude/history/**",
    // Gemini CLI tool temp
    "~/.gemini/tmp/**",
  ];

  // Temp directories — agents write build output, captured logs, etc.
  // Claude Code hardcodes /tmp/claude and /private/tmp/claude.
  // Codex CLI uses $TMPDIR (macOS: /private/var/folders/.../T/).
  const tmpGlobs = [
    "/tmp/**",
    "/private/tmp/**",        // macOS symlink target for /tmp
  ];
  const sessionTmp = resolveSessionTmpDir();
  if (sessionTmp) {
    tmpGlobs.push(`${sessionTmp}/**`);
  }

  return {
    projectRoot: path.resolve(projectRoot),
    homeDir,
    allowedReadGlobs: [
      `${projectRoot}/**`,
      ...harnessReadGlobs,
      ...tmpGlobs,
    ],
    allowedWriteGlobs: [
      `${projectRoot}/**`,
      ...harnessWriteGlobs,
      ...tmpGlobs,
    ],
    blockedGlobs: [
      "/etc/**",
      "/usr/**",
      "/var/**",
      "/proc/**",
      "/sys/**",
      "/dev/**",
      // /private/var is blocked but /private/tmp is allowed (order matters:
      // deny list is checked before allow list, so we carve /private/tmp out
      // via the allow list and keep /private/var blocked).
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

  // 2. Allow explicitly listed paths before deny list — handles $TMPDIR
  //    on macOS which lives under /private/var/folders/… (a deny-listed
  //    prefix).  This carve-out prevents false blocks for session temp dirs.
  const allowGlobsAll = [...policy.allowedReadGlobs, ...policy.allowedWriteGlobs];
  const isExplicitlyAllowed = allowGlobsAll.some((glob) => {
    const expandedGlob = expandHome(glob, homeDir);
    return matchesGlob(normalized, expandedGlob);
  });

  // 3. Block system paths (deny list) — but only if the path isn't
  //    in an explicit allow list (allows $TMPDIR carve-out)
  if (!isExplicitlyAllowed) {
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
  }

  // 4. Block agent config files from other projects
  if (isAgentConfigFile(normalized) && !isUnderDirectory(normalized, projectRoot)) {
    const inHarnessConfigDir = HARNESS_CONFIG_DIRS.some((dir) =>
      isUnderDirectory(normalized, expandHome(dir, homeDir)),
    );
    if (!inHarnessConfigDir) {
      return {
        allowed: false,
        reason: "cross_project_agent_config",
        resolvedPath: normalized,
        nudge: `Reading agent config from outside the project is blocked for safety. If you need a ${path.basename(normalized)}, place it inside your project root at ${projectRoot}/${path.basename(normalized)}.`,
      };
    }
  }

  // 5. Block reads from other users' home directories
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

  // 6. Check allow lists
  const allowGlobs = operation === "write" ? policy.allowedWriteGlobs : policy.allowedReadGlobs;
  for (const glob of allowGlobs) {
    const expandedGlob = expandHome(glob, homeDir);
    if (matchesGlob(normalized, expandedGlob)) {
      const result: PathSandboxResult = { allowed: true, reason: `allowed_${operation}: ${glob}`, resolvedPath: normalized };
      // Nudge /tmp usage toward a project-scoped subdirectory.
      // Applies to /tmp, /private/tmp, and $TMPDIR paths.
      const isTmpPath = normalized.startsWith("/tmp/") || normalized.startsWith("/private/tmp/");
      if (isTmpPath) {
        const scopedDir = projectTmpDir(projectRoot);
        if (!normalized.startsWith(scopedDir + "/") && normalized !== scopedDir) {
          result.nudge = `Prefer using ${scopedDir}/ for temp files to avoid collisions with other projects.`;
        }
      }
      return result;
    }
  }

  // 7. Path traversal detection: anything that resolved outside project root
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

  // Directory navigation/discovery. These are read-like filesystem accesses
  // and must not escape the project root via `..` or absolute parent paths.
  const cdCmd = /(?:^|[;&|]\s*)cd\s+([^\s|;&><]+)/g;
  let m: RegExpExecArray | null;
  while ((m = cdCmd.exec(command)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, "");
    if (p && !p.startsWith("-")) paths.push(p);
  }

  const lsCmd = /(?:^|[;&|]\s*)ls(?:\s+-[A-Za-z0-9-]+)*\s+([^\s|;&><]+)/g;
  while ((m = lsCmd.exec(command)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, "");
    if (p && !p.startsWith("-")) paths.push(p);
  }

  const findCmd = /(?:^|[;&|]\s*)find\s+([^\s|;&><]+)/g;
  while ((m = findCmd.exec(command)) !== null) {
    const p = m[1].replace(/^["']|["']$/g, "");
    if (p && !p.startsWith("-")) paths.push(p);
  }

  // cat/head/tail/less/more with file args
  const fileReadCmd = /\b(?:cat|head|tail|less|more|source|\.)\s+([^\s|;&><]+)/g;
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

  return paths.filter((p) => p.length > 0 && p !== ".");
}
