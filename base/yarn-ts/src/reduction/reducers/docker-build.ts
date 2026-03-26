import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class DockerBuildReducer implements Reducer {
  readonly family = "docker-build" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    let finalImage = "";
    let stepCount = 0;
    let cachedCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(\[\d+\/\d+\]\s+)?(STEP|Step)\s+\d+/i.test(trimmed) || /^#\d+\s/.test(trimmed)) {
        stepCount++;
        if (/cached/i.test(trimmed)) cachedCount++;
      } else if (/^(ERROR|error)\b/i.test(trimmed) || trimmed.includes("returned a non-zero code")) {
        errors.push(trimmed);
      } else if (trimmed.startsWith("WARNING") || trimmed.startsWith("[WARNING]")) {
        warnings.push(trimmed);
      } else if (/^(\[\d+\/\d+\]\s+)?(Successfully (built|tagged)|naming to)/i.test(trimmed) || /^(exporting to image)/i.test(trimmed)) {
        finalImage = trimmed;
      }
    }

    if (stepCount === 0 && errors.length === 0 && !finalImage) return null;
    const parts: string[] = [`<TOOL_REDUCED family="docker-build" steps="${stepCount}" cached="${cachedCount}">`];
    if (finalImage) parts.push(`result: ${finalImage}`);
    if (errors.length > 0) {
      parts.push(`errors (${errors.length}):`);
      errors.slice(0, 5).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    if (warnings.length > 0) {
      warnings.slice(0, 3).forEach((w, i) => parts.push(`  warn ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.9, actionableCount: errors.length, summary: parts.join("\n") };
  }
}
