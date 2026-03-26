import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const MODULE_HDR = /^\*{10,}\s*Module\s+/;
const PYLINT_MSG = /^(.+\.py):(\d+):(\d+):\s*([CRWEF])(\d+):\s*(.+)$/;
const RATED_SCORE = /rated at\s+([\d.]+)\s*\/\s*10/i;

export class PylintReducer implements Reducer {
  readonly family = "pylint" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const messages: string[] = [];
    const counts = { C: 0, R: 0, W: 0, E: 0, F: 0 };
    let sawModule = false;
    let score: string | null = null;

    for (const line of lines) {
      const t = line.trim();
      if (MODULE_HDR.test(t)) sawModule = true;
      const m = PYLINT_MSG.exec(t);
      if (m) {
        const kind = m[4] as keyof typeof counts;
        if (counts[kind] !== undefined) counts[kind]++;
        messages.push(t);
        continue;
      }
      const rs = RATED_SCORE.exec(t);
      if (rs) score = rs[1];
    }

    if (!sawModule && messages.length === 0 && !score) return null;

    const errors = counts.E + counts.F;
    const warnings = counts.C + counts.R + counts.W;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const scoreAttr = score ?? "-";
    const parts: string[] = [
      `<TOOL_REDUCED family="pylint" errors="${errors}" warnings="${warnings}" score="${scoreAttr}">`
    ];
    parts.push(
      `by_type: C=${counts.C} R=${counts.R} W=${counts.W} E=${counts.E} F=${counts.F}`
    );
    if (score) parts.push(`rated: ${score}/10`);
    messages.slice(0, limit).forEach((msg, i) => parts.push(`  ${i + 1}. ${msg}`));
    if (messages.length > limit) parts.push(`  ... ${messages.length - limit} more`);
    parts.push("</TOOL_REDUCED>");
    const actionable = messages.length;
    return {
      family: this.family,
      confidence: 0.9,
      actionableCount: actionable,
      summary: parts.join("\n")
    };
  }
}
