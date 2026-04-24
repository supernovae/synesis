/**
 * Context Budget Manager
 *
 * Hierarchical context management for coder sessions.  Evaluates the current
 * message array against a tiered budget policy and applies progressive
 * compaction (soft → heavy → emergency) to keep context within safe limits.
 *
 * Inserted into the Yarn pipeline after objective_scope and before the
 * execution governor so that budget metrics inform governor decisions.
 *
 * Budget thresholds are ratios of the effective ceiling, so they scale
 * automatically when different models have different context limits.
 */

import { estimateTokens, estimateMessageTokens, type TokenEstimate } from "./context-token-estimator.js";
import type { ClassifiedMessage, RetentionContext } from "./context-retention.js";
import { classifyMessages } from "./context-retention.js";
import type { ContextCheckpoint } from "./context-checkpoint.js";
import { createContextCheckpoint, renderCheckpointMessage } from "./context-checkpoint.js";
import type { ChatState } from "./chat-state.js";
import type { FileState } from "./file-state.js";
import type { ObjectiveEpochState } from "./objective-scope.js";
import type { ArtifactStore } from "../state/artifact-store.js";

// ── Budget Policy ──────────────────────────────────────────────────────────

export interface ContextBudgetPolicy {
  ceilingTokens: number;
  outputReserveTokens: number;
  hardLimitTokens: number;
  emergencyTokens: number;
  heavyTokens: number;
  softTokens: number;
}

export type BudgetZone = "green" | "soft" | "heavy" | "emergency" | "reject";

export interface BudgetEvaluation {
  zone: BudgetZone;
  estimate: TokenEstimate;
  headroomTokens: number;
  policy: ContextBudgetPolicy;
  classification: ClassifiedMessage[] | null;
  compactionApplied: "none" | "soft" | "heavy" | "emergency";
  tokensRecovered: number;
  checkpoint: ContextCheckpoint | null;
}

export interface ContextBudgetMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 10_000;

const SOFT_RATIO = 0.75;
const HEAVY_RATIO = 0.88;
const EMERGENCY_RATIO = 0.93;
const HARD_RATIO = 0.95;

export function buildBudgetPolicy(
  ceilingTokens: number,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
): ContextBudgetPolicy {
  return {
    ceilingTokens,
    outputReserveTokens,
    hardLimitTokens: Math.floor(ceilingTokens * HARD_RATIO),
    emergencyTokens: Math.floor(ceilingTokens * EMERGENCY_RATIO),
    heavyTokens: Math.floor(ceilingTokens * HEAVY_RATIO),
    softTokens: Math.floor(ceilingTokens * SOFT_RATIO),
  };
}

export function classifyZone(estimatedTokens: number, policy: ContextBudgetPolicy): BudgetZone {
  if (estimatedTokens >= policy.hardLimitTokens) return "reject";
  if (estimatedTokens >= policy.emergencyTokens) return "emergency";
  if (estimatedTokens >= policy.heavyTokens) return "heavy";
  if (estimatedTokens >= policy.softTokens) return "soft";
  return "green";
}

// ── Soft Compaction ────────────────────────────────────────────────────────

const VERIFICATION_PASS_RE = /\b(pass|passed|ok\b|success|all tests passed|0 failed|no failures?|verification passed)\b/i;
const VERIFICATION_FAIL_RE = /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|exit\s+code\s+[1-9]\d*/i;
const PLAN_FILE_RE = /\.claude\/plans\//;

function contentString(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content ?? ""); } catch { return String(content); }
}

function isPassingVerification(content: string): boolean {
  return VERIFICATION_PASS_RE.test(content) && !VERIFICATION_FAIL_RE.test(content);
}

function isPlanRead(msg: ContextBudgetMessage): boolean {
  const raw = contentString(msg.content);
  return PLAN_FILE_RE.test(raw);
}

function getToolName(msg: ContextBudgetMessage): string {
  return (msg.name ?? "").toLowerCase();
}

function isFileRead(msg: ContextBudgetMessage): boolean {
  const name = getToolName(msg);
  return name === "read_file" || name === "readfile" || name === "read"
    || name === "file_read" || name === "cat";
}

function extractFilePath(msg: ContextBudgetMessage): string | null {
  const raw = contentString(msg.content);
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["filePath", "file_path", "path", "file"]) {
        if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
      }
    } catch { /* not JSON */ }
  }
  const match = raw.match(/(?:filePath|file_path|path)\s*[:=]\s*"?([^\s"',}{]+)/i);
  return match?.[1] ?? null;
}

