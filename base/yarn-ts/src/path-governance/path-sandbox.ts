/** Lexical defense in depth for client paths. The execution host must enforce
 * real filesystem permissions (including symlinks); a proxy cannot do that. */
import path from "node:path";
import { hasControlCharacter, isPathInsideRoot, normalizeAbsolutePathHint } from "./path-hints.js";

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

function clientPaths(root: string) {
  return root.startsWith("/") ? path.posix : path.win32;
}

function expandHome(value: string, home: string): string | null {
  if (!/^~(?:[\\/]|$)/.test(value)) return value;
  if (!normalizeAbsolutePathHint(home)) return null;
  return clientPaths(home).join(home, value.slice(2));
}

function matchesGlob(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return isPathInsideRoot(file, pattern.slice(0, -3));
  if (pattern.endsWith("/*")) {
    const root = pattern.slice(0, -2);
    return isPathInsideRoot(file, root) && clientPaths(root).dirname(file) === root;
  }
  return isPathInsideRoot(file, pattern) && isPathInsideRoot(pattern, file);
}

/** A suggested location, never an implicit access grant. */
export function projectTmpDir(projectRoot: string): string {
  return `/tmp/${clientPaths(projectRoot).basename(projectRoot) || "synesis-scratch"}`;
}

/** Additional grants must come from trusted deployment policy, never client identity.
 * No proxy HOME/TMPDIR or blanket harness settings/credentials access is inherited. */
export function buildDefaultPolicy(
  projectRoot: string,
  grants: Partial<Omit<PathSandboxPolicy, "projectRoot">> = {},
): PathSandboxPolicy {
  return {
    projectRoot: normalizeAbsolutePathHint(projectRoot) ?? "",
    homeDir: grants.homeDir ?? "",
    allowedReadGlobs: [...(grants.allowedReadGlobs ?? [])],
    allowedWriteGlobs: [...(grants.allowedWriteGlobs ?? [])],
    blockedGlobs: [...(grants.blockedGlobs ?? [])],
  };
}

export function evaluatePathAccess(rawPath: string, operation: PathOperation, policy: PathSandboxPolicy): PathSandboxResult {
  const root = normalizeAbsolutePathHint(policy.projectRoot);
  const expanded = expandHome(rawPath, policy.homeDir);
  if (!root || expanded === null || hasControlCharacter(rawPath)) {
    return { allowed: false, reason: "unknown_or_invalid_path_context", resolvedPath: rawPath };
  }
  const paths = clientPaths(root);
  // A fully qualified foreign path is not a relative child of the workspace.
  const absolute = normalizeAbsolutePathHint(expanded);
  const resolved = absolute ?? paths.resolve(root, expanded);
  if (resolved === "/dev/null") return { allowed: true, reason: "null_device", resolvedPath: resolved };
  const matches = (glob: string) => {
    const pattern = expandHome(glob, policy.homeDir);
    return pattern !== null && matchesGlob(resolved, pattern);
  };
  if (policy.blockedGlobs.some(matches)) {
    return { allowed: false, reason: "explicit_deny", resolvedPath: resolved };
  }
  if (isPathInsideRoot(resolved, root)) {
    return { allowed: true, reason: "project_root", resolvedPath: resolved };
  }
  const grants = operation === "write" ? policy.allowedWriteGlobs : policy.allowedReadGlobs;
  if (grants.some(matches)) return { allowed: true, reason: `allowed_${operation}`, resolvedPath: resolved };
  return { allowed: false, reason: "outside_allowed_roots", resolvedPath: resolved,
    nudge: "Use the intended workspace or an explicitly configured allowed path. Do not relocate the operation to bypass a denial." };
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
