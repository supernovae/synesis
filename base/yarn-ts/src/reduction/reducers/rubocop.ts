import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const OFFENSE = /^(.+\.rb):(\d+):(\d+):\s*([CWEF]):\s*([\w/]+):\s*(.+)$/;
const INSPECTED = /(\d+)\s+files?\s+inspected,\s*(\d+)\s+offenses?\s+detected/i;

export class RubocopReducer implements Reducer {
  readonly family = "rubocop" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const offenses: string[] = [];
    let filesInspected: number | null = null;
    let offensesDetected: number | null = null;

    for (const line of lines) {
      const t = line.trim();
      const ins = INSPECTED.exec(t);
      if (ins) {
        filesInspected = parseInt(ins[1], 10);
        offensesDetected = parseInt(ins[2], 10);
        continue;
      }
      const o = OFFENSE.exec(t);
      if (o) {
        offenses.push(`${o[1]}:${o[2]}:${o[3]} [${o[4]}] ${o[5]}: ${o[6]}`);
      }
    }

    const looksRubocop =
      input.raw.includes("Offenses:") ||
      input.raw.includes("files inspected") ||
      /\.rb:\d+:\d+:\s*[CWEF]:\s*[\w/]+:/m.test(input.raw);

    if (!looksRubocop && offenses.length === 0) return null;
    if (offenses.length === 0 && filesInspected === null && offensesDetected === null) return null;

    const files = filesInspected ?? new Set(offenses.map((o) => o.split(":")[0])).size;
    const offCount = offensesDetected ?? offenses.length;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [
      `<TOOL_REDUCED family="rubocop" offenses="${offCount}" files="${files}">`
    ];
    if (filesInspected !== null && offensesDetected !== null) {
      parts.push(`totals: ${filesInspected} files inspected, ${offensesDetected} offenses detected`);
    }
    offenses.slice(0, limit).forEach((o, i) => parts.push(`  ${i + 1}. ${o}`));
    if (offenses.length > limit) parts.push(`  ... ${offenses.length - limit} more`);
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.91,
      actionableCount: Math.max(offenses.length, offCount),
      summary: parts.join("\n")
    };
  }
}
