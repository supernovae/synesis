import { createHash } from "node:crypto";
import type { ModelExecutionPolicy } from "../providers/model-architecture-profile.js";

export type CriticalFactPinSource =
  | "user_constraint"
  | "developer_instruction"
  | "schema_obligation"
  | "tool_result"
  | "file_reference"
  | "security_policy"
  | "task_commitment";

export interface CriticalFactPin {
  id: string;
  source: CriticalFactPinSource;
  text: string;
  evidenceBlockIds: string[];
}

export interface EvidenceManifest {
  blockId: string;
  kind: "message" | "tool_result" | "governance" | "file_reference" | "policy";
  digest: string;
  summary: string;
  critical: boolean;
}

export interface ContextHygieneReport {
  totalBlocks: number;
  duplicateBlocks: number;
  staleBlocks: number;
  contradictoryBlocks: number;
  lowRelevanceBlocks: number;
  criticalFactBlocks: number;
  manifestBlocks: number;
  retainedBlocks: number;
  removedBlockIds: string[];
  hygieneScore: number;
  warnings: string[];
}

export interface ContextMediationArtifacts {
  criticalFactPins: CriticalFactPin[];
  evidenceManifest: EvidenceManifest[];
  hygieneReport: ContextHygieneReport;
  activeStateHeader: string | null;
  activeStateHeaderHash: string | null;
  verificationWarnings: string[];
}

interface BuildContextMediationArtifactsInput {
  messages: unknown[];
  governanceBlocks?: string[];
  policy: ModelExecutionPolicy;
  projectRoot?: string | null;
  shellCwd?: string | null;
  objective?: string | null;
}

export function buildContextMediationArtifacts(
  input: BuildContextMediationArtifactsInput,
): ContextMediationArtifacts {
  const blocks = [
    ...input.messages.map((message, index) => ({
      kind: messageKind(message),
      text: messageToText(message),
      seed: `message:${index}`,
    })),
    ...(input.governanceBlocks ?? []).map((text, index) => ({
      kind: "governance" as const,
      text,
      seed: `governance:${index}`,
    })),
  ].filter((block) => block.text.trim().length > 0);
  const evidenceManifest = input.policy.retrieval.evidenceManifest || input.policy.mediationMode === "observe"
    ? blocks.map((block) => buildEvidenceManifestEntry(block.text, block.kind, block.seed)).slice(0, 24)
    : [];
  const criticalFactPins = input.policy.stateReinforcement.criticalFactPins || input.policy.mediationMode === "observe"
    ? extractCriticalFactPins(blocks.map((block) => ({ ...block, blockId: stableBlockId(block.text, block.seed) }))).slice(0, 16)
    : [];
  const hygieneReport = buildContextHygieneReport(blocks.map((block) => block.text), criticalFactPins, evidenceManifest);
  const verificationWarnings = [
    ...verifyEvidenceBlockReferences(
      blocks.map((block) => block.text).join("\n"),
      evidenceManifest,
    ),
  ];
  const activeStateHeader = input.policy.stateReinforcement.activeStateHeader
    ? buildActiveStateHeader({
        policy: input.policy,
        pins: criticalFactPins,
        manifest: evidenceManifest,
        hygieneReport,
        projectRoot: input.projectRoot,
        shellCwd: input.shellCwd,
        objective: input.objective,
      })
    : null;

  return {
    criticalFactPins,
    evidenceManifest,
    hygieneReport,
    activeStateHeader,
    activeStateHeaderHash: activeStateHeader ? shortHash(activeStateHeader) : null,
    verificationWarnings,
  };
}

export function filterContextBlocksForMediation(
  blocks: string[],
  policy: ModelExecutionPolicy,
): { blocks: string[]; hygieneReport: ContextHygieneReport } {
  if (!policy.canonicalization.dedupe && !policy.canonicalization.stalenessFiltering) {
    return {
      blocks,
      hygieneReport: buildContextHygieneReport(blocks, [], []),
    };
  }
  const seen = new Set<string>();
  const retained: string[] = [];
  const removedBlockIds: string[] = [];
  let duplicateBlocks = 0;
  let staleBlocks = 0;
  for (const [index, block] of blocks.entries()) {
    const canonical = canonicalBlock(block);
    const blockId = stableBlockId(block, `governance:${index}`);
    if (policy.canonicalization.dedupe && seen.has(canonical)) {
      duplicateBlocks++;
      removedBlockIds.push(blockId);
      continue;
    }
    seen.add(canonical);
    if (policy.canonicalization.stalenessFiltering && isStaleLowValueBlock(block)) {
      staleBlocks++;
      removedBlockIds.push(blockId);
      continue;
    }
    retained.push(block);
  }
  const report = buildContextHygieneReport(retained, [], []);
  return {
    blocks: retained,
    hygieneReport: {
      ...report,
      totalBlocks: blocks.length,
      duplicateBlocks,
      staleBlocks,
      retainedBlocks: retained.length,
      removedBlockIds,
      hygieneScore: scoreHygiene(blocks.length, duplicateBlocks, staleBlocks, 0, 0),
    },
  };
}

