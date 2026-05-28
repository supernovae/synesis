import { createHash } from "node:crypto";
import type { ModelExecutionPolicy } from "../providers/model-architecture-profile.js";
import type { TaskLedger } from "../task-ledger/types.js";

export type WorkPacketMode = "off" | "observe" | "adapt" | "strict";

export interface DurableWorkPacketInput {
  sessionKey: string;
  requestCount?: number;
  messages: unknown[];
  taskLedger?: TaskLedger | null;
  projectRoot?: string | null;
  shellCwd?: string | null;
  modelPolicy: ModelExecutionPolicy;
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  configMode?: string | null;
}

export interface DurableWorkPacketDecision {
  mode: WorkPacketMode;
  inject: boolean;
  reasons: string[];
  packet: DurableWorkPacket | null;
}

export interface DurableWorkPacket {
  block: string;
  hash: string;
  estimatedTokens: number;
  sectionCount: number;
  sourceSections: string[];
  changedSinceLastHash?: boolean;
  summary: {
    objective?: string;
    currentPhase: WorkPacketPhase;
    nextBestAction: string;
  };
}

type WorkPacketPhase = "planning" | "implementation" | "verification" | "repair" | "finalization";

const MAX_TEXT = 240;
const MAX_PACKET_CHARS = 3_800;

export function resolveWorkPacketMode(input: Pick<DurableWorkPacketInput, "metadata" | "extraBody" | "configMode">): WorkPacketMode {
  const requested = firstString(
    input.metadata?.synesis_memory,
    input.metadata?.synesis_work_packet,
    input.metadata?.synesis_memory_mediation,
    input.extraBody?.synesis_memory,
    input.extraBody?.synesis_work_packet,
    input.extraBody?.synesis_memory_mediation,
    input.configMode,
  );
  if (!requested) return "adapt";
  const normalized = requested.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["off", "none", "disabled", "disable", "passthrough", "hands_off"].includes(normalized)) return "off";
  if (["observe", "observer", "diagnostic", "diagnostics", "trace", "report"].includes(normalized)) return "observe";
  if (["strict", "strong", "enforced", "force", "always"].includes(normalized)) return "strict";
  return "adapt";
}

export function buildDurableWorkPacketDecision(input: DurableWorkPacketInput): DurableWorkPacketDecision {
  const mode = resolveWorkPacketMode(input);
  const reasons = workPacketPolicyReasons(input.modelPolicy);
  const shouldInject = mode === "strict" || (mode === "adapt" && reasons.length > 0);
  if (mode === "off" || mode === "observe" || !shouldInject) {
    const packet = buildDurableWorkPacket(input);
    return {
      mode,
      inject: false,
      reasons: mode === "off" || mode === "observe" ? [`synesis_memory_${mode}`] : ["policy_did_not_require_tail_replay"],
      packet,
    };
  }

  const packet = buildDurableWorkPacket(input);
  return {
    mode,
    inject: packet.sectionCount > 0,
    reasons: packet.sectionCount > 0 ? reasons : ["packet_empty"],
    packet,
  };
}

function buildDurableWorkPacket(input: DurableWorkPacketInput): DurableWorkPacket {
  const messageTexts = input.messages.map(messageToText).filter(Boolean);
  const latestUser = latestRoleText(input.messages, "user") ?? "";
  const latestTool = latestToolText(input.messages) ?? "";
  const objective = trimLine(latestUser || input.taskLedger?.tasks.find((task) => task.status !== "completed")?.title || "Continue current developer task.", MAX_TEXT);
  const phase = inferPhase(latestUser, latestTool);
  const blockers = inferBlockers(latestTool);
  const pathCorrection = inferPathCorrection(latestTool, input.projectRoot, input.shellCwd);
  const doNotRepeat = inferDoNotRepeat(latestTool);
  const files = inferRecentFiles(messageTexts).slice(0, 8);
  const tasks = (input.taskLedger?.tasks ?? []).slice(0, 10);
  const nextBestAction = inferNextBestAction(blockers, phase, pathCorrection);

  const sections: string[] = [
    `<SYNESIS_CURRENT_WORK_PACKET mode="${input.modelPolicy.mediationMode}" policy_hash="${input.modelPolicy.policyHash}">`,
    `objective: ${objective || "unknown"}`,
    `project_root: ${input.projectRoot || "unknown"}`,
    `shell_cwd: ${input.shellCwd || "unknown"}`,
    `current_phase: ${phase}`,
  ];
  const sourceSections: string[] = ["objective", "path", "phase"];

  if (tasks.length > 0) {
    sections.push("active_plan:");
    sourceSections.push("task_ledger");
    for (const [index, task] of tasks.entries()) {
      sections.push(`  ${index + 1}. ${task.status}: ${trimLine(task.title, 180)}`);
    }
  }

  if (files.length > 0) {
    sections.push("files_touched:");
    sourceSections.push("recent_files");
    for (const file of files) sections.push(`  - ${file}`);
  }

  if (latestTool) {
    sections.push("latest_tool_truth:");
    sections.push(`  - ${trimLine(latestTool, 320)}`);
    sourceSections.push("latest_tool_truth");
  }

  if (blockers.length > 0) {
    sections.push("known_blockers:");
    sourceSections.push("known_blockers");
    for (const blocker of blockers) sections.push(`  - ${blocker}`);
  }

  if (pathCorrection) {
    sections.push("path_correction:");
    sections.push(`  - ${pathCorrection}`);
    sourceSections.push("path_correction");
  }

  if (doNotRepeat.length > 0) {
    sections.push("do_not_repeat:");
    sourceSections.push("do_not_repeat");
    for (const item of doNotRepeat) sections.push(`  - ${item}`);
  }

  sections.push("next_best_action:");
  sections.push(`  - ${nextBestAction}`);
  sourceSections.push("next_best_action");
  sections.push("</SYNESIS_CURRENT_WORK_PACKET>");

  const block = trimBlock(sections.join("\n"), MAX_PACKET_CHARS);
  return {
    block,
    hash: createHash("sha256").update(block).digest("hex").slice(0, 16),
    estimatedTokens: Math.ceil(block.length / 4),
    sectionCount: sourceSections.length,
    sourceSections,
    summary: { objective, currentPhase: phase, nextBestAction },
  };
}

