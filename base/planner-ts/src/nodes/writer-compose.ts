import type { GraphState } from "../state/types.js";
import {
  chatCompletion,
  chatCompletionStream,
  isLlmAvailable,
  ZERO_USAGE,
  type LlmUsage,
  type StreamDelta,
  type ChatMessage,
} from "../llm/client.js";
import {
  TRUST_POLICY,
  SANDWICH_REMINDER,
  authorityDatamark,
  wrapUntrusted,
} from "../security/trust-prompts.js";
import { sanitizeStepAction } from "../security/step-sanitizer.js";
import { loadConfig } from "../config.js";
import {
  getOutputStyleGuidance,
  getEpistemicGuidanceBlock,
  getWriterRegulatedBlock,
  getDiscoveryPrompt,
} from "../taxonomy/taxonomy-prompt-factory.js";
import { getWorkerPersonaBlock } from "../taxonomy/vertical-prompts.js";
import { getOntologySnapshot } from "../ontology/merge-plugins.js";

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
      const authority = String(source.metadata.authority ?? "external");
      const sourceType = source.type === "web" ? "web" : "rag";
      const mark = authorityDatamark(authority, sourceType);
      const docName = String(source.metadata.document_name ?? source.uri);
      lines.push(`${mark} [Source: ${docName} - ${source.uri}]`);
    }
  }
  return lines.join("\n");
}

function renderPlanContext(state: GraphState): string {
  const plan = state.execution_plan ?? {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) return "";
  return steps.map((step) => `- ${sanitizeStepAction(String(step.action ?? "Unnamed step"))}`).join("\n");
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

function buildAssumptionInstructions(state: GraphState): string {
  if (!state.show_assumptions) return "";

  const assumptions = state.assumptions ?? [];
  const answeredClarification = Boolean(state.user_answer_to_clarification);
  const difficulty = state.difficulty ?? 0.3;

  const rules: string[] = [
    "EPISTEMIC LABELING RULES:",
    "- When you make a material assumption that affects the answer, tag it inline with [Assumption: brief description].",
    "- When you give a numerical approximation or estimate, tag it with [Estimate: brief basis].",
    "- When citing a specific goal, SLA, or requirement, tag it with [Target: source or context].",
    "- When citing a directly measured or observed value, tag it with [Measured: source or method].",
  ];

  if (answeredClarification) {
    rules.push("- Items the user clarified should be tagged with [Clarified] to show they were confirmed.");
  }

  if (assumptions.length > 0) {
    rules.push(`\nThe planner identified these assumptions: ${assumptions.map((a) => `"${a}"`).join(", ")}. Tag them in your response where relevant.`);
  }

  if (difficulty >= 0.6) {
    rules.push("\nFor this complex topic, include a brief 'Assumptions & Caveats' section at the end summarizing key assumptions and their impact.");
  }

  return rules.join("\n");
}

function buildWriterMessages(state: GraphState): ChatMessage[] {
  const task = state.task_description ?? "No task provided";
  const planBlock = renderPlanContext(state);
  const evidenceBlock = renderEvidenceContext(state);
  const assumptionBlock = buildAssumptionInstructions(state);

  const systemParts = [
    "You are Synesis Writer.",
    "Return only the final user-facing answer; do not expose internal planning scaffolds.",
    "Never emit headings like 'Plan:', 'Evidence:', 'Answer:', 'Draft Response', or similar meta-sections unless the user explicitly asks for that format.",
    "If the prompt is a follow-up request (e.g., 'more detail', 'expand', 'clarify'), extend the answer with new detail instead of repeating prior wording verbatim.",
    "Use citations only when evidence exists and a factual claim depends on it, formatted as [Source: name - url].",
    "",
    TRUST_POLICY,
  ];
  if (assumptionBlock) systemParts.push(assumptionBlock);

  // --- Dynamic taxonomy suffix (prefix-cache: static above, dynamic below) ---
  const taxonomyMeta = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const difficulty = state.difficulty ?? 0;
  const complexity = Number(taxonomyMeta.complexity_score ?? 0);
  const depthInstr = String(taxonomyMeta.depth_instructions ?? "").trim();

  if (complexity > 0.55 && depthInstr) {
    systemParts.push(`\nDOMAIN DEPTH:\n${depthInstr}`);
  }
  const styleGuidance = getOutputStyleGuidance(taxonomyMeta);
  if (styleGuidance) {
    systemParts.push(`\nOUTPUT STYLE:\n${styleGuidance}`);
  }
  if (difficulty >= 0.5) {
    const epistemic = getEpistemicGuidanceBlock(taxonomyMeta);
    if (epistemic) systemParts.push(`\nEPISTEMIC DISCIPLINE:\n${epistemic}`);
  }
  if (difficulty >= 0.4) {
    const discovery = getDiscoveryPrompt(taxonomyMeta);
    if (discovery) systemParts.push(`\nDISCOVERY:\n${discovery}`);
  }
  if (difficulty >= 0.5) {
    const requiredElements = (taxonomyMeta.required_elements ?? []) as string[];
    if (requiredElements.length > 0) {
      const elems = requiredElements.map((e) => `- ${e}`).join("\n");
      systemParts.push(
        "\nDOMAIN COVERAGE CHECKLIST (secondary to the Document Outline above):\n" +
        "The Document Outline is your primary structure. Additionally, ensure " +
        "these domain-mandated topics are covered somewhere in the response " +
        "(they may already appear in the outline):\n" + elems,
      );
    }
  }

  // L2 taxonomy blocks
  const eg = getEpistemicGuidanceBlock(taxonomyMeta);
  if (eg && difficulty >= 0.5) {
    systemParts.push(`\nDISCIPLINE EPISTEMICS (taxonomy):\n${eg}`);
  }
  const wr = getWriterRegulatedBlock(taxonomyMeta);
  if (wr) systemParts.push(`\nREGULATED CONTEXT (taxonomy):\n${wr}`);

  // Vertical persona block
  const activeVertical = String(taxonomyMeta.active_vertical ?? "generic");
  if (activeVertical !== "generic") {
    const snap = getOntologySnapshot();
    const personaBlock = getWorkerPersonaBlock(snap.verticalPrompts, activeVertical, task);
    if (personaBlock) systemParts.push(`\n${personaBlock}`);
  }

  const msgs: ChatMessage[] = [
    { role: "system" as const, content: systemParts.join(" ") },
  ];

  const conversationHistory = (state.messages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  if (conversationHistory.length > 1) {
    const prior = conversationHistory.slice(0, -1).slice(-6);
    msgs.push(...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })));
  }

  const hasEvidence = Boolean(evidenceBlock);
  const wrappedEvidence = hasEvidence
    ? `## Evidence\n${wrapUntrusted(evidenceBlock)}\n${SANDWICH_REMINDER}`
    : "";
  const scaffoldParts = [planBlock, wrappedEvidence].filter(Boolean).join("\n\n");
  const userContent = scaffoldParts ? `${task}\n\n${scaffoldParts}` : task;
  msgs.push({ role: "user" as const, content: userContent });

  return msgs;
}

