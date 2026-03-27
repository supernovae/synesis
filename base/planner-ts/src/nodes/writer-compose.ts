import type { GraphState } from "../state/types.js";
import { chatCompletion, isLlmAvailable } from "../llm/client.js";

function renderEvidenceSection(state: GraphState): string {
  const packets = state.evidence_packets ?? [];
  if (packets.length === 0) {
    return "## Evidence\n\nNo external evidence packets were available for this iteration.";
  }

  const lines: string[] = ["## Evidence"];
  for (const packet of packets.slice(0, 3)) {
    lines.push(`\n### Query: ${packet.query}`);
    lines.push(packet.summary || "No summary available.");
    for (const source of packet.sources.slice(0, 3)) {
      const docName = String(source.metadata.document_name ?? source.uri);
      lines.push(`- [Source: ${docName} - ${source.uri}]`);
    }
  }
  return lines.join("\n");
}

function renderPlanSection(state: GraphState): string {
  const plan = state.execution_plan ?? {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) {
    return "## Plan\n\nNo explicit plan steps were available.";
  }
  const lines = ["## Plan"];
  for (const step of steps) {
    lines.push(`- ${String(step.action ?? "Unnamed step")}`);
  }
  return lines.join("\n");
}

function deterministicDraft(state: GraphState): string {
  const prompt = state.task_description ?? "No user prompt supplied.";
  const style = state.style_contract_locked ?? {};
  const concise = style.precise === true;
  const title = concise ? "# Response" : "# Draft Response";

  const intro = concise
    ? `Direct answer: ${prompt}`
    : `This response addresses: ${prompt}`;

  return [title, "", intro, "", renderPlanSection(state), "", renderEvidenceSection(state)].join("\n");
}

export async function composeWriterDraft(state: GraphState): Promise<string> {
  const fallback = deterministicDraft(state);
  if (!isLlmAvailable()) return fallback;

  try {
    const task = state.task_description ?? "No task provided";
    const planBlock = renderPlanSection(state);
    const evidenceBlock = renderEvidenceSection(state);
    const output = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "Synesis",
      temperature: 0.2,
      max_tokens: state.writer_max_tokens ?? 1800,
      messages: [
        {
          role: "system",
          content:
            "You are Synesis Writer. Produce a grounded markdown response using plan and evidence. Include source tags as [Source: name - url] where claims rely on evidence."
        },
        {
          role: "user",
          content: `Task:\n${task}\n\n${planBlock}\n\n${evidenceBlock}`
        }
      ]
    });
    return output.trim() || fallback;
  } catch {
    return fallback;
  }
}