function hasToolCalls(msg: ContextBudgetMessage): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

function retainToArtifact(store: ArtifactStore | null | undefined, raw: string): string {
  if (!store || raw.length < 100) return "";
  try {
    return ` artifact_handle="${store.putToolResult(raw).id}" recovery="synesis_artifact_retrieve"`;
  } catch {
    return "";
  }
}

/**
 * Replace a message's content with a compaction stub while preserving SDK
 * ModelMessage content structure.  When `content` is already an array of
 * tool-result parts (SDK format), the stub is wrapped in the same shape so
 * downstream `standardizePrompt` Zod validation passes.
 */
function replaceContentPreservingFormat(
  msg: ContextBudgetMessage,
  stubText: string,
): ContextBudgetMessage {
  if (msg.role === "tool" && Array.isArray(msg.content)) {
    const parts = msg.content as Array<Record<string, unknown>>;
    const existing = parts.find((p) => p.type === "tool-result");
    if (existing) {
      return {
        ...msg,
        content: [{
          type: "tool-result",
          toolCallId: existing.toolCallId ?? "",
          toolName: existing.toolName ?? "",
          output: { type: "text", value: stubText },
        }],
      };
    }
  }
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    return { ...msg, content: [{ type: "text", text: stubText }] };
  }
  return { ...msg, content: stubText };
}

