/**
 * Volatility Classifier
 *
 * Classifies content stability for prefix-cache optimization.
 * Detects patterns common across IDE clients (Claude Code, Cursor,
 * OpenCode, Windsurf) rather than hard-coding one client's format.
 */

import type { ContentStability, SegmentCategory } from "./types.js";

const VOLATILE_PATTERNS: RegExp[] = [
  /Today's date:/i,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+\w+\s+\d{1,2},?\s+\d{4}/i,
  /\bcwd:\s/i,
  /Working directory:/i,
  /Workspace root folder:/i,
  /OS Version:/i,
  /\bPlatform:\s/i,
  /\bShell:\s/i,
  /Is directory a git repo:/i,
  /<open_and_recently_viewed_files>/,
  /<\/open_and_recently_viewed_files>/,
  /Recently viewed files/i,
  /Files that are currently open/i,
  /<user_info>/,
  /<\/user_info>/,
  /<terminal_files_information>/,
  /Terminals folder:/i,
  /pid:\s*\d+/,
  /last_command:/,
  /last_exit_code:/,
  /Workspace Path:/i,
  /elapsed_ms/,
  /running_for_ms/,
  // Cursor/IDE conversation summary and state (changes every turn)
  /Previous conversation summary/i,
  /<previous_conversation_summary>/,
  /\[Previous conversation summary\]/i,
  /Summary of changes so far/i,
  /edit history in their session/i,
  // Dynamic agent transcripts / chat references
  /<agent_transcripts>/,
  /agent-transcripts/,
  // Per-turn todo state injected by IDE
  /<todo_update>/,
  /NOTE: There was an active todo list/i,
  // Dynamic linter errors section
  /linter errors/i,
];

const SEMI_STABLE_PATTERNS: RegExp[] = [
  /<task_notification>/,
  /<\/task_notification>/,
  /<WORKING_FRAME>/,
  /<\/WORKING_FRAME>/,
  /<SYNESIS_CHAT_STATE>/,
  /<\/SYNESIS_CHAT_STATE>/,
  /<SYNESIS_FILE_STATE>/,
  /<\/SYNESIS_FILE_STATE>/,
  /<system_reminder>/,
  /<\/system_reminder>/,
  /<previous_tool_call>/,
];

const STABLE_PATTERNS: RegExp[] = [
  /<rules>/,
  /<\/rules>/,
  /<always_applied_workspace_rule/,
  /<\/always_applied_workspace_rule>/,
  /<tone_and_style>/,
  /<\/tone_and_style>/,
  /<making_code_changes>/,
  /<\/making_code_changes>/,
  /<citing_code>/,
  /<\/citing_code>/,
  /<tool_calling>/,
  /<\/tool_calling>/,
  /<linter_errors>/,
  /<inline_line_numbers>/,
  /<committing-changes-with-git>/,
  /<creating-pull-requests>/,
  /<agent_skills>/,
  /<\/agent_skills>/,
  /<mcp_file_system>/,
  /<\/mcp_file_system>/,
  /You are an AI coding assistant/,
  /You operate in Cursor/i,
  /# CLAUDE\.md/,
  /# AGENTS\.md/,
  /\.cursorrules/,
  /\.windsurfrules/,
  /<mode_selection>/,
];

/**
 * Classify a text block's stability for cache optimization.
 * Category hint is used to fast-path known volatile/stable categories.
 */
export function classifyVolatility(
  text: string,
  category?: SegmentCategory,
): ContentStability {
  if (category === "latest_user_turn" || category === "tool_results") return "volatile";
  if (category === "live_context") return "volatile";
  if (category === "core_instructions") return "stable";
  if (category === "project_guidance") return "stable";
  if (category === "task_frame") return "semi_stable";

  return classifyByPatterns(text);
}

function classifyByPatterns(text: string): ContentStability {
  let stableScore = 0;
  let volatileScore = 0;
  let semiStableScore = 0;

  for (const pat of VOLATILE_PATTERNS) {
    if (pat.test(text)) volatileScore++;
  }
  for (const pat of SEMI_STABLE_PATTERNS) {
    if (pat.test(text)) semiStableScore++;
  }
  for (const pat of STABLE_PATTERNS) {
    if (pat.test(text)) stableScore++;
  }

  if (volatileScore > stableScore && volatileScore > semiStableScore) return "volatile";
  if (semiStableScore > stableScore && semiStableScore > 0) return "semi_stable";
  if (stableScore > 0) return "stable";
  return "volatile";
}

export interface SplitResult {
  stablePart: string;
  volatilePart: string;
}

/**
 * Split a mixed text block at the first volatile line boundary.
 * Scans line-by-line and cuts at the first line that matches a volatile pattern.
 * Returns the stable prefix and volatile suffix.
 */
export function splitAtVolatileBoundary(text: string): SplitResult {
  const lines = text.split("\n");
  let splitIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of VOLATILE_PATTERNS) {
      if (pat.test(line)) {
        splitIdx = i;
        break;
      }
    }
    if (splitIdx < lines.length) break;
  }

  if (splitIdx === 0) {
    return { stablePart: "", volatilePart: text };
  }
  if (splitIdx === lines.length) {
    return { stablePart: text, volatilePart: "" };
  }

  return {
    stablePart: lines.slice(0, splitIdx).join("\n"),
    volatilePart: lines.slice(splitIdx).join("\n"),
  };
}

/**
 * Check whether a specific line is volatile.
 */
export function isVolatileLine(line: string): boolean {
  return VOLATILE_PATTERNS.some((p) => p.test(line));
}
