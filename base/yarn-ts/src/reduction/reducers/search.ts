import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const RG_LINE = /^(.+?):(\d+):(.+)$/;

export class SearchReducer implements Reducer {
  readonly family = "search" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const byFile = new Map<string, number>();
    for (const line of input.raw.split("\n")) {
      const m = RG_LINE.exec(line);
      if (!m) continue;
      byFile.set(m[1], (byFile.get(m[1]) ?? 0) + 1);
    }
    if (byFile.size === 0) return null;
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.context.profile === "ultra" ? 8 : 14);
    return {
      family: this.family,
      confidence: 0.9,
      actionableCount: [...byFile.values()].reduce((a, b) => a + b, 0),
      summary: [
        `<TOOL_REDUCED family="search" files="${byFile.size}">`,
        ...top.map(([file, count]) => `- ${file}: ${count} matches`),
        "</TOOL_REDUCED>"
      ].join("\n")
    };
  }
}
