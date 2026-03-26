import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class LogStreamReducer implements Reducer {
  readonly family = "log-stream" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    if (lines.length < 20) return null;

    const byLevel: Record<string, number> = {};
    const errorLines: string[] = [];
    const warnLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let level = "info";
      if (/\b(ERROR|FATAL|CRITICAL|SEVERE)\b/i.test(trimmed)) level = "error";
      else if (/\b(WARN|WARNING)\b/i.test(trimmed)) level = "warn";
      else if (/\b(DEBUG|TRACE)\b/i.test(trimmed)) level = "debug";

      byLevel[level] = (byLevel[level] ?? 0) + 1;

      if (level === "error" && errorLines.length < 8) errorLines.push(trimmed.slice(0, 200));
      if (level === "warn" && warnLines.length < 5) warnLines.push(trimmed.slice(0, 200));
    }

    const parts: string[] = [`<TOOL_REDUCED family="log-stream" lines="${lines.length}">`];
    parts.push(`levels: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    if (errorLines.length > 0) {
      parts.push(`errors:`);
      errorLines.forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    if (warnLines.length > 0) {
      parts.push(`warnings:`);
      warnLines.forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.8, actionableCount: errorLines.length, summary: parts.join("\n") };
  }
}
