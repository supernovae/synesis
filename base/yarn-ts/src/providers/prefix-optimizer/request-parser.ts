/**
 * Request Parser
 *
 * Parses an OpenAI-format messages array into semantic ParsedSegments.
 * Handles the core challenge: IDE clients (Claude Code, Cursor, etc.)
 * pack both stable rules and volatile session context into a single
 * system message. This parser splits that message on stability boundaries.
 */

import crypto from "node:crypto";
import type { ChatMessage, ParsedSegment, ToolDefinition } from "./types.js";
import { splitAtVolatileBoundary } from "./volatility.js";
import { canonicalStringify, normalizeWhitespace } from "./serializer.js";

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return String(msg.content ?? "");
}

/**
 * Known XML tags / section headers that delimit stable project guidance
 * (CLAUDE.md, cursor rules, AGENTS.md, workspace rules).
 */
const PROJECT_GUIDANCE_PATTERNS = [
  /# CLAUDE\.md/,
  /# AGENTS\.md/,
  /<always_applied_workspace_rule/,
  /<always_applied_workspace_rules/,
  /<agent_skills/,
  /<available_skills/,
  /<mcp_file_system>/,
  /<agent_transcripts>/,
];

const TASK_FRAME_PATTERNS = [
  /<TASK_FRAME>/,
  /<WORKING_FRAME>/,
  /<SYNESIS_CHAT_STATE>/,
  /<SYNESIS_FILE_STATE>/,
  /<ARCHITECTURAL_STATE>/,
  /<system_reminder>/,
];

const LIVE_CONTEXT_PATTERNS = [
  /<user_info>/,
  /<open_and_recently_viewed_files>/,
  /<terminal_files_information>/,
  /Workspace Path:/i,
  /Today's date:/i,
  /<agent_transcripts>/,
  /agent-transcripts/,
  /<todo_update>/,
  /NOTE: There was an active todo list/i,
  /Previous conversation summary/i,
  /<previous_conversation_summary>/,
  /\[Previous conversation summary\]/i,
  /Summary of changes so far/i,
  /edit history in their session/i,
  /linter errors/i,
];

const STABLE_CORE_MARKERS = [
  /You are an AI coding assistant provided by Synesis\./i,
  /You are Synesis,\s*a software engineering agent/i,
  /<CLIENT_ADAPTER>/,
  /<SYNESIS_CODER_WORKFLOW>/,
  /<SYNESIS_MODEL_SHIMS>/,
];

type SectionType = "core" | "project_guidance" | "task_frame" | "live_context";

interface SectionBoundary {
  lineIndex: number;
  type: SectionType;
}

/**
 * Detect section boundaries within a system message by scanning for
 * known markers. Returns boundaries sorted by line index.
 */
function detectSectionBoundaries(lines: string[]): SectionBoundary[] {
  const boundaries: SectionBoundary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pat of LIVE_CONTEXT_PATTERNS) {
      if (pat.test(line)) {
        boundaries.push({ lineIndex: i, type: "live_context" });
        break;
      }
    }
    for (const pat of TASK_FRAME_PATTERNS) {
      if (pat.test(line)) {
        if (!boundaries.some((b) => b.lineIndex === i)) {
          boundaries.push({ lineIndex: i, type: "task_frame" });
        }
        break;
      }
    }
    for (const pat of PROJECT_GUIDANCE_PATTERNS) {
      if (pat.test(line)) {
        if (!boundaries.some((b) => b.lineIndex === i)) {
          boundaries.push({ lineIndex: i, type: "project_guidance" });
        }
        break;
      }
    }
  }

  boundaries.sort((a, b) => a.lineIndex - b.lineIndex);
  return boundaries;
}

/**
 * Split a system message into semantic sections based on detected boundaries.
 */
function splitSystemMessage(text: string): Array<{ text: string; type: SectionType }> {
  const lines = text.split("\n");
  const boundaries = detectSectionBoundaries(lines);

  if (boundaries.length === 0) {
    const { stablePart, volatilePart } = splitAtVolatileBoundary(text);
    const sections: Array<{ text: string; type: SectionType }> = [];
    if (stablePart) sections.push({ text: stablePart, type: "core" });
    if (volatilePart) sections.push({ text: volatilePart, type: "live_context" });
    return sections.length > 0 ? sections : [{ text, type: "core" }];
  }

  const sections: Array<{ text: string; type: SectionType }> = [];

  if (boundaries[0].lineIndex > 0) {
    const coreText = lines.slice(0, boundaries[0].lineIndex).join("\n").trim();
    if (coreText) {
      const { stablePart, volatilePart } = splitAtVolatileBoundary(coreText);
      if (stablePart) sections.push({ text: stablePart, type: "core" });
      if (volatilePart) sections.push({ text: volatilePart, type: "live_context" });
    }
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].lineIndex;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].lineIndex : lines.length;
    const sectionText = lines.slice(start, end).join("\n").trim();
    if (sectionText) {
      sections.push({ text: sectionText, type: boundaries[i].type });
    }
  }

  return sections;
}

function hasStableCoreMarker(text: string): boolean {
  return STABLE_CORE_MARKERS.some((pat) => pat.test(text));
}

/**
 * Pick the canonical "core carrier" system message index.
 * We prefer messages that include explicit Synesis stable-core markers.
 * If none are present, fall back to the first system message.
 */
