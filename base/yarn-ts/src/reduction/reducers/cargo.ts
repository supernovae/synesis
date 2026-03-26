import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class CargoReducer implements Reducer {
  readonly family = "cargo" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    let testSummary = "";
    let compileCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^error\[E\d+\]/.test(trimmed) || /^error:/.test(trimmed)) {
        errors.push(trimmed);
      } else if (/^warning\[/.test(trimmed) || /^warning:/.test(trimmed)) {
        if (!trimmed.includes("generated ") && !trimmed.includes(" warning generated")) {
          warnings.push(trimmed);
        }
      } else if (/^\s*Compiling /.test(trimmed) || /^\s*Downloading /.test(trimmed)) {
        compileCount++;
      } else if (/^test result:/.test(trimmed)) {
        testSummary = trimmed;
      } else if (trimmed.startsWith("--> ")) {
        const lastErr = errors[errors.length - 1];
        if (lastErr) errors[errors.length - 1] = `${lastErr} ${trimmed}`;
      }
    }

    if (errors.length === 0 && warnings.length === 0 && !testSummary) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [`<TOOL_REDUCED family="cargo" compiled="${compileCount}">`];
    if (testSummary) parts.push(testSummary);
    if (errors.length > 0) {
      parts.push(`errors (${errors.length}):`);
      errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    if (warnings.length > 0) {
      parts.push(`warnings (${warnings.length}):`);
      warnings.slice(0, Math.ceil(limit / 2)).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.92, actionableCount: errors.length + warnings.length, summary: parts.join("\n") };
  }
}
