import type { GraphState } from "../state/types.js";
import { chatCompletion, isLlmAvailable, ZERO_USAGE, type LlmUsage } from "../llm/client.js";

export interface WriterResult {
  content: string;
  usage: LlmUsage;
}

function renderEvidenceContext(state: GraphState): string {
  const packets = state.evidence_packets ?? [];
  if (packets.length === 0) return "";

  const lines: string[] = [];
  for (const packet of packets.slice(0, 3)) {
    lines.push(`Query: ${packet.query}`);
    lines.push(packet.summary || "No summary available.");
    for (const source of packet.sources.slice(0, 3)) {
      const docName = String(source.metadata.document_name ?? source.uri);
      lines.push(`- [Source: ${docName} - ${source.uri}]`);
    }
  }
  return lines.join("\n");
}

function renderPlanContext(state: GraphState): string {
  const plan = state.execution_plan ?? {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) return "";
  return steps.map((step) => `- ${String(step.action ?? "Unnamed step")}`).join("\n");
}

function deterministicDraft(state: GraphState): string {
  const prompt = state.task_description ?? "No user prompt supplied.";
  return [
    `I understand your request: ${prompt}`,
    "",
    "I was unable to generate a fully grounded response at this time.",
    "Please try again shortly, or rephrase your question for a more targeted answer."
  ].join("\n");
}

export async function composeWriterDraft(state: GraphState): Promise<WriterResult> {
  const fallback = deterministicDraft(state);
  if (!isLlmAvailable()) return { content: fallback, usage: ZERO_USAGE };

  try {
    const task = state.task_description ?? "No task provided";
    const planBlock = renderPlanContext(state);
    const evidenceBlock = renderEvidenceContext(state);
    const result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "Synesis",
      temperature: 0.2,
      max_tokens: state.writer_max_tokens ?? 1800,
      messages: [
        {
          role: "system",
          content:
            [
              "You are Synesis Writer.",
              "Return only the final user-facing answer; do not expose internal planning scaffolds.",
              "Never emit headings like 'Plan:', 'Evidence:', 'Answer:', 'Draft Response', or similar meta-sections unless the user explicitly asks for that format.",
              "If the prompt is a follow-up request (e.g., 'more detail', 'expand', 'clarify'), extend the answer with new detail instead of repeating prior wording verbatim.",
              "Use citations only when evidence exists and a factual claim depends on it, formatted as [Source: name - url]."
            ].join(" ")
        },
        {
          role: "user",
          content: `Task:\n${task}\n\n${planBlock}\n\n${evidenceBlock}`
        }
      ]
    });
    return {
      content: result.content.trim() || fallback,
      usage: result.usage
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[writer-compose] LLM writer failed, using deterministic fallback: ${detail}`);
    return { content: fallback, usage: ZERO_USAGE };
  }
}