function resolveCoreCarrierSystemIndex(messages: ChatMessage[]): number {
  let fallbackFirstSystem = -1;
  let bestCoreLikeIdx = -1;
  let bestCoreLikeScore = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "system") continue;
    if (fallbackFirstSystem < 0) fallbackFirstSystem = i;
    const text = messageText(msg);
    if (hasStableCoreMarker(text)) return i;
    const coreLikeScore = splitSystemMessage(text)
      .filter((section) => section.type === "core" || section.type === "project_guidance")
      .reduce((sum, section) => sum + section.text.length, 0);
    if (coreLikeScore > bestCoreLikeScore) {
      bestCoreLikeScore = coreLikeScore;
      bestCoreLikeIdx = i;
    }
  }
  if (bestCoreLikeIdx >= 0) return bestCoreLikeIdx;
  return fallbackFirstSystem;
}

/**
 * Parse an OpenAI messages array into semantic segments for prefix optimization.
 *
 * The first system message is treated as the Synesis stable prefix (server-controlled).
 * Subsequent system messages are from the IDE client and may contain mixed
 * stable/volatile content — unmatched sections in those messages are classified
 * as live_context (volatile) rather than core, to avoid cache-busting.
 */
export function parseRequest(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): ParsedSegment[] {
  const segments: ParsedSegment[] = [];

  const coreTexts: string[] = [];
  const projectTexts: string[] = [];
  const frameTexts: string[] = [];
  const liveTexts: string[] = [];
  const coreIndices: number[] = [];
  const projectIndices: number[] = [];
  const frameIndices: number[] = [];
  const liveIndices: number[] = [];

  const lastUserIdx = findLastUserIndex(messages);
  const coreCarrierSystemIndex = resolveCoreCarrierSystemIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      const text = messageText(msg);

      const sections = splitSystemMessage(text);

      for (const section of sections) {
        // Keep "core" only for the canonical Synesis core-carrying system
        // message. Core-looking sections from other system messages are
        // treated as live context to avoid accidental cache-busting churn.
        const isCoreSection = section.type === "core";
        const isCoreCarrier = i === coreCarrierSystemIndex;
        const effectiveType = (isCoreSection && !isCoreCarrier)
          ? "live_context" as SectionType
          : section.type;

        switch (effectiveType) {
          case "core":
            coreTexts.push(section.text);
            if (!coreIndices.includes(i)) coreIndices.push(i);
            break;
          case "project_guidance":
            projectTexts.push(section.text);
            if (!projectIndices.includes(i)) projectIndices.push(i);
            break;
          case "task_frame":
            frameTexts.push(section.text);
            if (!frameIndices.includes(i)) frameIndices.push(i);
            break;
          case "live_context":
            liveTexts.push(section.text);
            if (!liveIndices.includes(i)) liveIndices.push(i);
            break;
        }
      }
    } else if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls)) {
      // conversation history
    } else if (msg.role === "user" && i !== lastUserIdx) {
      // conversation history
    } else if (msg.role === "assistant") {
      // conversation history
    }
  }

  if (coreTexts.length > 0) {
    const content = normalizeWhitespace(coreTexts.join("\n\n"));
    segments.push({
      category: "core_instructions",
      stability: "stable",
      content,
      hash: hashContent(content),
      sourceIndices: coreIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  if (projectTexts.length > 0) {
    const content = normalizeWhitespace(projectTexts.join("\n\n"));
    segments.push({
      category: "project_guidance",
      stability: "stable",
      content,
      hash: hashContent(content),
      sourceIndices: projectIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  if (tools && tools.length > 0) {
    const canonical = canonicalStringify(tools);
    segments.push({
      category: "tool_definitions",
      stability: "stable",
      content: canonical,
      hash: hashContent(canonical),
      sourceIndices: [],
      tokenEstimate: estimateTokens(canonical),
    });
  }

  if (frameTexts.length > 0) {
    const content = normalizeWhitespace(frameTexts.join("\n\n"));
    segments.push({
      category: "task_frame",
      stability: "semi_stable",
      content,
      hash: hashContent(content),
      sourceIndices: frameIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  if (liveTexts.length > 0) {
    const content = normalizeWhitespace(liveTexts.join("\n\n"));
    segments.push({
      category: "live_context",
      stability: "volatile",
      content,
      hash: hashContent(content),
      sourceIndices: liveIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  const historyMessages: ChatMessage[] = [];
  const historyIndices: number[] = [];
  const toolResultMessages: ChatMessage[] = [];
  const toolResultIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (i === lastUserIdx) continue;

    if (msg.role === "tool") {
      toolResultMessages.push(msg);
      toolResultIndices.push(i);
    } else {
      historyMessages.push(msg);
      historyIndices.push(i);
    }
  }

  if (historyMessages.length > 0) {
    const content = historyMessages.map((m) => messageText(m)).join("\n---\n");
    segments.push({
      category: "conversation_history",
      stability: "volatile",
      content,
      hash: hashContent(content),
      sourceIndices: historyIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  if (toolResultMessages.length > 0) {
    const content = toolResultMessages.map((m) => messageText(m)).join("\n---\n");
    segments.push({
      category: "tool_results",
      stability: "volatile",
      content,
      hash: hashContent(content),
      sourceIndices: toolResultIndices,
      tokenEstimate: estimateTokens(content),
    });
  }

  if (lastUserIdx >= 0) {
    const content = messageText(messages[lastUserIdx]);
    segments.push({
      category: "latest_user_turn",
      stability: "volatile",
      content,
      hash: hashContent(content),
      sourceIndices: [lastUserIdx],
      tokenEstimate: estimateTokens(content),
    });
  }

  return segments;
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}
