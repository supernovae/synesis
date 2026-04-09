/**
 * Client Metadata Extractor
 *
 * Extracts structured session metadata from IDE client system messages.
 * Claude Code, Cursor, Windsurf, and similar IDEs embed project context
 * directly in the system prompt as structured blocks (<user_info>,
 * <open_and_recently_viewed_files>, etc.) rather than HTTP headers.
 *
 * This module parses those blocks to recover:
 *   - Workspace / project root path
 *   - Shell and OS information
 *   - Git repository status
 *   - Currently open and recently viewed files
 *   - Current date (for knowledge cutoff awareness)
 *
 * The extracted metadata serves as a fallback when the client doesn't
 * send Synesis-specific HTTP headers (x-synesis-project-root, etc.).
 */

export interface ClientMetadata {
  workspacePath: string | null;
  projectRoot: string | null;
  shellCwd: string | null;
  osVersion: string | null;
  platform: string | null;
  shell: string | null;
  gitIsRepo: boolean | null;
  gitRepoPath: string | null;
  currentDate: string | null;
  openFiles: string[];
  recentFiles: string[];
}

const EMPTY_METADATA: ClientMetadata = {
  workspacePath: null,
  projectRoot: null,
  shellCwd: null,
  osVersion: null,
  platform: null,
  shell: null,
  gitIsRepo: null,
  gitRepoPath: null,
  currentDate: null,
  openFiles: [],
  recentFiles: [],
};

/**
 * Extract structured metadata from system message content.
 * Handles multiple IDE client formats.
 */
export function extractClientMetadata(systemContent: string): ClientMetadata {
  const meta: ClientMetadata = { ...EMPTY_METADATA, openFiles: [], recentFiles: [] };

  extractUserInfo(systemContent, meta);
  extractOpenFiles(systemContent, meta);
  deriveProjectRoot(meta);

  return meta;
}

/**
 * Parse the <user_info> block present in Claude Code / Cursor system messages.
 *
 * Example:
 *   <user_info>
 *   OS Version: darwin 25.4.0
 *   Shell: zsh
 *   Workspace Path: /Users/bymiller/src/synesis
 *   Is directory a git repo: Yes, at /Users/bymiller/src/synesis
 *   Today's date: Tuesday Apr 8, 2026
 *   </user_info>
 */
