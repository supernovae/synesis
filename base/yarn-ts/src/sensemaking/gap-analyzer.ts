/**
 * Gap Analyzer — classifies evidence signals into Known / Unknown / KnowBetter
 * buckets and determines whether sensemaking should be triggered.
 */

import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { EvidenceGap, GapAnalysisContext, GapClassification } from "./types.js";

const DEFAULT_GAP_THRESHOLD = 0.5;

export function analyzeGaps(ctx: GapAnalysisContext): GapClassification {
  const known: EvidenceGap[] = [];
  const unknown: EvidenceGap[] = [];
  const knowBetter: EvidenceGap[] = [];

  classifyRecall(ctx, known, unknown, knowBetter);
  classifyEvidence(ctx, known, unknown, knowBetter);
  classifyVerification(ctx, known, unknown, knowBetter);
  classifyLanguageCoverage(ctx, known, unknown, knowBetter);

  return { known, unknown, knowBetter };
}

function classifyRecall(
  ctx: GapAnalysisContext,
  known: EvidenceGap[],
  unknown: EvidenceGap[],
  knowBetter: EvidenceGap[],
): void {
  const { recallDecision } = ctx;
  if (!recallDecision || recallDecision.routing === "passthrough") {
    if (ctx.userText.length > 0) {
      unknown.push({
        kind: "unknown",
        domain: "recall",
        description: "No recall match for this request — no fix recipes or pattern matches found",
        suggestedAction: "Search the knowledge base for related documentation or examples",
      });
    }
    return;
  }

  if (recallDecision.routing === "bypass" && recallDecision.resolution) {
    const conf = recallDecision.resolution.confidence;
    if (conf >= 0.85) {
      known.push({
        kind: "known",
        domain: "recall",
        description: `High-confidence recall match (${(conf * 100).toFixed(0)}%) with ${recallDecision.resolution.findings.length} resolved finding(s)`,
        suggestedAction: "Apply deterministic fix directly",
      });
    } else {
      knowBetter.push({
        kind: "know_better",
        domain: "recall",
        description: `Recall match found but confidence is moderate (${(conf * 100).toFixed(0)}%)`,
        suggestedAction: "Verify the recall suggestion against project-specific conventions",
      });
    }
    return;
  }

  if (recallDecision.routing === "enrich" && recallDecision.resolution) {
    knowBetter.push({
      kind: "know_better",
      domain: "recall",
      description: `Partial recall match (enrich routing, confidence ${(recallDecision.resolution.confidence * 100).toFixed(0)}%)`,
      suggestedAction: "Use recall evidence as context but verify against project specifics",
    });
  }
}

function classifyEvidence(
  ctx: GapAnalysisContext,
  known: EvidenceGap[],
  unknown: EvidenceGap[],
  knowBetter: EvidenceGap[],
): void {
  if (!ctx.evidencePrefetched) {
    return;
  }

  const conf = ctx.evidenceConfidence ?? 0;
  const authoritative = ctx.evidenceAuthoritative ?? false;

  if (conf >= 0.85 && authoritative) {
    known.push({
      kind: "known",
      domain: "evidence",
      description: `Authoritative evidence prefetched with high confidence (${(conf * 100).toFixed(0)}%)`,
      suggestedAction: "Use evidence directly in the response",
    });
  } else if (conf >= 0.5) {
    knowBetter.push({
      kind: "know_better",
      domain: "evidence",
      description: authoritative
        ? `Authoritative evidence with moderate confidence (${(conf * 100).toFixed(0)}%)`
        : `Evidence prefetched but not authoritative (confidence ${(conf * 100).toFixed(0)}%)`,
      suggestedAction: authoritative
        ? "Cross-reference with project context for stronger confidence"
        : "Search for more authoritative sources to confirm",
    });
  } else if (conf > 0) {
    knowBetter.push({
      kind: "know_better",
      domain: "evidence",
      description: `Low-confidence evidence available (${(conf * 100).toFixed(0)}%)`,
      suggestedAction: "Query knowledge base for stronger evidence before acting",
    });
  }
}

function classifyVerification(
  ctx: GapAnalysisContext,
  known: EvidenceGap[],
  unknown: EvidenceGap[],
  knowBetter: EvidenceGap[],
): void {
  const { verificationState } = ctx;
  if (verificationState.round === 0) return;

  if (verificationState.allResolved) {
    known.push({
      kind: "known",
      domain: "verification",
      description: `All verification findings resolved in ${verificationState.round} round(s)`,
      suggestedAction: "Verification complete — findings addressed",
    });
    return;
  }

  if (verificationState.stalled) {
    knowBetter.push({
      kind: "know_better",
      domain: "verification",
      description: `Verification stalled at round ${verificationState.round} with ${verificationState.findings.length} unresolved finding(s)`,
      suggestedAction: "Try a different approach or gather more context about the failing checks",
    });
    return;
  }

  if (verificationState.findings.length > 0) {
    knowBetter.push({
      kind: "know_better",
      domain: "verification",
      description: `${verificationState.findings.length} finding(s) remain after ${verificationState.round} verification round(s)`,
      suggestedAction: "Run targeted verification commands to narrow root cause",
    });
  }
}

function classifyLanguageCoverage(
  ctx: GapAnalysisContext,
  known: EvidenceGap[],
  unknown: EvidenceGap[],
  _knowBetter: EvidenceGap[],
): void {
  if (ctx.languages.length === 0) {
    unknown.push({
      kind: "unknown",
      domain: "language",
      description: "No language detected for this request — no language pack intelligence available",
      suggestedAction: "Inspect the project to identify languages and frameworks in use",
    });
    return;
  }

  for (const lang of ctx.languages) {
    known.push({
      kind: "known",
      domain: "language",
      description: `Language pack available for ${lang}`,
      suggestedAction: `Use ${lang} pack for validation, fix recipes, and verification commands`,
    });
  }
}

export function shouldTriggerSensemaking(
  gaps: GapClassification,
  decision: OrchestratorDecision,
  consecutiveFailedVerifications: number,
  gapThreshold = DEFAULT_GAP_THRESHOLD,
  hardStopOnly = false,
): { trigger: boolean; reason?: string } {
  if (hardStopOnly) {
    if (
      consecutiveFailedVerifications >= 4
      && gaps.unknown.length > 0
      && (decision.decisionPath === "abstain" || decision.phase === "validation")
    ) {
      return { trigger: true, reason: "hard_stop_diagnostics" };
    }
    return { trigger: false };
  }

  if (decision.phase === "explore") {
    return { trigger: true, reason: "explore_phase" };
  }

  if (decision.decisionPath === "abstain") {
    return { trigger: true, reason: "abstain_path" };
  }

  if (consecutiveFailedVerifications >= 2 && gaps.unknown.length > 0) {
    return { trigger: true, reason: "repeated_verification_failures" };
  }

  const total = gaps.known.length + gaps.unknown.length + gaps.knowBetter.length;
  if (total > 0) {
    const knowBetterRatio = gaps.knowBetter.length / total;
    if (knowBetterRatio > gapThreshold) {
      return { trigger: true, reason: "high_know_better_ratio" };
    }
  }

  return { trigger: false };
}
