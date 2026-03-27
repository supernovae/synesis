/**
 * LLM-powered planner with epistemological clarification gates.
 *
 * When the LLM is available, the planner produces structured JSON including
 * its own assessment of what it doesn't know (open_questions), what it
 * assumed (assumptions), and its confidence. These signals — combined with
 * domain profile frame coherence — drive clarification decisions.
 *
 * Design references:
 *   Klein (2007) Data-Frame theory: fit data into frames, seek data when frames break
 *   Snowden & Boone (2007) Cynefin: probe-sense-respond for complex/chaotic
 *   Woods & Hollnagel (2006) JCS: expose partial understanding, invite refinement
 */

import { z } from "zod";
import { chatCompletion, isLlmAvailable, ZERO_USAGE, type LlmUsage } from "../llm/client.js";
import { validateWithRepair } from "../validation/json-repair.js";
import type { GraphState } from "../state/types.js";

const PlannerOutputSchema = z.object({
  steps: z.array(z.object({
    id: z.number(),
    action: z.string(),
    dependencies: z.array(z.number()).optional().default([]),
  })).min(1),
  open_questions: z.array(z.string()).optional().default([]),
  assumptions: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.7),
  reasoning: z.string().optional().default(""),
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export interface LlmPlannerResult {
  plan: PlannerOutput;
  usage: LlmUsage;
}

const WAIVER_PATTERNS = /\b(proceed|go\s*ahead|just\s*(do|answer)\s*it|use\s*(the\s*)?assumptions|skip\s*clarif|continue|let'?s\s*go)\b/i;

export function isClarificationWaiver(text: string): boolean {
  return WAIVER_PATTERNS.test(text.trim());
}

export function shouldClarify(state: GraphState, plan: PlannerOutput): boolean {
  const iteration = state.iteration_count ?? 0;
  if (iteration > 0) return false;

  const frameCoherence = state.domain_profile?.frameCoherence ?? "focused";
  const difficulty = state.difficulty ?? 0.3;
  const confidence = plan.confidence;
  const openQCount = plan.open_questions.length;

  const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const controls = (taxonomy.output_controls ?? {}) as Record<string, unknown>;
  const clarifyFirst = Boolean(controls.clarify_first);

  if (frameCoherence === "diffuse" && difficulty >= 0.4) return true;
  if (confidence < 0.5 && openQCount >= 1) return true;
  if (clarifyFirst && openQCount >= 2 && difficulty >= 0.4) return true;

  return false;
}

function buildClarificationQuestion(
  state: GraphState,
  plan: PlannerOutput,
): { question: string; options: string[] } {
  const task = state.task_description ?? "your request";
  const profile = state.domain_profile;
  const frameDesc = profile
    ? profile.domains.slice(0, 3).map((d) => d.key.replace(/_/g, " ")).join(", ")
    : "general";

  const questions = plan.open_questions.slice(0, 3);
  const assumptions = plan.assumptions.slice(0, 3);

  const parts: string[] = [
    `I want to make sure I address your request accurately. Your question touches on **${frameDesc}**, and I have a few points I'd like to clarify before responding:`,
    "",
  ];

  if (questions.length > 0) {
    for (let i = 0; i < questions.length; i++) {
      parts.push(`${i + 1}. ${questions[i]}`);
    }
    parts.push("");
  }

  if (assumptions.length > 0) {
    parts.push("If you'd prefer I proceed now, I would assume:");
    for (const a of assumptions) {
      parts.push(`- ${a}`);
    }
    parts.push("");
  }

  parts.push('You can answer the questions above, or say "proceed" to use my assumptions.');

  const options = [
    ...questions.map((q) => q.replace(/\?$/, "").slice(0, 100)),
    "Proceed with assumptions",
  ];

  return { question: parts.join("\n"), options };
}

export async function runLlmPlanner(state: GraphState): Promise<{
  result: LlmPlannerResult;
  clarification?: { question: string; options: string[] };
}> {
  if (!isLlmAvailable()) {
    return {
      result: {
        plan: {
          steps: [{ id: 1, action: `Answer: ${state.task_description ?? "user request"}`, dependencies: [] }],
          open_questions: [],
          assumptions: [],
          confidence: 0.7,
          reasoning: "LLM unavailable — deterministic plan",
        },
        usage: ZERO_USAGE,
      },
    };
  }

  const task = state.task_description ?? "No task provided";
  const feedback = state.plan_gate_feedback ? `\nPlan gate feedback:\n${state.plan_gate_feedback}` : "";
  const clarificationContext = state.user_answer_to_clarification
    ? `\nThe user answered a clarification question with: "${state.user_answer_to_clarification}". Incorporate this answer and update your confidence accordingly.`
    : "";

  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const requestedFormat = String(taskFrame.requested_format ?? "prose");
  const outputSchema = Array.isArray(taskFrame.output_schema) ? taskFrame.output_schema.map(String) : [];
  const schemaHint = outputSchema.length > 0 ? ` Output schema fields: ${outputSchema.join(", ")}.` : "";

  const conversationHistory = (state.messages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  let contextPreamble = "";
  if (conversationHistory.length > 1) {
    const prior = conversationHistory.slice(0, -1).slice(-4);
    contextPreamble = "Recent conversation context:\n" +
      prior.map((m) => `[${m.role}]: ${m.content.slice(0, 300)}`).join("\n") + "\n\n";
  }

  let result: { content: string; usage: LlmUsage };
  try {
    result = await chatCompletion({
      model: process.env.SYNESIS_PLANNER_TS_PLANNER_MODEL ?? process.env.SYNESIS_PLANNER_TS_WRITER_MODEL ?? "Synesis",
      temperature: 0,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: [
            "You are Synesis Planner. Produce a JSON plan for the user's request.",
            "Output ONLY valid JSON matching this schema: { steps: [{ id, action, dependencies }], open_questions: string[], assumptions: string[], confidence: number, reasoning: string }.",
            "RULES:",
            "- If the user's latest message is a short follow-up (e.g., an answer choice like 'B)', 'yes', 'expand on that'), interpret it IN CONTEXT of the conversation history.",
            "- List ALL material assumptions you are making to create this plan.",
            "- List ALL open questions where the user's intent is genuinely ambiguous.",
            "- Rate your confidence (0.0-1.0) that this plan addresses the user's actual need.",
            "- Do NOT assume specific vendors/providers/technologies the user did not mention — list these as open questions.",
            "- ONLY list things genuinely ambiguous in the prompt, not technology choices you are inserting.",
            `- Target format: ${requestedFormat}.${schemaHint}`,
          ].join("\n"),
        },
        {
          role: "user",
          content: `${contextPreamble}${task}${feedback}${clarificationContext}`,
        },
      ],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "llm planner call failed, using deterministic fallback", error: detail, time: Date.now() }) + "\n");
    return {
      result: {
        plan: {
          steps: [{ id: 1, action: `Answer: ${task}`, dependencies: [] }],
          open_questions: [],
          assumptions: ["LLM planner call failed — using deterministic plan"],
          confidence: 0.5,
          reasoning: `LLM planner unavailable: ${detail}`,
        },
        usage: ZERO_USAGE,
      },
    };
  }

  let parsed: z.infer<typeof PlannerOutputSchema>;
  try {
    parsed = validateWithRepair(result.content, PlannerOutputSchema);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "planner output parse failed, using deterministic fallback", error: detail, raw_snippet: result.content.slice(0, 300), time: Date.now() }) + "\n");
    return {
      result: {
        plan: {
          steps: [{ id: 1, action: `Answer: ${task}`, dependencies: [] }],
          open_questions: [],
          assumptions: ["LLM returned unparseable plan — using deterministic plan"],
          confidence: 0.5,
          reasoning: `Parse failed: ${detail}`,
        },
        usage: result.usage,
      },
    };
  }

  const planResult: LlmPlannerResult = { plan: parsed, usage: result.usage };

  if (shouldClarify(state, parsed)) {
    const clarification = buildClarificationQuestion(state, parsed);
    return { result: planResult, clarification };
  }

  return { result: planResult };
}
