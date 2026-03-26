import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class AnsibleReducer implements Reducer {
  readonly family = "ansible" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const fails: string[] = [];
    const changed: string[] = [];
    let recapLine = "";
    let playName = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^PLAY \[/.test(trimmed)) {
        playName = trimmed;
      } else if (/^fatal:/.test(trimmed) || /^failed:/.test(trimmed)) {
        fails.push(trimmed.slice(0, 200));
      } else if (/^changed:/.test(trimmed)) {
        changed.push(trimmed.slice(0, 150));
      } else if (/^PLAY RECAP/.test(trimmed)) {
        recapLine = "PLAY RECAP";
      } else if (recapLine && /\s+(ok|changed|unreachable|failed|skipped|rescued|ignored)=/.test(trimmed)) {
        recapLine = trimmed;
      }
    }

    if (fails.length === 0 && changed.length === 0 && !recapLine) return null;
    const parts: string[] = [`<TOOL_REDUCED family="ansible">`];
    if (playName) parts.push(playName);
    if (recapLine && recapLine !== "PLAY RECAP") parts.push(recapLine);
    if (fails.length > 0) {
      parts.push(`failures (${fails.length}):`);
      fails.slice(0, 5).forEach((f, i) => parts.push(`  ${i + 1}. ${f}`));
    }
    if (changed.length > 0) parts.push(`changed: ${changed.length} tasks`);
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.88, actionableCount: fails.length, summary: parts.join("\n") };
  }
}
