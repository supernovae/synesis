import { enrichItems, type ParsedItem } from "../enrich-bridge.js";
import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";
import { cargoSuggestedFixCommands } from "../../verification/command-taxonomy.js";

const ERROR_CODE = /^error\[([^\]]+)\]:\s*(.+)$/;

export class CargoReducer implements Reducer {
  readonly family = "cargo" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    const items: ParsedItem[] = [];
    let testSummary = "";
    let compileCount = 0;
    const fixCommands = cargoSuggestedFixCommands(input.raw);

    for (const line of lines) {
      const trimmed = line.trim();
      const ec = ERROR_CODE.exec(trimmed);
      if (ec) {
        errors.push(trimmed);
        items.push({ message: ec[2], ruleId: ec[1] });
      } else if (/^error:/.test(trimmed)) {
        errors.push(trimmed);
        items.push({ message: trimmed.replace(/^error:\s*/, "") });
      } else if (/^warning\[/.test(trimmed) || /^warning:/.test(trimmed)) {
        if (!trimmed.includes("generated ") && !trimmed.includes(" warning generated")) {
          warnings.push(trimmed);
          const wm = /^warning(?:\[([^\]]+)\])?:\s*(.+)$/.exec(trimmed);
          if (wm) items.push({ message: wm[2], ruleId: wm[1] ?? undefined });
        }
      } else if (/^\s*Compiling /.test(trimmed) || /^\s*Downloading /.test(trimmed)) {
        compileCount++;
      } else if (/^test result:/.test(trimmed)) {
        testSummary = trimmed;
      } else if (trimmed.startsWith("--> ")) {
        const lastErr = errors[errors.length - 1];
        if (lastErr) errors[errors.length - 1] = `${lastErr} ${trimmed}`;
        const lastItem = items[items.length - 1];
        if (lastItem) {
          const fileParts = /^-->\s+(.+?):(\d+):(\d+)/.exec(trimmed);
          if (fileParts) lastItem.file = fileParts[1];
        }
      }
    }

    if (errors.length === 0 && warnings.length === 0 && !testSummary) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const top = items.slice(0, limit);
    const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);

    const parts: string[] = [`<TOOL_REDUCED family="cargo" compiled="${compileCount}">`];
    if (testSummary) parts.push(testSummary);
    for (const command of fixCommands.slice(0, 3)) {
      parts.push(`suggested fix command: ${command}`);
    }
    if (enrichedLines.length > 0) {
      parts.push(...enrichedLines);
      if (items.length > limit) parts.push(`  ... ${items.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.92,
      actionableCount: errors.length + warnings.length,
      enrichedItems: enriched,
      bypassEligible,
      summary: parts.join("\n")
    };
  }
}
