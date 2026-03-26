import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class StracePerfReducer implements Reducer {
  readonly family = "strace-perf" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const syscalls = new Map<string, number>();
    const errors: string[] = [];
    let topSummarySection = false;
    const summaryLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^% time\s+seconds/.test(trimmed) || /^------ ----------/.test(trimmed)) {
        topSummarySection = true;
        continue;
      }
      if (topSummarySection && /^\s*[\d.]+\s+[\d.]+\s+\d+\s+\d+\s+\w+/.test(trimmed)) {
        summaryLines.push(trimmed);
        continue;
      }
      if (topSummarySection && /^total/.test(trimmed)) {
        summaryLines.push(trimmed);
        topSummarySection = false;
        continue;
      }

      const sysMatch = trimmed.match(/^(\w+)\(/);
      if (sysMatch) {
        const name = sysMatch[1];
        syscalls.set(name, (syscalls.get(name) ?? 0) + 1);
      }
      if (/= -1 E/.test(trimmed)) {
        errors.push(trimmed.slice(0, 150));
      }

      if (/^\s*[\d.]+%/.test(trimmed) && /\s+\w+$/.test(trimmed)) {
        summaryLines.push(trimmed);
      }
    }

    if (syscalls.size === 0 && summaryLines.length === 0) return null;
    const topSyscalls = [...syscalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const parts: string[] = [`<TOOL_REDUCED family="strace-perf" unique_syscalls="${syscalls.size}" errors="${errors.length}">`];
    if (summaryLines.length > 0) {
      parts.push("profile summary:");
      summaryLines.slice(0, 10).forEach((l) => parts.push(`  ${l}`));
    } else if (topSyscalls.length > 0) {
      parts.push("top syscalls:");
      topSyscalls.forEach(([name, count]) => parts.push(`  ${name}: ${count}`));
    }
    if (errors.length > 0) {
      parts.push(`errors (${errors.length}):`);
      errors.slice(0, 5).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.85, actionableCount: errors.length, summary: parts.join("\n") };
  }
}
