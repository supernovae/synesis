import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class OcReducer implements Reducer {
  readonly family = "oc" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const resources: string[] = [];
    const events: string[] = [];
    const conditions: string[] = [];
    let inEvents = false;
    let inConditions = false;
    let nameLine: string | null = null;
    let namespaceLine: string | null = null;
    let statusLine: string | null = null;

    for (const line of lines) {
      const t = line.trim();
      if (/^Name:\s+/.test(line)) nameLine = t;
      else if (/^Namespace:\s+/.test(line)) namespaceLine = t;
      else if (/^Status:\s+/.test(line)) statusLine = t;
      else if (/^Conditions:/.test(t)) {
        inConditions = true;
        inEvents = false;
      } else if (/^Events:/.test(t)) {
        inEvents = true;
        inConditions = false;
      } else if (/^[^\s].+:$/.test(t) && !t.startsWith("  ")) {
        if (inEvents && !/^Events:/.test(t)) inEvents = false;
        if (inConditions && !/^\s+(True|False|Unknown)\s+/.test(line)) inConditions = false;
      }

      if (/^(pod|deployment|deploymentconfig|route|buildconfig|imagestream|svc|daemonset|statefulset)\//i.test(t)) {
        resources.push(t);
      } else if (/^\s+(Normal|Warning)\s+/.test(line)) {
        events.push(t.trim());
        inEvents = true;
      } else if (inConditions && /^\s+(True|False|Unknown)\s+/.test(line)) {
        conditions.push(t);
      }
    }

    const isEventsTable = /^LAST SEEN\s+/i.test(lines[0]?.trim() ?? "") || /^NAMESPACE\s+LAST SEEN\s+/i.test(lines.slice(0, 3).join(" "));
    if (isEventsTable) {
      const types = new Map<string, number>();
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i]!.trim();
        if (!row || /^LAST SEEN/i.test(row)) continue;
        const m = row.match(/\b(Normal|Warning)\b/i);
        if (m) types.set(m[1]!, (types.get(m[1]!) ?? 0) + 1);
      }
      if (types.size === 0 && lines.length < 3) return null;
      const parts: string[] = [`<TOOL_REDUCED family="oc" resources="${lines.length - 1}">`, "events summary:"];
      for (const [k, v] of types) parts.push(`  ${k}: ${v}`);
      parts.push("</TOOL_REDUCED>");
      const warnings = types.get("Warning") ?? 0;
      return { family: this.family, confidence: 0.9, actionableCount: warnings, summary: parts.join("\n") };
    }

    if (/^In project\s+/i.test(input.raw) || /on server\s+https:\/\//i.test(input.raw)) {
      const interesting = lines.filter((l) => /warning|error|deploy|pod|dc\b|routes?/i.test(l) && l.trim().length > 0);
      const limit = input.context.profile === "ultra" ? 12 : 24;
      if (interesting.length === 0) return null;
      const parts = [`<TOOL_REDUCED family="oc" resources="${interesting.length}">`, ...interesting.slice(0, limit).map((l) => `  ${l.trim()}`)];
      if (interesting.length > limit) parts.push(`  ... ${interesting.length - limit} more`);
      parts.push("</TOOL_REDUCED>");
      return { family: this.family, confidence: 0.86, actionableCount: interesting.length, summary: parts.join("\n") };
    }

    const hasDescribe = Boolean(nameLine || statusLine || events.length || conditions.length || /openshift\.io\//i.test(input.raw));
    if (!hasDescribe && resources.length === 0) return null;

    const limit = input.context.profile === "ultra" ? 8 : 16;
    const parts: string[] = [`<TOOL_REDUCED family="oc" resources="${Math.max(resources.length, 1)}">`];
    if (nameLine) parts.push(`  ${nameLine}`);
    if (namespaceLine) parts.push(`  ${namespaceLine}`);
    if (statusLine) parts.push(`  ${statusLine}`);
    if (conditions.length > 0) {
      parts.push("conditions:");
      conditions.slice(0, 6).forEach((c) => parts.push(`  ${c}`));
    }
    resources.slice(0, limit).forEach((r) => parts.push(`  ${r}`));
    if (resources.length > limit) parts.push(`  ... ${resources.length - limit} more`);
    if (events.length > 0) {
      const warnings = events.filter((e) => /Warning/i.test(e));
      parts.push(`events: ${warnings.length} warnings, ${events.length - warnings.length} normal`);
      warnings.slice(0, 6).forEach((w) => parts.push(`  ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.89,
      actionableCount: events.filter((e) => /Warning/i.test(e)).length,
      summary: parts.join("\n")
    };
  }
}