export async function composeWriterDraft(state: GraphState): Promise<WriterResult> {
  const fallback = deterministicDraft(state);
  if (!isLlmAvailable()) return { content: fallback, usage: ZERO_USAGE };

  try {
    const result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "Synesis",
      temperature: 0.2,
      max_tokens: state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
      pricingRates: state.pricing_rates_by_role?.general,
      messages: buildWriterMessages(state),
    });
    return {
      content: result.content.trim() || fallback,
      usage: result.usage,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "writer LLM call failed, using deterministic fallback", error: detail, time: Date.now() }) + "\n");
    return { content: fallback, usage: ZERO_USAGE };
  }
}

/**
 * Streaming variant — calls onDelta for every token fragment so the SSE layer
 * can forward them to the client in real-time. Returns the same WriterResult
 * when complete so the critic can evaluate the full draft.
 */
export async function composeWriterDraftStream(
  state: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<WriterResult> {
  const fallback = deterministicDraft(state);
  if (!isLlmAvailable()) {
    onDelta({ content: fallback });
    return { content: fallback, usage: ZERO_USAGE };
  }

  try {
    const result = await chatCompletionStream(
      {
        model: process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "Synesis",
        temperature: 0.2,
        max_tokens: state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
        pricingRates: state.pricing_rates_by_role?.general,
        messages: buildWriterMessages(state),
      },
      onDelta,
    );
    return {
      content: result.content.trim() || fallback,
      usage: result.usage,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "writer streaming LLM call failed, using deterministic fallback", error: detail, time: Date.now() }) + "\n");
    onDelta({ content: fallback });
    return { content: fallback, usage: ZERO_USAGE };
  }
}
