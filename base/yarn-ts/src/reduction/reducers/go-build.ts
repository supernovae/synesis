import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class GoBuildReducer implements Reducer {
  readonly family = "go-build" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const testFails: string[] = [];
    let testSummary = "";
    let vetWarnings: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\.\/[\w/]+\.go:\d+:\d+:/.test(trimmed)) {
        errors.push(trimmed);
      } else if (/^--- FAIL:/.test(trimmed)) {
        testFails.push(trimmed);
      } else if (/^(FAIL|ok)\s+[\w./]+/.test(trimmed)) {
        testSummary += trimmed + "\n";
      } else if (/^vet:/.test(trimmed) || /^#.*vet/.test(trimmed)) {
        vetWarnings.push(trimmed);
      } else if (/^\s+Error Trace:/.test(line) || /^\s+Error:/.test(line)) {
        testFails.push(trimmed);
      }
    }

    if (errors.length === 0 && testFails.length === 0 && !testSummary && vetWarnings.length === 0) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [`<TOOL_REDUCED family="go-build">`];
    if (testSummary.trim()) parts.push(testSummary.trim());
    if (errors.length > 0) {
      parts.push(`compile errors (${errors.length}):`);
      errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    if (testFails.length > 0) {
      parts.push(`test failures (${testFails.length}):`);
      testFails.slice(0, limit).forEach((f, i) => parts.push(`  ${i + 1}. ${f}`));
    }
    if (vetWarnings.length > 0) {
      parts.push(`vet (${vetWarnings.length}):`);
      vetWarnings.slice(0, 4).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.9, actionableCount: errors.length + testFails.length, summary: parts.join("\n") };
  }
}