export function verifyEvidenceBlockReferences(text: string, manifest: EvidenceManifest[]): string[] {
  const known = new Set(manifest.map((entry) => entry.blockId));
  const cited = Array.from(text.matchAll(/\bctx-[a-f0-9]{10}\b/g)).map((match) => match[0]);
  const missing = [...new Set(cited.filter((id) => !known.has(id)))];
  return missing.map((id) => `missing_evidence_block_id:${id}`);
}

export function verifyLongContextRecall(
  text: string,
  pins: CriticalFactPin[],
): string[] {
  const normalized = text.toLowerCase();
  return pins
    .filter((pin) => pin.source === "user_constraint" || pin.source === "security_policy")
    .filter((pin) => !normalized.includes(pin.text.slice(0, 80).toLowerCase()))
    .map((pin) => `critical_fact_not_recalled:${pin.id}`);
}

function buildActiveStateHeader(input: {
  policy: ModelExecutionPolicy;
  pins: CriticalFactPin[];
  manifest: EvidenceManifest[];
  hygieneReport: ContextHygieneReport;
  projectRoot?: string | null;
  shellCwd?: string | null;
  objective?: string | null;
}): string {
  const lines = [
    `<SYNESIS_ACTIVE_STATE mode="${input.policy.mediationMode}" policy_hash="${input.policy.policyHash}">`,
    `context_interpretation: ${input.policy.contextBudget.interpretation}`,
    `project_root: ${input.projectRoot || "unknown"}`,
    `shell_cwd: ${input.shellCwd || "unknown"}`,
  ];
  if (input.objective) lines.push(`objective: ${trimLine(input.objective, 220)}`);
  lines.push(`hygiene_score: ${input.hygieneReport.hygieneScore}`);
  if (input.pins.length > 0) {
    lines.push("critical_fact_pins:");
    for (const pin of input.pins.slice(0, 12)) {
      lines.push(`  - ${pin.id} ${pin.source}: ${trimLine(pin.text, 240)}`);
    }
  }
  if (input.manifest.length > 0) {
    lines.push("evidence_manifest:");
    for (const entry of input.manifest.slice(0, 12)) {
      lines.push(`  - ${entry.blockId} ${entry.kind} critical=${entry.critical} digest=${entry.digest}: ${trimLine(entry.summary, 180)}`);
    }
  }
  lines.push("</SYNESIS_ACTIVE_STATE>");
  return lines.join("\n");
}

function buildEvidenceManifestEntry(
  text: string,
  kind: EvidenceManifest["kind"],
  seed: string,
): EvidenceManifest {
  return {
    blockId: stableBlockId(text, seed),
    kind,
    digest: shortHash(canonicalBlock(text)),
    summary: trimLine(text.replace(/\s+/g, " "), 220),
    critical: isCriticalText(text),
  };
}

function extractCriticalFactPins(
  blocks: Array<{ text: string; kind: EvidenceManifest["kind"]; blockId: string }>,
): CriticalFactPin[] {
  const pins: CriticalFactPin[] = [];
  for (const block of blocks) {
    const source = classifyPinSource(block.text, block.kind);
    if (!source) continue;
    for (const fact of splitFactCandidates(block.text).slice(0, 3)) {
      pins.push({
        id: `pin-${shortHash(`${source}:${fact}`).slice(0, 10)}`,
        source,
        text: fact,
        evidenceBlockIds: [block.blockId],
      });
    }
  }
  return dedupeBy(pins, (pin) => pin.id);
}

