/**
 * Chunked Evaluation Protocol — structured multi-pass workflow for
 * validating a project against a set of requirements.
 *
 * Instead of loading the entire codebase into context, the protocol
 * decomposes the task into per-feature sub-evaluations, each with a
 * bounded context budget, and aggregates findings into a synthesis.
 *
 * Three phases:
 *   1. Index   — build/refresh structural index, model sees file tree + signatures
 *   2. Map     — per-feature, load relevant files, evaluate, store finding
 *   3. Synthesize — load all findings, produce gap analysis
 */

import type {
  ChunkedEvalPlan,
  ChunkedEvalStats,
  FeatureFinding,
  FeatureRequirement,
} from "./types.js";

// ---------------------------------------------------------------------------
// Requirement parser — extract features from a validation prompt
// ---------------------------------------------------------------------------

const NUMBERED_LIST_RE = /^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)$/gm;
const FEATURE_KEYWORDS = /\b(implement|support|add|include|provide|enable|create|build|handle|validate)\b/i;

/**
 * Heuristic: detect whether a prompt contains a "validate N features" pattern
 * that should trigger chunked evaluation.
 */
export function shouldChunkEval(
  userText: string,
  featureCountThreshold = 5,
): boolean {
  const items = extractRequirements(userText);
  if (items.length >= featureCountThreshold) return true;

  const validatePattern = /\b(?:validate|verify|check|ensure|confirm)\b.*\b(?:features?|requirements?|capabilities|behaviors?)\b/i;
  if (validatePattern.test(userText) && items.length >= 3) return true;

  return false;
}

/**
 * Extract feature requirements from a prompt. Looks for numbered/bulleted
 * lists and sentences with implementation keywords.
 */
export function extractRequirements(text: string): FeatureRequirement[] {
  const requirements: FeatureRequirement[] = [];
  const seen = new Set<string>();

  NUMBERED_LIST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBERED_LIST_RE.exec(text)) !== null) {
    const desc = m[1].trim();
    if (desc.length >= 5 && desc.length < 500 && !seen.has(desc.toLowerCase())) {
      seen.add(desc.toLowerCase());
      requirements.push({
        id: `req_${requirements.length + 1}`,
        description: desc,
      });
    }
  }

  if (requirements.length === 0) {
    const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 15);
    for (const s of sentences) {
      if (FEATURE_KEYWORDS.test(s) && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        requirements.push({
          id: `req_${requirements.length + 1}`,
          description: s,
        });
      }
    }
  }

  return requirements;
}

// ---------------------------------------------------------------------------
// Eval plan management
// ---------------------------------------------------------------------------

export function createEvalPlan(requirements: FeatureRequirement[]): ChunkedEvalPlan {
  return {
    requirements,
    currentPhase: "index",
    currentFeatureIndex: 0,
    findings: [],
    synthesisResult: undefined,
  };
}

export function advancePhase(plan: ChunkedEvalPlan): ChunkedEvalPlan {
  const updated = { ...plan };

  switch (plan.currentPhase) {
    case "index":
      updated.currentPhase = "map_features";
      updated.currentFeatureIndex = 0;
      break;
    case "map_features":
      if (plan.currentFeatureIndex >= plan.requirements.length - 1) {
        updated.currentPhase = "synthesize";
      } else {
        updated.currentFeatureIndex = plan.currentFeatureIndex + 1;
      }
      break;
    case "synthesize":
      break;
  }

  return updated;
}

export function addFinding(plan: ChunkedEvalPlan, finding: FeatureFinding): ChunkedEvalPlan {
  return {
    ...plan,
    findings: [...plan.findings, finding],
  };
}

// ---------------------------------------------------------------------------
// Context generation per phase
// ---------------------------------------------------------------------------

/**
 * Generate the system context block for the current phase of chunked evaluation.
 */
export function generateEvalPhaseContext(
  plan: ChunkedEvalPlan,
  structuralMap: string | null,
  featureFilesContent?: string,
): string {
  switch (plan.currentPhase) {
    case "index":
      return [
        "<CHUNKED_EVAL phase=\"index\">",
        `Evaluating ${plan.requirements.length} requirements against the project.`,
        "You are in the INDEX phase. Review the structural index below and identify",
        "which files are relevant to each requirement. Do NOT read all files.",
        "",
        structuralMap ?? "(structural index not available — request file listing)",
        "",
        "Requirements to evaluate:",
        ...plan.requirements.map((r, i) => `  ${i + 1}. [${r.id}] ${r.description}`),
        "",
        "For each requirement, identify the likely relevant files from the index.",
        "Then call StoreObservation with topic='feature_map' for each mapping.",
        "</CHUNKED_EVAL>",
      ].join("\n");

    case "map_features": {
      const req = plan.requirements[plan.currentFeatureIndex];
      if (!req) return "";
      const prevFindings = plan.findings
        .map((f) => `  [${f.featureId}] ${f.status}: ${f.evidence.slice(0, 100)}`)
        .join("\n");
      return [
        `<CHUNKED_EVAL phase="map_features" feature="${req.id}" index="${plan.currentFeatureIndex + 1}/${plan.requirements.length}">`,
        `Evaluate requirement: ${req.description}`,
        "",
        req.relevantFiles?.length
          ? `Relevant files: ${req.relevantFiles.join(", ")}`
          : "Identify relevant files from the structural index.",
        "",
        featureFilesContent ?? "",
        "",
        "Evaluate whether this requirement is implemented, partial, or missing.",
        "Call StoreObservation with topic='" + req.id + "' and your finding.",
        prevFindings ? `\nPrevious findings:\n${prevFindings}` : "",
        "</CHUNKED_EVAL>",
      ].join("\n");
    }

    case "synthesize": {
      const allFindings = plan.findings
        .map((f) => `[${f.featureId}] ${f.status} (confidence: ${f.confidence}): ${f.evidence}`)
        .join("\n");
      return [
        "<CHUNKED_EVAL phase=\"synthesize\">",
        `All ${plan.findings.length} feature evaluations complete. Synthesize findings:`,
        "",
        allFindings,
        "",
        "Produce a gap analysis: which requirements are fully implemented,",
        "which are partial, and which are missing. Suggest an action plan",
        "for completing any gaps.",
        "</CHUNKED_EVAL>",
      ].join("\n");
    }

    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function createEmptyChunkedEvalStats(): ChunkedEvalStats {
  return {
    evalsStarted: 0,
    featuresEvaluated: 0,
    synthesesCompleted: 0,
    avgFindingsPerEval: 0,
  };
}

/**
 * Format a chunked eval plan summary for injection into system context,
 * showing progress through the evaluation.
 */
export function formatEvalProgress(plan: ChunkedEvalPlan): string {
  const total = plan.requirements.length;
  const evaluated = plan.findings.length;
  const implemented = plan.findings.filter((f) => f.status === "implemented").length;
  const partial = plan.findings.filter((f) => f.status === "partial").length;
  const missing = plan.findings.filter((f) => f.status === "missing").length;

  return [
    `<EVAL_PROGRESS phase="${plan.currentPhase}" evaluated="${evaluated}/${total}">`,
    `Implemented: ${implemented}, Partial: ${partial}, Missing: ${missing}`,
    plan.currentPhase === "map_features"
      ? `Current: ${plan.requirements[plan.currentFeatureIndex]?.description ?? "done"}`
      : "",
    "</EVAL_PROGRESS>",
  ].filter(Boolean).join("\n");
}
