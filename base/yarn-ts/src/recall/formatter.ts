/**
 * Format recall resolutions into structured text blocks:
 * - Synthetic response (bypass): a full deterministic answer block
 * - Enrichment block (enrich): context appended to tool results before LLM
 * - Self-repair block: verification-loop-aware fix suggestions
 */

import type { RecallResolution, ResolvedFinding } from "./types.js";
import type { VerificationLoopState } from "../verification/types.js";

/**
 * Build a synthetic deterministic response block from a fully resolved set
 * of findings. Used when recall confidence >= bypass threshold.
 */
export function formatSyntheticResponse(resolution: RecallResolution): string {
  const lines: string[] = [
    `<synesis_recall_bypass confidence="${resolution.confidence.toFixed(2)}" language="${resolution.language ?? "unknown"}" deterministic="true">`,
    `Found ${resolution.findings.length} issue(s) with deterministic resolution:`,
    "",
  ];

  for (let i = 0; i < resolution.findings.length; i++) {
    const f = resolution.findings[i];
    lines.push(`${i + 1}. ${f.message}`);
    if (f.file) lines.push(`   File: ${f.file}`);
    if (f.errorFamily !== "unknown") lines.push(`   Error family: ${f.errorFamily}`);
    if (f.rootCause) lines.push(`   Root cause: ${f.rootCause}`);
    if (f.recipe) {
      lines.push(`   Fix: ${f.recipe.template}`);
      if (f.recipe.description) lines.push(`   Detail: ${f.recipe.description}`);
      if (f.recipe.steps?.length) {
        lines.push(`   Steps: ${f.recipe.steps.join(" → ")}`);
      }
      if (f.recipe.constraints) lines.push(`   Constraints: ${f.recipe.constraints}`);
    }
    if (f.action) lines.push(`   Next step: ${f.action}`);
    lines.push("");
  }

  lines.push("</synesis_recall_bypass>");
  return lines.join("\n");
}

/**
 * Build an enrichment context block from a partially resolved set.
 * Appended to the tool result before LLM inference to reduce its burden.
 */
export function formatEnrichmentBlock(resolution: RecallResolution): string {
  const withRecipes = resolution.findings.filter((f) => f.recipe);
  if (withRecipes.length === 0) return "";

  const lines: string[] = [
    `<synesis_recall_enrichment confidence="${resolution.confidence.toFixed(2)}" hints="${withRecipes.length}">`,
  ];

  for (const f of withRecipes) {
    lines.push(formatFindingHint(f));
  }

  lines.push("</synesis_recall_enrichment>");
  return lines.join("\n");
}

function formatFindingHint(f: ResolvedFinding): string {
  const parts = [`- [${f.errorFamily}]`];
  if (f.rootCause) parts.push(`cause: ${f.rootCause}`);
  if (f.recipe) parts.push(`fix: ${f.recipe.template}`);
  return parts.join(" | ");
}

/**
 * Build a self-repair suggestion block for use inside a verification loop.
 * Tells the LLM which findings have deterministic fixes and which need reasoning.
 */
export function formatSelfRepairBlock(
  resolution: RecallResolution,
  loopState: VerificationLoopState,
): string | null {
  const withRecipes = resolution.findings.filter((f) => f.recipe);
  const withoutRecipes = resolution.findings.filter((f) => !f.recipe && f.errorFamily !== "unknown");

  if (withRecipes.length === 0) return null;

  const lines: string[] = [
    `<synesis_self_repair round="${loopState.round}" deterministic="${withRecipes.length}" reasoning="${withoutRecipes.length}" total="${resolution.findings.length}">`,
  ];

  if (withRecipes.length > 0) {
    lines.push("Deterministic fixes available:");
    for (const f of withRecipes) {
      lines.push(`  - [${f.errorFamily}] ${f.recipe!.template}`);
      if (f.file) lines.push(`    File: ${f.file}`);
    }
  }

  if (withoutRecipes.length > 0) {
    lines.push("");
    lines.push("Require reasoning:");
    for (const f of withoutRecipes) {
      lines.push(`  - [${f.errorFamily}] ${f.message}`);
      if (f.rootCause) lines.push(`    Cause: ${f.rootCause}`);
    }
  }

  lines.push("</synesis_self_repair>");
  return lines.join("\n");
}
