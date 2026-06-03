/**
 * Frame Compactor
 *
 * Extracts a compact task frame from conversation history and computes
 * a stability hash. When the frame hash is unchanged from the previous
 * turn, the frame section can receive a cache marker (semi-stable).
 */

import crypto from "node:crypto";
import type { ChatMessage } from "./types.js";
import { normalizeWhitespace } from "./serializer.js";
import { isSyntheticHarnessReminderText } from "../../adapters/synthetic-reminders.js";

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return String(msg.content ?? "");
}

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const FILE_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;

export interface CompactFrame {
  objective: string;
  constraints: string[];
  filesInPlay: string[];
  phase: string;
  pendingChecks: string[];
  openIssues: string[];
  nextAction: string;
}

export interface FrameResult {
  frame: CompactFrame;
  serialized: string;
  hash: string;
  changed: boolean;
}

/**
 * Extract a compact task frame from the conversation.
 * Inspects system messages (for existing WORKING_FRAME blocks) and
 * conversation turns (for recent file references, goals, and issues).
 */
export function extractCompactFrame(
  messages: ChatMessage[],
  previousFrameHash: string | null,
): FrameResult {
  let objective = "";
  let phase = "implementation";
  const constraints: string[] = [];
  const filesInPlay = new Set<string>();
  const pendingChecks: string[] = [];
  const openIssues: string[] = [];
  let nextAction = "";

  for (const msg of messages) {
    const text = messageText(msg);

    if (msg.role === "system") {
      const frameMatch = text.match(/<WORKING_FRAME>([\s\S]*?)<\/WORKING_FRAME>/);
      if (frameMatch) {
        const frameContent = frameMatch[1];
        const goalMatch = frameContent.match(/goal=(.+)/);
        if (goalMatch) objective = goalMatch[1].trim();
        const phaseMatch = frameContent.match(/(?:current_)?phase=(.+)/);
        if (phaseMatch) phase = phaseMatch[1].trim();
        const filesMatch = frameContent.match(/(?:active_files|relevant_files)=(.+)/);
        if (filesMatch) {
          for (const f of filesMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) {
            if (f !== "none") filesInPlay.add(f);
          }
        }
        const checksMatch = frameContent.match(/pending_checks=(.+)/);
        if (checksMatch) {
          for (const c of checksMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) {
            if (c !== "none") pendingChecks.push(c);
          }
        }
        const constraintsMatch = frameContent.match(/constraints=(.+)/);
        if (constraintsMatch) {
          for (const c of constraintsMatch[1].split("|").map((s) => s.trim()).filter(Boolean)) {
            if (c !== "none") constraints.push(c);
          }
        }
      }
    }

    const recentFiles = text.match(FILE_RE);
    if (recentFiles) {
      for (const f of recentFiles.slice(0, 20)) filesInPlay.add(f);
    }
  }

  if (!objective) {
    const lastUser = [...messages].reverse().find((m) =>
      m.role === "user" && !isSyntheticHarnessReminderText(messageText(m))
    );
    if (lastUser) {
      const text = messageText(lastUser);
      objective = text.split("\n").find((l) => l.trim())?.trim().slice(0, 220) ?? "Complete the task";
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    const text = messageText(lastAssistant);
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      nextAction = lines[lines.length - 1].trim().slice(0, 220);
    }
  }

  const frame: CompactFrame = {
    objective: objective.slice(0, 220),
    constraints: constraints.slice(0, 6),
    filesInPlay: [...filesInPlay].slice(0, 15),
    phase,
    pendingChecks: [...new Set(pendingChecks)].slice(0, 4),
    openIssues: openIssues.slice(0, 4),
    nextAction: nextAction.slice(0, 220),
  };

  const serialized = normalizeWhitespace(serializeFrame(frame));
  const hash = hashContent(serialized);
  const changed = previousFrameHash !== null && previousFrameHash !== hash;

  return { frame, serialized, hash, changed };
}

function serializeFrame(frame: CompactFrame): string {
  const lines = [
    "<TASK_FRAME>",
    `objective=${frame.objective}`,
    `phase=${frame.phase}`,
    `files=${frame.filesInPlay.join(",") || "none"}`,
    `constraints=${frame.constraints.join(" | ") || "none"}`,
    `pending_checks=${frame.pendingChecks.join(",") || "none"}`,
    `open_issues=${frame.openIssues.join(" | ") || "none"}`,
    `next_action=${frame.nextAction || "none"}`,
    "</TASK_FRAME>",
  ];
  return lines.join("\n");
}
