import type { PromptSnapshot } from "./prompt-registry.js";

let activeSnapshot: PromptSnapshot | null = null;

export function setPlannerPromptSnapshot(snapshot: PromptSnapshot): void {
  activeSnapshot = snapshot;
}

function inferModelFamily(model: string): string {
  const m = (model || "").toLowerCase();
  if (/qwen3.*coder/.test(m)) return "qwen3-coder";
  if (/deepseek/.test(m)) return "deepseek";
  if (/kimi|moonshot/.test(m)) return "kimi";
  if (/minimax|abab/.test(m)) return "minimax";
  return "generic";
}

export function composePlannerPrompt(
  basePrompt: string,
  ctx: { tier?: string; role?: string; node?: string; model?: string },
): { content: string; profileIds: number[]; profileHashes: string[] } {
  if (!activeSnapshot || !Array.isArray(activeSnapshot.profiles) || !Array.isArray(activeSnapshot.assignments)) {
    return { content: basePrompt, profileIds: [], profileHashes: [] };
  }
  const byId = new Map(activeSnapshot.profiles.map((p) => [p.id, p] as const));
  const modelFamily = inferModelFamily(ctx.model ?? "");
  const targets: Array<[string, string | undefined]> = [
    ["default", "*"],
    ["tier", ctx.tier],
    ["model_family", modelFamily],
    ["role", ctx.role],
    ["node", ctx.node],
  ];
  const seen = new Set<number>();
  const blocks: string[] = [];
  const ids: number[] = [];
  const hashes: string[] = [];
  for (const [targetType, targetValue] of targets) {
    if (!targetValue) continue;
    const assignment = activeSnapshot.assignments.find(
      (a) => a.target_type === targetType && a.target_value === targetValue,
    );
    if (!assignment || seen.has(assignment.profile_id)) continue;
    const profile = byId.get(assignment.profile_id);
    if (!profile?.content?.trim()) continue;
    seen.add(profile.id);
    ids.push(profile.id);
    hashes.push(profile.content_hash);
    blocks.push(profile.content);
  }
  if (blocks.length === 0) {
    return { content: basePrompt, profileIds: ids, profileHashes: hashes };
  }
  return { content: [basePrompt, ...blocks].join("\n\n"), profileIds: ids, profileHashes: hashes };
}