function workPacketPolicyReasons(policy: ModelExecutionPolicy): string[] {
  const reasons: string[] = [];
  if (policy.preferRecentToolStateReplay) reasons.push("prefer_recent_tool_state_replay");
  if (policy.preferExplicitStateHeaders) reasons.push("prefer_explicit_state_headers");
  if (policy.preferMemoryStitching) reasons.push("prefer_memory_stitching");
  if (policy.attention === "sliding_window") reasons.push("sliding_window_attention");
  if (policy.attention === "mla") reasons.push("attention_compression");
  if (policy.compactionMode === "aggressive") reasons.push("aggressive_compaction_profile");
  return [...new Set(reasons)];
}

function latestRoleText(messages: unknown[], role: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    if (msg?.role === role) {
      const text = contentToText(msg.content);
      if (text) return text;
    }
  }
  return null;
}

function latestToolText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    const role = typeof msg?.role === "string" ? msg.role : "";
    if (role === "tool" || role === "function" || role === "user") {
      const text = contentToText(msg?.content);
      if (text && looksLikeToolTruth(text)) return text;
    }
  }
  return null;
}

function looksLikeToolTruth(text: string): boolean {
  return /\b(error|failed|passed|exit code|no such file|file not found|schemaerror|invalid arguments|pytest|npm|tsc|ruff|gofmt|total \d+|drwx|^-rw)/im.test(text);
}

function inferPhase(latestUser: string, latestTool: string): WorkPacketPhase {
  const combined = `${latestUser}\n${latestTool}`.toLowerCase();
  if (/\b(final|summarize|wrap up|done)\b/.test(latestUser.toLowerCase())) return "finalization";
  if (/\b(test|verify|validation|pytest|typecheck|lint|build)\b/.test(combined)) return "verification";
  if (/\b(error|failed|traceback|no such file|schemaerror|invalid arguments|blocked)\b/.test(combined)) return "repair";
  if (/\b(plan|design|approach)\b/.test(latestUser.toLowerCase())) return "planning";
  return "implementation";
}

function inferBlockers(latestTool: string): string[] {
  const text = latestTool.toLowerCase();
  const blockers: string[] = [];
  if (/schemaerror|invalid arguments/.test(text) && /todo|task/.test(text)) {
    blockers.push("Task/todo tracker schema failed; previous code/file writes are not invalidated by that tracker error.");
  }
  if (/no such file|file not found|cannot access|enoent/.test(text)) {
    blockers.push("A path lookup failed; treat this as path/cwd mismatch until one narrow location check proves otherwise.");
  }
  if (/rm -rf is disallowed|unsafe_shell/.test(text)) {
    blockers.push("Unsafe shell cleanup was blocked; use non-destructive structured inspection or explicit user-approved cleanup.");
  }
  if (/blocked_system_path.*\/dev\/null|\/dev\/null.*blocked_system_path/.test(text)) {
    blockers.push("A shell stderr-suppression redirect to /dev/null was blocked; rerun the same narrow command without that redirect rather than changing project files.");
  }
  if (/failed|traceback|assertionerror|error:/i.test(latestTool) && /\bpytest|test|tsc|npm|ruff|go test\b/i.test(latestTool)) {
    blockers.push("Verification failed; fix one implicated traceback/assertion/file before rerunning broad checks.");
  }
  return blockers.slice(0, 4);
}