export function applySoftCompaction(
  messages: ContextBudgetMessage[],
  classified: ClassifiedMessage[],
  targetTokens: number,
  artifactStore?: ArtifactStore | null,
): { messages: ContextBudgetMessage[]; tokensRecovered: number } {
  let currentTokens = classified.reduce((s, c) => s + c.estimatedTokens, 0);
  if (currentTokens <= targetTokens) {
    return { messages, tokensRecovered: 0 };
  }

  const out = [...messages];
  let recovered = 0;

  // Strategy 1: Collapse repeated file reads (keep latest per path)
  const latestReadByPath = new Map<string, number>();
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg.role !== "tool" || !isFileRead(msg)) continue;
    const fp = extractFilePath(msg);
    if (!fp) continue;
    if (!latestReadByPath.has(fp)) latestReadByPath.set(fp, i);
  }
  for (let i = 0; i < out.length && currentTokens > targetTokens; i++) {
    const cl = classified[i];
    if (!cl || cl.tier !== "historical" && cl.tier !== "artifact_shadow") continue;
    const msg = out[i];
    if (msg.role !== "tool" || !isFileRead(msg)) continue;
    const fp = extractFilePath(msg);
    if (!fp) continue;
    const latest = latestReadByPath.get(fp);
    if (latest === undefined || latest === i) continue;
    const before = estimateMessageTokens(msg);
    const handle = retainToArtifact(artifactStore, contentString(msg.content));
    const stub = `<FILE_SHADOW path="${fp}" latest_at_msg=${latest}${handle} />`;
    out[i] = replaceContentPreservingFormat(msg, stub);
    const after = estimateMessageTokens(out[i]);
    const delta = before - after;
    recovered += delta;
    currentTokens -= delta;
  }

  // Strategy 2: Fold repeated successful verifications
  const verifyCommands = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (msg.role !== "tool") continue;
    const raw = contentString(msg.content);
    if (!isPassingVerification(raw)) continue;
    const name = getToolName(msg);
    const key = name || "verification";
    const arr = verifyCommands.get(key) ?? [];
    arr.push(i);
    verifyCommands.set(key, arr);
  }
  for (const [key, indices] of verifyCommands) {
    if (indices.length < 2 || currentTokens <= targetTokens) continue;
    const latest = indices[indices.length - 1];
    for (const idx of indices.slice(0, -1)) {
      const cl = classified[idx];
      if (!cl || cl.tier === "immutable" || cl.tier === "working") continue;
      if (cl.tags.includes("unresolved_failure")) continue;
      const msg = out[idx];
      const before = estimateMessageTokens(msg);
      out[idx] = replaceContentPreservingFormat(msg, `<VERIFICATION_FOLDED tool="${key}" result="pass" latest_at_msg=${latest} count=${indices.length} />`);
      const after = estimateMessageTokens(out[idx]);
      const delta = before - after;
      recovered += delta;
      currentTokens -= delta;
    }
  }

  // Strategy 3: Drop assistant narration with no state change
  for (let i = 0; i < out.length - 1 && currentTokens > targetTokens; i++) {
    const cl = classified[i];
    if (!cl || cl.tier !== "historical") continue;
    const msg = out[i];
    if (msg.role !== "assistant") continue;
    if (hasToolCalls(msg)) continue;
    const raw = contentString(msg.content);
    if (raw.length <= 100) continue;
    const before = estimateMessageTokens(msg);
    const preview = raw.slice(0, 80).replace(/\n/g, " ");
    out[i] = replaceContentPreservingFormat(msg, `<NARRATION_CONDENSED chars=${raw.length}>${preview}...</NARRATION_CONDENSED>`);
    const after = estimateMessageTokens(out[i]);
    const delta = before - after;
    recovered += delta;
    currentTokens -= delta;
  }

  // Strategy 4: Dedupe superseded plan reads
  const planReadIndices: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "tool" && isPlanRead(out[i])) planReadIndices.push(i);
  }
  if (planReadIndices.length > 1) {
    const latest = planReadIndices[planReadIndices.length - 1];
    for (const idx of planReadIndices.slice(0, -1)) {
      if (currentTokens <= targetTokens) break;
      const cl = classified[idx];
      if (!cl || cl.tier === "working") continue;
      const msg = out[idx];
      const before = estimateMessageTokens(msg);
      out[idx] = replaceContentPreservingFormat(msg, `<PLAN_SUPERSEDED latest_at_msg=${latest} />`);
      const after = estimateMessageTokens(out[idx]);
      const delta = before - after;
      recovered += delta;
      currentTokens -= delta;
    }
  }

  // Strategy 5: Summarize stale exploration output
  for (let i = 0; i < out.length && currentTokens > targetTokens; i++) {
    const cl = classified[i];
    if (!cl || cl.retentionScore > 0.3) continue;
    if (cl.tier === "immutable" || cl.tier === "working") continue;
    if (cl.tags.includes("unresolved_failure")) continue;
    const msg = out[i];
    if (msg.role !== "tool") continue;
    const raw = contentString(msg.content);
    if (raw.length <= 200) continue;
    if (raw.startsWith("<FILE_SHADOW") || raw.startsWith("<VERIFICATION_FOLDED")
      || raw.startsWith("<PLAN_SUPERSEDED") || raw.startsWith("<NARRATION_CONDENSED")
      || raw.startsWith("<TOOL_RESULT_PRUNED") || raw.startsWith("<CONTEXT_CHECKPOINT")) continue;
    const before = estimateMessageTokens(msg);
    const toolName = getToolName(msg) || "unknown";
    const preview = raw.slice(0, 120).replace(/\n/g, " ");
    const handle = retainToArtifact(artifactStore, raw);
    out[i] = replaceContentPreservingFormat(msg, `<STALE_EXPLORATION tool="${toolName}" chars=${raw.length}${handle}>${preview}...</STALE_EXPLORATION>`);
    const after = estimateMessageTokens(out[i]);
    const delta = before - after;
    recovered += delta;
    currentTokens -= delta;
  }

  return { messages: out, tokensRecovered: recovered };
}

// ── Heavy Compaction ───────────────────────────────────────────────────────

export interface HeavyCompactionContext {
  sessionKey: string;
  chatState: ChatState;
  fileState: FileState;
  objectiveEpoch: ObjectiveEpochState;
}

const HEAVY_COMPACTION_BUCKET_SIZE = 50;

