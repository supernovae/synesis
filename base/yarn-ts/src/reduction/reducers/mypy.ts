import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class MypyReducer implements Reducer {
  readonly family = "mypy" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const notes: string[] = [];
    let summary = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (/\.py:\d+: error:/.test(trimmed)) {
        errors.push(trimmed);
      } else if (/\.py:\d+: note:/.test(trimmed)) {
        notes.push(trimmed);
      } else if (/^Found \d+ error/.test(trimmed) || /^Success:/.test(trimmed)) {
        summary = trimmed;
      }
    }

    if (errors.length === 0 && !summary) return null;
    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [`<TOOL_REDUCED family="mypy" errors="${errors.length}">`];
    if (summary) parts.push(summary);
    if (errors.length > 0) {
      errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
      if (errors.length > limit) parts.push(`  ... ${errors.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.92, actionableCount: errors.length, summary: parts.join("\n") };
  }
}