function inferDoNotRepeat(latestTool: string): string[] {
  const items: string[] = [];
  const duplicated = duplicatedAdjacentPathSuffix(latestTool);
  if (duplicated) {
    items.push(`Do not retry duplicated path prefix ${duplicated}; strip the repeated working-root segment first.`);
  }
  if (/no such file|file not found|cannot access|enoent/i.test(latestTool)) {
    items.push("Do not recreate the full project because one path lookup or install path failed; verify the canonical tree and add only missing files.");
  }
  if (/schemaerror|invalid arguments/i.test(latestTool)) {
    items.push("Do not rebuild completed files because a tracker/tool-call schema failed.");
  }
  return items.slice(0, 4);
}

function inferNextBestAction(blockers: string[], phase: WorkPacketPhase, pathCorrection: string | null): string {
  const joined = blockers.join(" ").toLowerCase();
  if (joined.includes("tracker schema")) return "Retry only the tracker update with the exact schema, or continue from existing files with one narrow verification.";
  if (pathCorrection || joined.includes("path")) return "Run pwd plus one scoped listing from the canonical root, strip duplicated cwd/project-root segments, then create or edit only the missing file.";
  if (joined.includes("verification failed")) return "Pick the first failing traceback/assertion, edit the implicated file once, then run one targeted verification.";
  if (phase === "verification") return "Run the narrowest relevant verification and act on the first concrete failure.";
  return "Continue with one concrete edit, tool call, or task update based on the latest tool truth.";
}

function inferPathCorrection(latestTool: string, projectRoot?: string | null, shellCwd?: string | null): string | null {
  const paths = latestTool.match(/\/[A-Za-z0-9._/-]+/g) ?? [];
  const anchors = [shellCwd, projectRoot]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().replace(/\/+$/g, ""));
  for (const observed of paths) {
    const cleaned = observed.replace(/\/+$/g, "");
    for (const anchor of anchors) {
      const corrected = stripRepeatedAnchorSuffix(cleaned, anchor);
      if (corrected && corrected !== cleaned) {
        const relative = corrected.startsWith(`${anchor}/`) ? corrected.slice(anchor.length + 1) : corrected;
        return `Observed duplicated workspace path ${cleaned}; canonical workspace root is ${anchor}; use ${relative || "."} relative to that root and do not rebuild existing files.`;
      }
    }
  }
  const duplicated = duplicatedAdjacentPathSuffix(latestTool);
  if (duplicated) {
    return `Observed repeated path segment ${duplicated}; strip the duplicated working-root segment before retrying and verify the canonical path once.`;
  }
  return null;
}

function stripRepeatedAnchorSuffix(observedPath: string, anchor: string): string | null {
  if (!observedPath.startsWith(`${anchor}/`)) return null;
  const anchorParts = anchor.split("/").filter(Boolean);
  const afterAnchor = observedPath.slice(anchor.length + 1);
  const relParts = afterAnchor.split("/").filter(Boolean);
  const maxSuffix = Math.min(4, anchorParts.length, relParts.length);
  for (let len = maxSuffix; len >= 1; len--) {
    const suffix = anchorParts.slice(anchorParts.length - len);
    const head = relParts.slice(0, len);
    if (suffix.every((part, index) => part === head[index])) {
      return `${anchor}/${relParts.slice(len).join("/")}`.replace(/\/+$/g, "");
    }
  }
  return null;
}

function inferRecentFiles(texts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const fileRe = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;
  for (let i = texts.length - 1; i >= 0; i--) {
    for (const match of texts[i].match(fileRe) ?? []) {
      if (seen.has(match)) continue;
      seen.add(match);
      result.push(match);
      if (result.length >= 8) return result;
    }
  }
  return result;
}

function messageToText(message: unknown): string {
  const msg = asRecord(message);
  if (!msg) return "";
  return contentToText(msg.content);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const obj = asRecord(part);
      return typeof obj?.text === "string" ? obj.text : "";
    }).filter(Boolean).join("\n").trim();
  }
  if (content && typeof content === "object") return JSON.stringify(content).slice(0, 2_000);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function trimLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function trimBlock(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 64).trim()}\n... packet truncated ...\n</SYNESIS_CURRENT_WORK_PACKET>`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function duplicatedAdjacentPathSuffix(text: string): string | null {
  const paths = text.match(/\/[A-Za-z0-9._/-]+/g) ?? [];
  for (const filePath of paths) {
    const parts = filePath.split("/").filter(Boolean);
    for (let start = 0; start < parts.length - 2; start++) {
      const maxLen = Math.min(4, Math.floor((parts.length - start) / 2));
      for (let len = maxLen; len >= 1; len--) {
        const first = parts.slice(start, start + len);
        const second = parts.slice(start + len, start + (len * 2));
        if (second.length === first.length && first.every((part, index) => second[index] === part)) {
          return `/${first.join("/")}`;
        }
      }
    }
  }
  return null;
}
