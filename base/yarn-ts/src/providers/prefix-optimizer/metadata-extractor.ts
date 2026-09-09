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
  // OpenCode/Cursor env lines (e.g. "Working directory:") often live outside <user_info>.
  extractLoosePatterns(systemContent, meta);
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
 * Extract metadata from inline / out-of-band patterns (OpenCode environment block,
 * etc.). Runs on the full system text and only fills fields not already set.
 */
function extractLoosePatterns(text: string, meta: ClientMetadata): void {
  if (!meta.workspacePath) {
    const wsMatch = text.match(/Workspace Path:\s*(.+)/i);
    if (wsMatch) meta.workspacePath = wsMatch[1].trim();
  }

  // opencode: "Workspace root folder: /path/to/root"
  if (!meta.workspacePath) {
    const rootMatch = text.match(/Workspace root folder:\s*(.+)/i);
    if (rootMatch) meta.workspacePath = rootMatch[1].trim();
  }

  // opencode: "Working directory: /path/to/dir" → shellCwd (may differ from workspace root)
  if (!meta.shellCwd) {
    const cwdMatch = text.match(/Working directory:\s*(.+)/i);
    if (cwdMatch) meta.shellCwd = cwdMatch[1].trim();
  }

  if (!meta.osVersion) {
    const osMatch = text.match(/OS Version:\s*(.+)/i);
    if (osMatch) {
      meta.osVersion = osMatch[1].trim();
      const parts = meta.osVersion.split(/\s+/);
      if (parts.length > 0) meta.platform = parts[0];
    }
  }

  // opencode: "Platform: darwin" (bare platform without full OS version string)
  if (!meta.platform) {
    const platMatch = text.match(/Platform:\s*(\w+)/i);
    if (platMatch) meta.platform = platMatch[1].trim();
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
 * Derive a workspace hint from explicit environment fields only.
 * Open/recent files do not establish a workspace boundary.
 */
function deriveProjectRoot(meta: ClientMetadata): void {
  if (meta.workspacePath) {
    meta.projectRoot = meta.workspacePath;
    if (!meta.shellCwd) meta.shellCwd = meta.workspacePath;
    return;
  }

  if (meta.gitRepoPath) {
    meta.projectRoot = meta.gitRepoPath;
    if (!meta.shellCwd) meta.shellCwd = meta.gitRepoPath;
    return;
  }

  // shellCwd was set directly (e.g. opencode "Working directory:") but no workspace root
  if (meta.shellCwd && !meta.projectRoot) {
    meta.projectRoot = meta.shellCwd;
    return;
  }

  // Open/recent files may span unrelated projects. Their common ancestor is
  // not evidence of workspace ownership or the execution directory.

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
