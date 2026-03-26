import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const TS = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

export class TscReducer implements Reducer {
  readonly family = "tsc" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const byFile = new Map<string, string[]>();
    for (const line of input.raw.split("\n")) {
      const m = TS.exec(line);
      if (!m) continue;
      const file = m[1];
      const msg = `${m[4]} ${m[5]}`.trim();
      byFile.set(file, [...(byFile.get(file) ?? []), msg]);
    }
    if (byFile.size === 0) return null;
    const rows: string[] = [];
    for (const [file, msgs] of byFile) {
      const unique = [...new Set(msgs)];
      rows.push(`${file}: ${msgs.length} errors (${unique.slice(0, 2).join(" | ")})`);
    }
    const top = rows.slice(0, input.context.profile === "ultra" ? 6 : 12);
    return {
      family: this.family,
      confidence: 0.95,
      actionableCount: rows.length,
      summary: [
        `<TOOL_REDUCED family="tsc" files="${rows.length}">`,
        ...top.map((r, i) => `${i + 1}. ${r}`),
        "</TOOL_REDUCED>"
      ].join("\n")
    };
  }
}
