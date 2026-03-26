import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class KubectlReducer implements Reducer {
  readonly family = "kubectl" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const resources: string[] = [];
    const events: string[] = [];
    const conditions: string[] = [];
    let isDescribe = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(NAME|NAMESPACE)\s+/.test(trimmed)) {
        continue; // header row
      } else if (/^(pod|svc|deploy|sts|ds|job|cronjob|ingress|node|pvc|cm|secret)\//.test(trimmed) || /^\w[\w-]+\s+(Running|Pending|Succeeded|Failed|CrashLoopBackOff|Error|Completed|Terminating)\s/.test(trimmed)) {
        resources.push(trimmed);
      } else if (/^\s+(Normal|Warning)\s+/.test(line)) {
        events.push(trimmed);
        isDescribe = true;
      } else if (/^Conditions:/.test(trimmed)) {
        isDescribe = true;
      } else if (isDescribe && /^\s+(True|False|Unknown)\s+/.test(line)) {
        conditions.push(trimmed);
      }
    }

    if (resources.length === 0 && events.length === 0 && conditions.length === 0) return null;
    const limit = input.context.profile === "ultra" ? 10 : 20;
    const parts: string[] = [`<TOOL_REDUCED family="kubectl" resources="${resources.length}" events="${events.length}">`];
    if (resources.length > 0) {
      resources.slice(0, limit).forEach((r) => parts.push(`  ${r}`));
      if (resources.length > limit) parts.push(`  ... ${resources.length - limit} more`);
    }
    if (events.length > 0) {
      const warnings = events.filter((e) => e.includes("Warning"));
      const normal = events.filter((e) => e.includes("Normal"));
      parts.push(`events: ${warnings.length} warnings, ${normal.length} normal`);
      warnings.slice(0, 5).forEach((w) => parts.push(`  ${w}`));
    }
    if (conditions.length > 0) {
      parts.push("conditions:");
      conditions.slice(0, 5).forEach((c) => parts.push(`  ${c}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.88, actionableCount: events.filter((e) => e.includes("Warning")).length, summary: parts.join("\n") };
  }
}