function buildContextHygieneReport(
  blocks: string[],
  pins: CriticalFactPin[],
  manifest: EvidenceManifest[],
): ContextHygieneReport {
  const canonicalCounts = new Map<string, number>();
  let staleBlocks = 0;
  let contradictoryBlocks = 0;
  let lowRelevanceBlocks = 0;
  let criticalFactBlocks = 0;
  for (const block of blocks) {
    const canonical = canonicalBlock(block);
    canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1);
    if (isStaleLowValueBlock(block)) staleBlocks++;
    if (looksContradictory(block)) contradictoryBlocks++;
    if (isLowRelevanceBlock(block)) lowRelevanceBlocks++;
    if (isCriticalText(block)) criticalFactBlocks++;
  }
  const duplicateBlocks = Array.from(canonicalCounts.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const warnings: string[] = [];
  if (duplicateBlocks > 0) warnings.push(`duplicate_blocks:${duplicateBlocks}`);
  if (staleBlocks > 0) warnings.push(`stale_blocks:${staleBlocks}`);
  if (contradictoryBlocks > 0) warnings.push(`contradictory_blocks:${contradictoryBlocks}`);
  return {
    totalBlocks: blocks.length,
    duplicateBlocks,
    staleBlocks,
    contradictoryBlocks,
    lowRelevanceBlocks,
    criticalFactBlocks: Math.max(criticalFactBlocks, pins.length),
    manifestBlocks: manifest.length,
    retainedBlocks: blocks.length,
    removedBlockIds: [],
    hygieneScore: scoreHygiene(blocks.length, duplicateBlocks, staleBlocks, contradictoryBlocks, lowRelevanceBlocks),
    warnings,
  };
}

function classifyPinSource(text: string, kind: EvidenceManifest["kind"]): CriticalFactPinSource | null {
  if (kind === "tool_result") return "tool_result";
  if (kind === "file_reference") return "file_reference";
  if (/\b(security|sandbox|permission|approval|secret|token|policy)\b/i.test(text)) return "security_policy";
  if (/\b(todo|task|plan|commitment|next_best_action)\b/i.test(text)) return "task_commitment";
  if (/\b(must|must not|never|always|required|requirement|constraint|do not|don't)\b/i.test(text)) {
    return "user_constraint";
  }
  if (/\b(schema|json_schema|response_format|tool_choice|strict)\b/i.test(text)) return "schema_obligation";
  if (kind === "policy" || kind === "governance") return "developer_instruction";
  return null;
}

function splitFactCandidates(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => trimLine(line.replace(/^[\s*>-]+/g, ""), 260))
    .filter((line) => line.length >= 12)
    .filter((line) => /\b(must|must not|never|always|required|constraint|do not|don't|failed|passed|next|schema|security|policy|file|path|tool|task|commitment)\b/i.test(line));
}

function messageKind(message: unknown): EvidenceManifest["kind"] {
  const record = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : {};
  const role = typeof record.role === "string" ? record.role : "";
  if (role === "tool" || role === "function") return "tool_result";
  const text = messageToText(message);
  if (/\/[A-Za-z0-9._/-]+/.test(text)) return "file_reference";
  if (role === "system" || role === "developer") return "policy";
  return "message";
}

function messageToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(messageToText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return messageToText(record.content);
    return Object.entries(record)
      .filter(([key]) => ["role", "content", "name", "tool_call_id"].includes(key))
      .map(([, item]) => messageToText(item))
      .filter(Boolean)
      .join(" ");
  }
  return String(value);
}

function stableBlockId(text: string, seed: string): string {
  return `ctx-${shortHash(`${seed}:${canonicalBlock(text)}`).slice(0, 10)}`;
}

function canonicalBlock(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function trimLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 3))}...`;
}

function isCriticalText(text: string): boolean {
  return /\b(must|must not|never|always|required|security|schema|tool result|failed|passed|do not|don't|critical)\b/i.test(text);
}

function isStaleLowValueBlock(text: string): boolean {
  return /\b(stale|obsolete|superseded|outdated|ignore previous|no longer relevant)\b/i.test(text) && !isCriticalText(text);
}

function isLowRelevanceBlock(text: string): boolean {
  return text.trim().length < 20 || /\b(lorem ipsum|placeholder|todo:?\s*$)\b/i.test(text);
}

function looksContradictory(text: string): boolean {
  return /\b(previously|earlier).{0,80}\b(now|instead)\b/i.test(text)
    || /\b(conflicts? with|contradicts?|but actually)\b/i.test(text);
}

function scoreHygiene(total: number, duplicates: number, stale: number, contradictions: number, lowRelevance: number): number {
  if (total <= 0) return 100;
  const penalty = duplicates * 10 + stale * 12 + contradictions * 18 + lowRelevance * 4;
  return Math.max(0, Math.min(100, 100 - Math.round((penalty / Math.max(1, total)) * 10)));
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}
