import { enrichItems, type ParsedItem } from "../enrich-bridge.js";
import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class TerraformReducer implements Reducer {
  readonly family = "terraform" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const changes: string[] = [];
    const errors: string[] = [];
    const errorItems: ParsedItem[] = [];
    let planSummary = "";
    let applySummary = "";

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (/^(#|~|\+|-|<=)\s+(resource|data|module)/.test(trimmed) || /^\s*(~|\+|-)\s+\w+/.test(line)) {
        if (/^(#|~|\+|-)\s/.test(trimmed)) changes.push(trimmed);
      } else if (/^Plan:/.test(trimmed)) {
        planSummary = trimmed;
      } else if (/^Apply complete!/.test(trimmed)) {
        applySummary = trimmed;
      } else if (/^Error:/.test(trimmed) || /^│\s*Error/.test(trimmed)) {
        const msg = trimmed.replace(/^│\s*/, "");
        errors.push(msg);
        errorItems.push({ message: msg.replace(/^Error:\s*/, "") });
      }
    }

    if (changes.length === 0 && errors.length === 0 && !planSummary && !applySummary) return null;
    const limit = input.context.profile === "ultra" ? 8 : 16;

    const { items: enriched, enrichedLines, bypassEligible } = enrichItems(
      this.family,
      errorItems.slice(0, 5)
    );

    const parts: string[] = [`<TOOL_REDUCED family="terraform" changes="${changes.length}">`];
    if (planSummary) parts.push(planSummary);
    if (applySummary) parts.push(applySummary);
    if (enrichedLines.length > 0) {
      parts.push(`errors (${errors.length}):`);
      parts.push(...enrichedLines);
    }
    if (changes.length > 0) {
      changes.slice(0, limit).forEach((c) => parts.push(`  ${c}`));
      if (changes.length > limit) parts.push(`  ... ${changes.length - limit} more changes`);
    }
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.9,
      actionableCount: errors.length + changes.length,
      enrichedItems: enriched,
      bypassEligible,
      summary: parts.join("\n")
    };
  }
}
