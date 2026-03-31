/**
 * Format recall resolutions into structured text blocks:
 * - Synthetic response (bypass): a full deterministic answer block
 * - Enrichment block (enrich): context appended to tool results before LLM
 */

import type { RecallResolution, ResolvedFinding } from "./types.js";

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
