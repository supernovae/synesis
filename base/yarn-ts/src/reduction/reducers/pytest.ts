import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const FAIL_HEADER = /^_{3,}\s+(.+?)\s+_{3,}$/;

export class PytestReducer implements Reducer {
  readonly family = "pytest" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const findings: string[] = [];
    let currentTest = "";
    for (const line of lines) {
      const h = FAIL_HEADER.exec(line);
      if (h) {
        currentTest = h[1];
        continue;
      }
      if (line.trim().startsWith("E       ")) {
        const msg = line.trim().slice(8);
        findings.push(`${currentTest || "test"}: ${msg}`);
      }
    }
    if (findings.length === 0) return null;
    const top = findings.slice(0, input.context.profile === "ultra" ? 6 : 12);
    return {
      family: this.family,
      confidence: 0.95,
      actionableCount: findings.length,
      summary: [
        `<TOOL_REDUCED family="pytest" findings="${findings.length}">`,
        ...top.map((f, i) => `${i + 1}. ${f}`),
        "</TOOL_REDUCED>"
      ].join("\n")
    };
  }
}
