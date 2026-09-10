import { z } from "zod";

export const TrialSchema = z.object({
  candidate: z.enum(["existing", "knowledge-first", "front-door"]),
  task: z.string().min(1),
  category: z.enum(["public", "private", "coding", "research"]),
  modelFamily: z.string().min(1), model: z.string().min(1), modelRevision: z.string().min(1),
  harness: z.string().min(1), harnessRevision: z.string().min(1),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  suiteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  knowledge: z.enum(["none", "source", "enriched"]),
  suiteRole: z.enum(["screening", "heldout"]),
  repeat: z.number().int().min(0),
  passed: z.boolean(),
  outcomeSource: z.enum(["deterministic", "blinded-review", "unreviewed"]),
  elapsedMs: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  costComplete: z.boolean(),
  tokens: z.number().int().nonnegative().nullable(),
  falseInterventions: z.number().int().nonnegative(),
  protocolPassed: z.boolean(), securityPassed: z.boolean(),
  live: z.boolean(),
}).strict();
export type Trial = z.infer<typeof TrialSchema>;
function pairKey(row: Trial): string {
  return JSON.stringify([row.task, row.modelFamily, row.model, row.modelRevision, row.harness, row.harnessRevision,
    row.corpusSha256, row.suiteSha256, row.knowledge, row.repeat]);
}
function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length; }
function interval(values: number[], seed = 20260909): [number, number] {
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const samples = Array.from({ length: 5000 }, () => mean(values.map(() => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b);
  return [samples[125], samples[4874]];
}
export function compareTrials(input: unknown[], candidate: Trial["candidate"] = "front-door") {
  const rows = input.map(row => TrialSchema.parse(row));
  const baseline = new Map<string, Trial>();
  const proposed = new Map<string, Trial>();
  for (const row of rows) {
    const target = row.candidate === "knowledge-first" ? baseline : row.candidate === candidate ? proposed : null;
    if (!target) continue;
    const key = pairKey(row);
    if (target.has(key)) throw new Error("Duplicate trial: repeats must have distinct repeat IDs");
    target.set(key, row);
  }
  const pairs = [...baseline].flatMap(([key, a]) => proposed.has(key) ? [[a, proposed.get(key)!] as const] : []);
  const reasons: string[] = [];
  const scope = "incremental-complexity-evidence";
  if (!pairs.length) return { scope, decision: "insufficient_evidence", reasons: ["No matched trials"], pairs: 0 };
  if (pairs.length !== baseline.size || pairs.length !== proposed.size) reasons.push("Unmatched trials; configuration drift or incomplete runs");
  const tasks = new Map<string, number[]>();
  const taskModels = new Map<string, Set<string>>();
  const codingCoverage = new Map<string, Set<string>>();
  const categories: Record<Trial["category"], Set<string>> = { public: new Set(), private: new Set(), coding: new Set(), research: new Set() };
  for (const [a, b] of pairs) {
    if (a.category !== b.category) throw new Error("Paired task categories differ");
    categories[a.category].add(a.task);
    taskModels.set(a.task, new Set([...(taskModels.get(a.task) ?? []), a.modelFamily]));
    if (a.category === "coding") {
      const key = JSON.stringify([a.task, a.modelFamily]);
      codingCoverage.set(key, new Set([...(codingCoverage.get(key) ?? []), a.harness]));
    }
    if (a.suiteRole !== "heldout" || b.suiteRole !== "heldout") reasons.push("Screening fixtures cannot establish held-out task quality");
    tasks.set(a.task, [...(tasks.get(a.task) ?? []), Number(b.passed) - Number(a.passed)]);
    if (!a.live || !b.live) reasons.push("Synthetic trials cannot establish model task quality");
    if (a.outcomeSource === "unreviewed" || b.outcomeSource === "unreviewed") reasons.push("Unreviewed outcomes");
  }
  for (const [category, minimum] of Object.entries({ public: 20, private: 20, coding: 10, research: 10 })) {
    if (categories[category as Trial["category"]].size < minimum) reasons.push(`Insufficient ${category} tasks: require ${minimum}`);
  }
  if ([...taskModels.values()].some(models => models.size < 2)) reasons.push("Every task needs both model families");
  if ([...codingCoverage.values()].some(harnesses => harnesses.size < 2)) reasons.push("Every coding task/model pair needs both harnesses");
  const models = new Set(pairs.map(([a]) => a.modelFamily));
  const harnesses = new Set(pairs.filter(([a]) => a.category === "coding").map(([a]) => a.harness));
  if (models.size < 2) reasons.push("Require two model families");
  if (harnesses.size < 2) reasons.push("Require two coding harnesses");
  const deltas = [...tasks.values()].map(mean);
  const successDelta = mean(deltas);
  const successInterval = interval(deltas);
  const sum = (side: 0 | 1, key: "costUsd" | "tokens" | "falseInterventions") => pairs.reduce((n, p) => n + (p[side][key] ?? 0), 0);
  const passed = (side: 0 | 1) => pairs.filter(p => p[side].passed).length;
  const costComplete = pairs.every(p => p.every(r => r.costComplete && r.costUsd !== null));
  const baselineCost = passed(0) ? sum(0, "costUsd") / passed(0) : null;
  const candidateCost = passed(1) ? sum(1, "costUsd") / passed(1) : null;
  const costReduction = costComplete && baselineCost && candidateCost !== null ? 1 - candidateCost / baselineCost : null;
  const baselineConformancePassed = pairs.every(([a]) => a.protocolPassed && a.securityPassed);
  const protocolPassed = pairs.every(p => p.every(r => r.protocolPassed && r.securityPassed));
  if (!baselineConformancePassed) reasons.push("Baseline fails protocol/security checks; neither candidate is endorsed by this comparison");
  const benefit = successDelta >= 0.05 && successInterval[0] > 0;
  const costBenefit = costReduction !== null && costReduction >= 0.2 && successInterval[0] >= 0;
  const falseInterventionsIncreased = sum(1, "falseInterventions") > sum(0, "falseInterventions");
  const decision = reasons.length ? "insufficient_evidence" : !protocolPassed || falseInterventionsIncreased ? "knowledge-first"
    : benefit || costBenefit ? candidate : "knowledge-first";
  return { scope, decision, reasons: [...new Set(reasons)], pairs: pairs.length, tasks: tasks.size, successDelta,
    successInterval, costReduction, costComplete, protocolPassed, falseInterventionsIncreased,
    note: "Task-clustered descriptive bootstrap; missing cost is unknown. This comparison does not gate cost/maintenance architecture decisions or prove future non-regression. Capability exceptions require a separate reviewed record." };
}
