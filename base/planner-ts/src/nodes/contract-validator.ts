import crypto from "node:crypto";
import type { GraphState } from "../state/types.js";

export type ValidationResult = { passed: boolean; violations: string[] };

export function fingerprintDraft(draft: string): string {
  return crypto.createHash("blake2b512").update(draft).digest("hex").slice(0, 32);
}

export function validateStyleCompliance(state: GraphState): ValidationResult {
  const contract = state.style_contract_locked ?? {};
  const draft = state.generated_code ?? "";
  if (!contract || draft.length === 0) return { passed: true, violations: [] };

  const violations: string[] = [];
  if (Boolean(contract.direct_answer_first ?? true)) {
    const firstParagraph = draft.trim().split("\n\n")[0]?.toLowerCase() ?? "";
    const preamble = ["before we begin", "let me start by", "first, let's", "in this response"];
    if (preamble.some((marker) => firstParagraph.includes(marker))) {
      violations.push("style: direct_answer_first violated - response starts with preamble");
    }
  }
  return { passed: violations.length === 0, violations };
}

export function validateDecisionDrift(state: GraphState): ValidationResult {
  const ledger = state.decision_ledger ?? [];
  const draft = (state.generated_code ?? "").toLowerCase();
  if (ledger.length === 0 || draft.length === 0) return { passed: true, violations: [] };

  const overrideLog = state.override_log ?? [];
  const approvedOverrides = new Set(
    overrideLog.filter((entry) => Boolean(entry.approved)).map((entry) => String(entry.target_decision_id ?? ""))
  );

  const violations: string[] = [];
  for (const entry of ledger) {
    if (!entry.frozen) continue;
    const decisionId = String(entry.decision_id ?? "");
    if (approvedOverrides.has(decisionId)) continue;
    const chosen = String(entry.chosen ?? "").toLowerCase().trim();
    const rejected = (entry.rejected_alternatives ?? []).map((alt) => String(alt).toLowerCase().trim());
    if (!chosen || rejected.length === 0) continue;
    for (const alt of rejected) {
      if (alt.length < 3) continue;
      if (draft.includes(alt) && !draft.includes(chosen)) {
        violations.push(
          `decision_drift: ledger chose '${entry.chosen}' but draft uses rejected alternative '${alt}' (decision_id=${decisionId})`
        );
      }
    }
  }
  return { passed: violations.length === 0, violations };
}

export function validateCitationPreservation(state: GraphState): ValidationResult {
  const fingerprints = state.draft_fingerprints ?? [];
  if (fingerprints.length < 2) return { passed: true, violations: [] };
  const urls = state.rag_source_urls ?? [];
  const names = state.rag_document_names ?? [];
  if (urls.length === 0 && names.length === 0) return { passed: true, violations: [] };

  const draft = (state.generated_code ?? "").toLowerCase();
  if (!draft) return { passed: true, violations: [] };

  const citations = new Set<string>();
  for (const url of urls) if (url.trim()) citations.add(url.trim().toLowerCase());
  for (const name of names) if (name.trim()) citations.add(name.trim().toLowerCase());

  const violations: string[] = [];
  for (const citation of citations) {
    if (citation.length < 4) continue;
    if (!draft.includes(citation)) violations.push(`citation_dropped: ${citation.slice(0, 60)}`);
  }
  return { passed: violations.length === 0, violations };
}

export function annotateViolations(
  state: GraphState,
  violations: string[]
): { critique_register: NonNullable<GraphState["critique_register"]> } {
  const register = { ...(state.critique_register ?? {}) };
  for (const violation of violations) {
    const itemId = `validator_${crypto.createHash("sha256").update(violation).digest("hex").slice(0, 16)}`;
    register[itemId] = {
      item_id: itemId,
      category: violation.includes(":") ? violation.split(":")[0] ?? "validation" : "validation",
      description: violation,
      status: "open",
      evidence_ref: "deterministic_validator",
      resolved_by: "",
      reopen_count: 0
    };
  }
  return { critique_register: register };
}
