import { enrichItems, type ParsedItem } from "../enrich-bridge.js";
import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class JestReducer implements Reducer {
  readonly family = "jest" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const items: ParsedItem[] = [];
    let testSuites = "";
    let currentSuite = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^FAIL\s+/.test(trimmed)) {
        currentSuite = trimmed.replace(/^FAIL\s+/, "");
      } else if (/^✕|^×|^✗/.test(trimmed) || /^\s+● /.test(line)) {
        const msg = trimmed.replace(/^[✕×✗●]\s*/, "");
        items.push({ message: `${currentSuite}: ${msg}`, file: currentSuite || undefined });
      } else if (/^(Tests|Test Suites):/.test(trimmed)) {
        testSuites += trimmed + "\n";
      } else if (/expect\(.+\)\.(toBe|toEqual|toMatch|toThrow|toHaveBeenCalled)/.test(trimmed)) {
        items.push({ message: `${currentSuite}: ${trimmed}`, file: currentSuite || undefined });
      }
    }

    if (items.length === 0 && !testSuites) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const top = items.slice(0, limit);
    const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);

    const parts: string[] = [`<TOOL_REDUCED family="jest" failures="${items.length}">`];
    if (testSuites.trim()) parts.push(testSuites.trim());
    if (enrichedLines.length > 0) {
      parts.push(...enrichedLines);
      if (items.length > limit) parts.push(`  ... ${items.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.92,
      actionableCount: items.length,
      enrichedItems: enriched,
      bypassEligible,
      summary: parts.join("\n")
    };
  }
}
