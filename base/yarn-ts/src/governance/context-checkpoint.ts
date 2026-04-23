/**
 * Context Checkpoint — Durable Structured State Capture
 *
 * Creates a structured checkpoint from current session state that can replace
 * historical transcript during heavy compaction.  The checkpoint uses XML
 * structure (not prose) so the model can parse it deterministically.
 *
 * Constraints:
 *   - Never overwrites authoritative plan/file shadow state
 *   - References plan content by hash, doesn't embed it
 *   - FileSnapshotRegistry remains the source of truth for file state
 */

import crypto from "crypto";
import type { ChatState } from "./chat-state.js";
import type { FileState, FileStateEntry } from "./file-state.js";
import type { ObjectiveEpochState } from "./objective-scope.js";
import type { ClassifiedMessage } from "./context-retention.js";

export interface ContextCheckpoint {
  checkpointId: string;
  createdAt: number;
  sessionKey: string;

  currentObjective: string;
  acceptedPlan: string | null;
  activeConstraints: string[];
  activeFiles: Array<{
    path: string;
    status: string;
    hash: string | null;
  }>;
  activeFailures: Array<{
    source: string;
    summary: string;
    turnIndex: number;
  }>;
  nextActions: string[];
  governorGuidance: string | null;

  compactedMessageCount: number;
  compactedTokenEstimate: number;
  retainedMessageCount: number;
  retainedTokenEstimate: number;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarize(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export function createContextCheckpoint(
  sessionKey: string,
  chatState: ChatState,
  fileState: FileState,
  objectiveEpoch: ObjectiveEpochState,
  classified: ClassifiedMessage[],
): ContextCheckpoint {
  const checkpointId = `ckpt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const activeFiles: ContextCheckpoint["activeFiles"] = [];
  for (const [path, entry] of Object.entries(fileState.filesByPath)) {
    if (entry.status === "evicted" || entry.status === "missing") continue;
    activeFiles.push({
      path,
      status: entry.status,
      hash: entry.lastHash,
    });
  }

  const activeFailures: ContextCheckpoint["activeFailures"] = [];
  for (const cl of classified) {
    if (cl.tags.includes("unresolved_failure")) {
      activeFailures.push({
        source: "tool_result",
        summary: `Failure at message ${cl.index}`,
        turnIndex: cl.index,
      });
    }
  }
  for (const blocker of chatState.blockers) {
    activeFailures.push({
      source: "blocker",
      summary: summarize(blocker, 200),
      turnIndex: -1,
    });
  }

  const activeConstraints: string[] = [];
  for (const correction of chatState.unresolvedCorrections) {
    activeConstraints.push(`Unresolved: ${summarize(correction.issue, 160)}`);
  }

  const nextActions: string[] = [];
  if (chatState.phase === "recover" && chatState.lastAttemptSummary) {
    nextActions.push(`Fix: ${summarize(chatState.lastAttemptSummary.summary, 160)}`);
  }
  if (chatState.pendingUserDirective) {
    nextActions.push(`User directive: ${summarize(chatState.pendingUserDirective, 160)}`);
  }
  if (chatState.phase === "verify") {
    nextActions.push("Continue verification");
  }

  const compactedCount = classified.filter(
    (c) => c.tier === "historical" && !c.tags.includes("unresolved_failure"),
  ).length;

  return {
    checkpointId,
    createdAt: Date.now(),
    sessionKey,
    currentObjective: chatState.activeObjective ?? objectiveEpoch.objectiveText ?? "none",
    acceptedPlan: null,
    activeConstraints,
    activeFiles: activeFiles.slice(0, 20),
    activeFailures: activeFailures.slice(0, 10),
    nextActions: nextActions.slice(0, 5),
    governorGuidance: null,
    compactedMessageCount: compactedCount,
    compactedTokenEstimate: 0,
    retainedMessageCount: 0,
    retainedTokenEstimate: 0,
  };
}

export function renderCheckpointMessage(checkpoint: ContextCheckpoint): string {
  const lines: string[] = [];
  lines.push(`<CONTEXT_CHECKPOINT id="${escXml(checkpoint.checkpointId)}" created="${new Date(checkpoint.createdAt).toISOString()}">`);
  lines.push(`  <objective>${escXml(checkpoint.currentObjective)}</objective>`);

  if (checkpoint.acceptedPlan) {
    lines.push(`  <plan status="in_progress">${escXml(checkpoint.acceptedPlan)}</plan>`);
  }

  if (checkpoint.activeConstraints.length > 0) {
    lines.push(`  <constraints count="${checkpoint.activeConstraints.length}">`);
    for (const c of checkpoint.activeConstraints) {
      lines.push(`    <constraint>${escXml(c)}</constraint>`);
    }
    lines.push("  </constraints>");
  }

  if (checkpoint.activeFiles.length > 0) {
    lines.push(`  <active_files count="${checkpoint.activeFiles.length}">`);
    for (const f of checkpoint.activeFiles) {
      lines.push(`    <file path="${escXml(f.path)}" status="${escXml(f.status)}"${f.hash ? ` hash="${escXml(f.hash)}"` : ""} />`);
    }
    lines.push("  </active_files>");
  }

  if (checkpoint.activeFailures.length > 0) {
    lines.push(`  <unresolved_failures count="${checkpoint.activeFailures.length}">`);
    for (const f of checkpoint.activeFailures) {
      lines.push(`    <failure source="${escXml(f.source)}" turn="${f.turnIndex}">${escXml(f.summary)}</failure>`);
    }
    lines.push("  </unresolved_failures>");
  }

  if (checkpoint.nextActions.length > 0) {
    lines.push(`  <next_actions count="${checkpoint.nextActions.length}">`);
    for (const a of checkpoint.nextActions) {
      lines.push(`    <action>${escXml(a)}</action>`);
    }
    lines.push("  </next_actions>");
  }

  lines.push(`  <compacted turns="${checkpoint.compactedMessageCount}" tokens_recovered="~${checkpoint.compactedTokenEstimate}" />`);
  lines.push("</CONTEXT_CHECKPOINT>");

  return lines.join("\n");
}