export function applyHeavyCompaction(
  messages: ContextBudgetMessage[],
  classified: ClassifiedMessage[],
  targetTokens: number,
  ctx: HeavyCompactionContext,
  artifactStore?: ArtifactStore | null,
): { messages: ContextBudgetMessage[]; tokensRecovered: number; checkpoint: ContextCheckpoint } {
  const checkpoint = createContextCheckpoint(
    ctx.sessionKey,
    ctx.chatState,
    ctx.fileState,
    ctx.objectiveEpoch,
    classified,
  );

  let currentTokens = classified.reduce((s, c) => s + c.estimatedTokens, 0);
  const retentionThreshold = currentTokens > targetTokens * 1.1 ? 0.5 : 0.4;

  const checkpointMsg = renderCheckpointMessage(checkpoint);
  const checkpointTokens = estimateMessageTokens({ role: "system", content: checkpointMsg });

  // ── Phase 1: initial keep/drop decisions (retention-based) ──
  const keep = new Array<boolean>(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const cl = classified[i];
    if (!cl) { keep[i] = true; continue; }
    if (cl.tier === "immutable" || cl.tier === "working") { keep[i] = true; continue; }
    if (cl.retentionScore >= retentionThreshold || cl.tags.includes("unresolved_failure")) { keep[i] = true; continue; }
    keep[i] = false;
  }

  // ── Phase 2: enforce tool-call / tool-result pair integrity ──
  // The Vercel AI SDK rejects conversations where an assistant tool_call has
  // no matching tool result (AI_MissingToolResultsError).  Dropping a tool
  // result while retaining its paired assistant creates an orphan.
  const toolResultIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool" && messages[i].tool_call_id) {
      toolResultIdx.set(messages[i].tool_call_id!, i);
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (!keep[i]) continue;
    const msg = messages[i];
    if (msg.role !== "assistant" || !hasToolCalls(msg)) continue;
    for (const tc of msg.tool_calls!) {
      if (!tc.id) continue;
      const ri = toolResultIdx.get(tc.id);
      if (ri !== undefined) keep[ri] = true;
    }
  }

  // ── Phase 3: build output ──
  const out: ContextBudgetMessage[] = [];
  let droppedTokens = 0;
  let insertedCheckpoint = false;

  for (let i = 0; i < messages.length; i++) {
    if (keep[i]) {
      const cl = classified[i];
      if (!insertedCheckpoint && cl && (cl.tier === "working")) {
        out.push({ role: "system", content: checkpointMsg });
        insertedCheckpoint = true;
      }
      out.push(messages[i]);
    } else {
      if (artifactStore && messages[i].role === "tool") {
        const raw = contentString(messages[i].content);
        if (raw.length >= 100) {
          retainToArtifact(artifactStore, raw);
        }
      }
      const cl = classified[i];
      if (cl) droppedTokens += cl.estimatedTokens;
    }
  }

  if (!insertedCheckpoint && out.length > 0) {
    const firstNonSystem = out.findIndex((m) => m.role !== "system");
    const insertAt = firstNonSystem >= 0 ? firstNonSystem : out.length;
    out.splice(insertAt, 0, { role: "system", content: checkpointMsg });
  }

  snapHeavyCompactionToBucket(out, HEAVY_COMPACTION_BUCKET_SIZE, artifactStore);

  checkpoint.compactedTokenEstimate = droppedTokens;
  checkpoint.retainedMessageCount = out.length;
  checkpoint.retainedTokenEstimate = currentTokens - droppedTokens + checkpointTokens;

  return {
    messages: out,
    tokensRecovered: Math.max(0, droppedTokens - checkpointTokens),
    checkpoint,
  };
}

/**
 * After heavy compaction, drop additional low-priority messages to snap the
 * retained count down to the nearest bucket multiple.
 *
 * Invariants:
 *  - System, tool, and assistant-with-tool_calls messages are never dropped
 *    (prevents orphaned tool-call/result pairs that cause MissingToolResultsError).
 *  - Only user and plain assistant (no tool_calls) messages are candidates.
 *  - Candidates near the tail (recent) are preferred to keep; drop from the
 *    oldest candidates first.
 */
function snapHeavyCompactionToBucket(
  out: ContextBudgetMessage[],
  bucketSize: number,
  artifactStore?: ArtifactStore | null,
): void {
  if (bucketSize <= 0 || out.length <= bucketSize) return;
  const snappedTarget = Math.floor(out.length / bucketSize) * bucketSize;
  if (snappedTarget >= out.length || snappedTarget <= 0) return;
  const excess = out.length - snappedTarget;

  const droppable: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === "system") continue;
    if (m.role === "tool") continue;
    if (m.role === "assistant" && hasToolCalls(m)) continue;
    droppable.push(i);
  }

  const toRemove = new Set<number>();
  for (const idx of droppable) {
    if (toRemove.size >= excess) break;
    if (artifactStore && out[idx].role === "tool") {
      const raw = contentString(out[idx].content);
      if (raw.length >= 100) retainToArtifact(artifactStore, raw);
    }
    toRemove.add(idx);
  }

  if (toRemove.size === 0) return;
  let writeIdx = 0;
  for (let i = 0; i < out.length; i++) {
    if (!toRemove.has(i)) {
      out[writeIdx++] = out[i];
    }
  }
  out.length = writeIdx;
}