function extractUserInfo(text: string, meta: ClientMetadata): void {
  const userInfoMatch = text.match(/<user_info>([\s\S]*?)<\/user_info>/);
  if (!userInfoMatch) {
    extractLoosePatterns(text, meta);
    return;
  }

  const block = userInfoMatch[1];

  const osMatch = block.match(/OS Version:\s*(.+)/i);
  if (osMatch) {
    const raw = osMatch[1].trim();
    meta.osVersion = raw;
    const parts = raw.split(/\s+/);
    if (parts.length > 0) meta.platform = parts[0];
  }

  const shellMatch = block.match(/Shell:\s*(.+)/i);
  if (shellMatch) meta.shell = shellMatch[1].trim();

  const wsMatch = block.match(/Workspace Path:\s*(.+)/i);
  if (wsMatch) meta.workspacePath = wsMatch[1].trim();

  const gitMatch = block.match(/Is directory a git repo:\s*(.+)/i);
  if (gitMatch) {
    const val = gitMatch[1].trim();
    meta.gitIsRepo = val.toLowerCase().startsWith("yes");
    const atMatch = val.match(/at\s+(.+)/i);
    if (atMatch) meta.gitRepoPath = atMatch[1].trim();
  }

  const dateMatch = block.match(/Today's date:\s*(.+)/i);
  if (dateMatch) meta.currentDate = dateMatch[1].trim();
}

/**
 * Fallback: extract metadata from loose patterns when <user_info> block
 * is not present (some IDE clients embed these inline).
 */
function extractLoosePatterns(text: string, meta: ClientMetadata): void {
  if (!meta.workspacePath) {
    const wsMatch = text.match(/Workspace Path:\s*(.+)/i);
    if (wsMatch) meta.workspacePath = wsMatch[1].trim();
  }

  if (!meta.osVersion) {
    const osMatch = text.match(/OS Version:\s*(.+)/i);
    if (osMatch) {
      meta.osVersion = osMatch[1].trim();
      const parts = meta.osVersion.split(/\s+/);
      if (parts.length > 0) meta.platform = parts[0];
    }
  }

  if (!meta.shell) {
    const shellMatch = text.match(/Shell:\s*(\w+)/i);
    if (shellMatch) meta.shell = shellMatch[1].trim();
  }

  if (meta.gitIsRepo === null) {
    const gitMatch = text.match(/Is directory a git repo:\s*(.+)/i);
    if (gitMatch) {
      meta.gitIsRepo = gitMatch[1].trim().toLowerCase().startsWith("yes");
    }
  }

  if (!meta.currentDate) {
    const dateMatch = text.match(/Today's date:\s*(.+)/i);
    if (dateMatch) meta.currentDate = dateMatch[1].trim();
  }
}

/**
 * Parse <open_and_recently_viewed_files> block.
 *
 * Example:
 *   <open_and_recently_viewed_files>
 *   Recently viewed files (recent at the top, oldest at the bottom):
 *   - /Users/bymiller/src/synesis/base/yarn-ts/src/index.ts (total lines: 8302)
 *
 *   Files that are currently open and visible in the user's IDE:
 *   - /Users/bymiller/.cursor/projects/.../terminals/1.txt (total lines: 136)
 *   </open_and_recently_viewed_files>
 */
function extractOpenFiles(text: string, meta: ClientMetadata): void {
  const block = text.match(/<open_and_recently_viewed_files>([\s\S]*?)<\/open_and_recently_viewed_files>/);
  if (!block) return;

  const content = block[1];
  const lines = content.split("\n");

  let section: "recent" | "open" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/Recently viewed files/i.test(trimmed)) {
      section = "recent";
      continue;
    }
    if (/Files that are currently open/i.test(trimmed)) {
      section = "open";
      continue;
    }

    if (section && trimmed.startsWith("- ")) {
      const filePath = trimmed
        .slice(2)
        .replace(/\s*\(total lines:.*\)/, "")
        .trim();
      if (filePath && filePath.startsWith("/")) {
        if (section === "recent") {
          meta.recentFiles.push(filePath);
        } else {
          meta.openFiles.push(filePath);
        }
      }
    }
  }
}

/**
 * Derive projectRoot from workspacePath and file paths.
 * workspacePath from <user_info> is the most reliable source.
 * If not available, try to infer from common prefix of open/recent files.
 */
function deriveProjectRoot(meta: ClientMetadata): void {
  if (meta.workspacePath) {
    meta.projectRoot = meta.workspacePath;
    meta.shellCwd = meta.workspacePath;
    return;
  }

  if (meta.gitRepoPath) {
    meta.projectRoot = meta.gitRepoPath;
    meta.shellCwd = meta.gitRepoPath;
    return;
  }

  const allFiles = [...meta.recentFiles, ...meta.openFiles];
  if (allFiles.length === 0) return;

  const prefix = commonPathPrefix(allFiles);
  if (prefix && prefix.length > 1) {
    meta.projectRoot = prefix;
    meta.shellCwd = prefix;
  }
}

/**
 * Find the longest common directory prefix among a set of absolute paths.
 */
function commonPathPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  if (paths.length === 1) {
    const parts = paths[0].split("/");
    parts.pop();
    return parts.join("/");
  }

  const splitPaths = paths.map((p) => p.split("/"));
  const minLen = Math.min(...splitPaths.map((p) => p.length));
  const common: string[] = [];

  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    if (splitPaths.every((p) => p[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }

  const result = common.join("/");
  return result || null;
}

/**
 * Extract metadata from all system messages in a messages array.
 * Concatenates all system message content and parses once.
 */
export function extractMetadataFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): ClientMetadata {
  const systemTexts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "system") continue;
    if (typeof msg.content === "string") {
      systemTexts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ text?: string }>) {
        if (typeof block.text === "string") systemTexts.push(block.text);
      }
    }
  }
  if (systemTexts.length === 0) return { ...EMPTY_METADATA, openFiles: [], recentFiles: [] };
  return extractClientMetadata(systemTexts.join("\n"));
}
