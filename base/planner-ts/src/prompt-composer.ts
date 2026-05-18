import type { PromptSnapshot } from "./prompt-registry.js";

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
  snapshot?: PromptSnapshot | null,
): { content: string; profileIds: number[]; profileHashes: string[] } {
  if (!snapshot || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.assignments)) {
    return { content: basePrompt, profileIds: [], profileHashes: [] };
  }
  const byId = new Map(snapshot.profiles.map((p) => [p.id, p] as const));
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
    const assignment = snapshot.assignments.find(
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
