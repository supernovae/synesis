import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class JestReducer implements Reducer {
  readonly family = "jest" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const failures: string[] = [];
    let testSuites = "";
    let currentSuite = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^FAIL\s+/.test(trimmed)) {
        currentSuite = trimmed.replace(/^FAIL\s+/, "");
      } else if (/^✕|^×|^✗/.test(trimmed) || /^\s+● /.test(line)) {
        failures.push(`${currentSuite}: ${trimmed.replace(/^[✕×✗●]\s*/, "")}`);
      } else if (/^(Tests|Test Suites):/.test(trimmed)) {
        testSuites += trimmed + "\n";
      } else if (/expect\(.+\)\.(toBe|toEqual|toMatch|toThrow|toHaveBeenCalled)/.test(trimmed)) {
        failures.push(`${currentSuite}: ${trimmed}`);
      }
    }

    if (failures.length === 0 && !testSuites) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [`<TOOL_REDUCED family="jest" failures="${failures.length}">`];
    if (testSuites.trim()) parts.push(testSuites.trim());
    if (failures.length > 0) {
      failures.slice(0, limit).forEach((f, i) => parts.push(`  ${i + 1}. ${f}`));
      if (failures.length > limit) parts.push(`  ... ${failures.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.92, actionableCount: failures.length, summary: parts.join("\n") };
  }
}
