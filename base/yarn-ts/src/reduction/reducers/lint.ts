import { enrichItems, type ParsedItem } from "../enrich-bridge.js";
import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const RUFF = /^(.+?):(\d+):(\d+):\s*([A-Z]\d+)\s+(.+)$/;
const ESLINT = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s{2,}([@\w/-]+)$/;

export class LintReducer implements Reducer {
  readonly family = "lint" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const byRule = new Map<string, number>();
    const byFile = new Map<string, number>();
    const items: ParsedItem[] = [];
    let subFamily: "eslint" | "ruff" | undefined;

    for (const line of input.raw.split("\n")) {
      const r = RUFF.exec(line);
      if (r) {
        subFamily = subFamily ?? "ruff";
        byRule.set(r[4], (byRule.get(r[4]) ?? 0) + 1);
        byFile.set(r[1], (byFile.get(r[1]) ?? 0) + 1);
        items.push({ message: r[5], file: r[1], ruleId: r[4] });
        continue;
      }
      const e = ESLINT.exec(line);
      if (e) {
        subFamily = subFamily ?? "eslint";
        byRule.set(e[6], (byRule.get(e[6]) ?? 0) + 1);
        byFile.set(e[1], (byFile.get(e[1]) ?? 0) + 1);
        items.push({ message: e[5], file: e[1], ruleId: e[6] });
      }
    }
    if (byRule.size === 0 && byFile.size === 0) {
      const nonEmpty = input.raw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (nonEmpty.length === 0) return null;
      return {
        family: this.family,
        confidence: 0.62,
        actionableCount: nonEmpty.length,
        summary: [
          `<TOOL_REDUCED family="lint" rules="0" files="0">`,
          ...nonEmpty.slice(0, 8).map((l, i) => `${i + 1}. ${l}`),
          "</TOOL_REDUCED>"
        ].join("\n")
      };
    }

    const topRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const top = items.slice(0, limit);
    const { items: enriched, enrichedLines, bypassEligible } = enrichItems(
      this.family,
      top,
      subFamily
    );

    return {
      family: this.family,
      confidence: 0.9,
      actionableCount: [...byRule.values()].reduce((a, b) => a + b, 0),
      enrichedItems: enriched,
      bypassEligible,
      summary: [
        `<TOOL_REDUCED family="lint" rules="${byRule.size}" files="${byFile.size}">`,
        "top_rules:",
        ...topRules.map(([r, c]) => `- ${r}: ${c}`),
        "top_files:",
        ...topFiles.map(([f, c]) => `- ${f}: ${c}`),
        "findings:",
        ...enrichedLines,
        "</TOOL_REDUCED>"
      ].join("\n")
    };
  }
}