// ── Main Evaluation ────────────────────────────────────────────────────────

export interface EvaluateContextBudgetOptions {
  messages: ContextBudgetMessage[];
  tools?: unknown[];
  policy: ContextBudgetPolicy;
  retentionContext?: RetentionContext;
  heavyCompactionContext?: HeavyCompactionContext;
  enableCompaction?: boolean;
  artifactStore?: ArtifactStore | null;
}

export function evaluateContextBudget(
  options: EvaluateContextBudgetOptions,
): { evaluation: BudgetEvaluation; messages: ContextBudgetMessage[] } {
  const { messages, tools, policy, enableCompaction = true, artifactStore: artStore } = options;

  const estimate = estimateTokens(
    messages as Array<{ role: string; content: unknown }>,
    tools,
  );
  const zone = classifyZone(estimate.totalTokens, policy);

  const baseEvaluation: BudgetEvaluation = {
    zone,
    estimate,
    headroomTokens: policy.hardLimitTokens - estimate.totalTokens,
    policy,
    classification: null,
    compactionApplied: "none",
    tokensRecovered: 0,
    checkpoint: null,
  };

  if (zone === "green" || !enableCompaction) {
    return { evaluation: baseEvaluation, messages };
  }

  const classified = options.retentionContext
    ? classifyMessages(messages, options.retentionContext)
    : null;
  baseEvaluation.classification = classified;

  if (!classified) {
    return { evaluation: baseEvaluation, messages };
  }

  if (zone === "soft") {
    const softResult = applySoftCompaction(messages, classified, policy.softTokens, artStore);
    const newEstimate = estimateTokens(
      softResult.messages as Array<{ role: string; content: unknown }>,
      tools,
    );
    return {
      evaluation: {
        ...baseEvaluation,
        estimate: newEstimate,
        headroomTokens: policy.hardLimitTokens - newEstimate.totalTokens,
        zone: classifyZone(newEstimate.totalTokens, policy),
        compactionApplied: "soft",
        tokensRecovered: softResult.tokensRecovered,
      },
      messages: softResult.messages,
    };
  }

  // Heavy or emergency: always run soft first, then heavy if still above threshold
  const softResult = applySoftCompaction(messages, classified, policy.softTokens, artStore);
  const afterSoftEstimate = estimateTokens(
    softResult.messages as Array<{ role: string; content: unknown }>,
    tools,
  );
  const afterSoftZone = classifyZone(afterSoftEstimate.totalTokens, policy);

  if (afterSoftZone === "green" || afterSoftZone === "soft") {
    return {
      evaluation: {
        ...baseEvaluation,
        estimate: afterSoftEstimate,
        headroomTokens: policy.hardLimitTokens - afterSoftEstimate.totalTokens,
        zone: afterSoftZone,
        compactionApplied: "soft",
        tokensRecovered: softResult.tokensRecovered,
      },
      messages: softResult.messages,
    };
  }

  if (!options.heavyCompactionContext) {
    return {
      evaluation: {
        ...baseEvaluation,
        estimate: afterSoftEstimate,
        headroomTokens: policy.hardLimitTokens - afterSoftEstimate.totalTokens,
        zone: afterSoftZone,
        compactionApplied: "soft",
        tokensRecovered: softResult.tokensRecovered,
      },
      messages: softResult.messages,
    };
  }

  const reclassified = options.retentionContext
    ? classifyMessages(softResult.messages, options.retentionContext)
    : classified;

  const heavyResult = applyHeavyCompaction(
    softResult.messages,
    reclassified,
    policy.heavyTokens,
    options.heavyCompactionContext,
    artStore,
  );
  const afterHeavyEstimate = estimateTokens(
    heavyResult.messages as Array<{ role: string; content: unknown }>,
    tools,
  );

  return {
    evaluation: {
      ...baseEvaluation,
      estimate: afterHeavyEstimate,
      headroomTokens: policy.hardLimitTokens - afterHeavyEstimate.totalTokens,
      zone: classifyZone(afterHeavyEstimate.totalTokens, policy),
      compactionApplied: zone === "emergency" ? "emergency" : "heavy",
      tokensRecovered: softResult.tokensRecovered + heavyResult.tokensRecovered,
      classification: reclassified,
      checkpoint: heavyResult.checkpoint,
    },
    messages: heavyResult.messages,
  };
}
