import path from "node:path";

const PATH_HINT_MAX_CHARS = 4096;

function isAbsolutePathHint(value: string): boolean {
  return value.startsWith("/") || /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}

function isFilesystemRoot(value: string): boolean {
  if (value.startsWith("/")) {
    return path.posix.resolve(value) === "/";
  }
  if (!path.win32.isAbsolute(value)) {
    return false;
  }
  const normalized = path.win32.normalize(value);
  const parsed = path.win32.parse(normalized);
  return normalized.toLowerCase() === parsed.root.toLowerCase();
}

export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function normalizeAbsolutePathHint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length > PATH_HINT_MAX_CHARS) return null;
  if (hasControlCharacter(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isAbsolutePathHint(trimmed)) return null;
  if (isFilesystemRoot(trimmed)) return null;
  if (trimmed.startsWith("/")) return path.posix.resolve(trimmed);
  return path.win32.normalize(trimmed);
}

/** Lexical client-path comparison only: no proxy cwd, filesystem or symlink inference. */
export function isPathInsideRoot(resolvedFile: string, resolvedRoot: string): boolean {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(resolvedRoot);
  const fileWindows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(resolvedFile);
  if (windows !== fileWindows) return false;
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(resolvedFile) || !paths.isAbsolute(resolvedRoot)) return false;
  const relative = paths.relative(resolvedRoot, resolvedFile);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}
