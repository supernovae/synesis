export type PlannerNodeName =
  | "entry_pipeline"
  | "planner"
  | "plan_gate"
  | "router"
  | "writer"
  | "critic"
  | "final_scrubber"
  | "respond";

const PHASE_DESCRIPTION: Record<PlannerNodeName, string> = {
  entry_pipeline: "Classifying and framing request",
  planner: "Building execution plan",
  plan_gate: "Validating plan deterministically",
  router: "Gathering and structuring evidence",
  writer: "Composing grounded response",
  critic: "Evaluating quality and grounding",
  final_scrubber: "Applying final response cleanup",
  respond: "Preparing final response"
};

export function describePhase(node: string): string {
  return PHASE_DESCRIPTION[node as PlannerNodeName] ?? "Processing request";
}

export function chunkContent(content: string, maxChars = 900): string[] {
  if (content.length <= maxChars) return [content];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const next = Math.min(content.length, cursor + maxChars);
    chunks.push(content.slice(cursor, next));
    cursor = next;
  }
  return chunks;
}
