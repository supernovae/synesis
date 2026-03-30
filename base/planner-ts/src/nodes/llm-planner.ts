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
import { TRUST_POLICY_COMPACT } from "../security/trust-prompts.js";
import { loadConfig } from "../config.js";
import { getPlannerSystemPromptAppend } from "../taxonomy/taxonomy-prompt-factory.js";
import { getPlannerDecompositionRules } from "../taxonomy/vertical-prompts.js";
import { getOntologySnapshot } from "../ontology/merge-plugins.js";

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
  effectiveMaxTokens: number;
}

const PLANNER_CAP_HARD_CEILING = 4096;

/**
 * Adaptive planner output budget.
 *
 * Raises the base cap for high-difficulty and complex/chaotic Cynefin tasks
 * where the LLM needs more room for detailed multi-step plans. The ceiling
 * prevents runaway latency on outlier prompts.
 */
export function computeAdaptivePlannerCap(baseCap: number, state: GraphState): number {
  let cap = baseCap;
  const difficulty = state.difficulty ?? 0;
  const cynefin = state.cynefin_domain;

  if (difficulty >= 0.7) cap += 800;
  if (cynefin === "complex" || cynefin === "chaotic") cap += 800;
  if (difficulty >= 0.85) cap += 400;

  return Math.min(cap, PLANNER_CAP_HARD_CEILING);
}

const WAIVER_PATTERNS = /\b(proceed|go\s*ahead|just\s*(do|answer)\s*it|use\s*(the\s*)?assumptions|skip\s*clarif|continue|let'?s\s*go)\b/i;
const ARCH_SIGNALS = /\b(architect|infrastructure|deploy|production|scale|cluster|kubernetes|k8s|microservice|platform|system design|saas|paas)\b/i;
const CLOUD_GENERIC = /\bcloud\b/i;
const CLOUD_SPECIFIC = /\b(aws|amazon|azure|gcp|google cloud|oci|oracle cloud|digitalocean|hetzner|linode|on-prem|on premise|self-hosted)\b/i;
const MODEL_GENERIC = /\b(model|llm|language model|embedding model|ai model|foundation model|chat model)\b/i;
const MODEL_SPECIFIC = /\b(gpt-4|claude|gemini|llama|mistral|qwen|deepseek|open.?source|proprietary|frontier|openai|anthropic|hugging.?face|vllm|ollama|openrouter)\b/i;
const SCALE_SIGNALS = /\b(concurrent|concurrency|throughput|rps|requests per|users|traffic|load|qps|tps|scale to)\b/i;

export function isClarificationWaiver(text: string): boolean {
  return WAIVER_PATTERNS.test(text.trim());
}

function buildAmbiguityCorpus(state: GraphState): string {
  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const goals = Array.isArray(taskFrame.goals) ? taskFrame.goals.map(String).join(" ") : "";
  const tasks = Array.isArray(taskFrame.tasks)
    ? taskFrame.tasks
        .map((t) => (t && typeof t === "object" ? String((t as Record<string, unknown>).description ?? "") : ""))
        .join(" ")
    : "";
  const mainQuestion = String(taskFrame.main_question ?? "");
  const constraints = Array.isArray(taskFrame.global_constraints)
    ? taskFrame.global_constraints.map(String).join(" ")
    : "";
  return `${mainQuestion} ${goals} ${tasks} ${constraints} ${(state.task_description ?? "")}`.trim();
}

/**
 * Ports the Python planner's targeted ambiguity probes (cloud/model/scale)
 * to preserve clarify-first behavior for architecture/system-design prompts.
 */
function detectActionableAmbiguities(state: GraphState): string[] {
  const difficulty = state.difficulty ?? 0;
  if (difficulty < 0.45) return [];
  const corpus = buildAmbiguityCorpus(state);
  if (!ARCH_SIGNALS.test(corpus)) return [];

  const probes: string[] = [];
  if (CLOUD_GENERIC.test(corpus) && !CLOUD_SPECIFIC.test(corpus)) {
    probes.push(
      "You mention cloud but not a specific provider. Do you prefer AWS, Azure, GCP, on-prem, or should I keep it cloud-agnostic?",
    );
  }
  if (MODEL_GENERIC.test(corpus) && !MODEL_SPECIFIC.test(corpus)) {
    probes.push(
      "You reference AI/LLM models but not a model strategy. Should this target self-hosted open-weight models, hosted APIs, or both?",
    );
  }
  if (!SCALE_SIGNALS.test(corpus)) {
    probes.push(
      "What scale are you targeting (for example team size, concurrent users, or request volume)? This materially changes architecture choices.",
    );
  }
  return probes.slice(0, 3);
}

function isStructuredOutputCompatibilityError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  if (/^llm http (400|404|415|422)/i.test(detail)) return true;
  return (
    lowered.includes("response_format") ||
    lowered.includes("json_schema") ||
    lowered.includes("unsupported") ||
    lowered.includes("not support")
  );
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
  const targetedAmbiguities = detectActionableAmbiguities(state);

  if (frameCoherence === "diffuse" && difficulty >= 0.4) return true;
  if (confidence < 0.5 && openQCount >= 1) return true;
  if (targetedAmbiguities.length > 0) return true;
  if (clarifyFirst && difficulty >= 0.4 && openQCount >= 1) return true;
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
  const targeted = detectActionableAmbiguities(state);
  const assumptions = plan.assumptions.slice(0, 3);

  const parts: string[] = [
    `I want to make sure I address your request accurately. Your question touches on **${frameDesc}**, and I have a few points I'd like to clarify before responding:`,
    "",
  ];

  // Deduplicate: parse-fallback path puts targeted ambiguities into open_questions,
  // so merging them again would produce duplicates.
  const seen = new Set(questions);
  const uniqueTargeted = targeted.filter((q) => !seen.has(q));
  const allQuestions = [...questions, ...uniqueTargeted].slice(0, 4);
  if (allQuestions.length > 0) {
    for (let i = 0; i < allQuestions.length; i++) {
      parts.push(`${i + 1}. ${allQuestions[i]}`);
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
    ...allQuestions.map((q) => q.replace(/\?$/, "").slice(0, 120)),
    "Proceed with assumptions",
  ];

  return { question: parts.join("\n"), options };
}

export async function runLlmPlanner(state: GraphState): Promise<{
  result: LlmPlannerResult;
  clarification?: { question: string; options: string[] };
}> {
  const plannerCfg = loadConfig();
  const effectiveMaxTokens = computeAdaptivePlannerCap(
    plannerCfg.SYNESIS_PLANNER_TS_PLANNER_MAX_TOKENS,
    state,
  );

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
        effectiveMaxTokens,
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

  // Taxonomy-driven dynamic suffix (appended after static core per prefix-cache rule)
  const taxonomyMeta = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const taxonomyAppend = getPlannerSystemPromptAppend(taxonomyMeta);
  const activeVertical = String(taxonomyMeta.active_vertical ?? "generic");
  const snap = getOntologySnapshot();
  const decompositionRules = getPlannerDecompositionRules(
    snap.verticalPrompts,
    activeVertical,
    taxonomyMeta,
    String(taxonomyMeta.taxonomy_key ?? ""),
  );
  const decompositionBlock = decompositionRules
    ? `\n\nDOMAIN DECOMPOSITION RULES (${activeVertical}):\n${decompositionRules}`
    : "";

  let result: { content: string; usage: LlmUsage };
  try {
    const plannerModel = process.env.SYNESIS_PLANNER_TS_PLANNER_MODEL
      ?? process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
      ?? "Synesis";
    const plannerMessages = [
      {
        role: "system" as const,
        content: [
          "You are Synesis Planner. Produce a JSON plan for the user's request.",
          "Output ONLY valid JSON matching this schema: { steps: [{ id, action, dependencies }], open_questions: string[], assumptions: string[], confidence: number, reasoning: string }.",
          "",
          TRUST_POLICY_COMPACT,
          "",
          "RULES:",
          "- If the user's latest message is a short follow-up (e.g., an answer choice like 'B)', 'yes', 'expand on that'), interpret it IN CONTEXT of the conversation history.",
          "- List ALL material assumptions you are making to create this plan.",
          "- List ALL open questions where the user's intent is genuinely ambiguous.",
          "- Rate your confidence (0.0-1.0) that this plan addresses the user's actual need.",
          "- Do NOT assume specific vendors/providers/technologies the user did not mention — list these as open questions.",
          "- ONLY list things genuinely ambiguous in the prompt, not technology choices you are inserting.",
          `- Target format: ${requestedFormat}.${schemaHint}`,
          taxonomyAppend,
          decompositionBlock,
        ].filter(Boolean).join("\n"),
      },
      {
        role: "user" as const,
        content: `${contextPreamble}${task}${feedback}${clarificationContext}`,
      },
    ];

    const plannerRequest = {
      model: plannerModel,
      temperature: 0,
      max_tokens: effectiveMaxTokens,
      pricingRates: state.pricing_rates_by_role?.router,
      request_id: state.run_id,
      authz_trace_id: state.authz_trace_id,
      messages: plannerMessages,
    };

    try {
      result = await chatCompletion({
        ...plannerRequest,
        response_format: { type: "json_object" },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!isStructuredOutputCompatibilityError(detail)) throw err;
      process.stderr.write(
        JSON.stringify({
          level: 30,
          msg: "planner structured-output mode unsupported; retrying without response_format",
          error: detail,
          time: Date.now(),
        }) + "\n",
      );
      result = await chatCompletion(plannerRequest);
    }
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
        effectiveMaxTokens,
      },
    };
  }

  let parsed: z.infer<typeof PlannerOutputSchema>;
  try {
    parsed = validateWithRepair(result.content, PlannerOutputSchema);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "planner output parse failed, using deterministic fallback", error: detail, raw_snippet: result.content.slice(0, 300), time: Date.now() }) + "\n");
    const parseFallbackPlan = {
      steps: [{ id: 1, action: `Answer: ${task}`, dependencies: [] }],
      open_questions: detectActionableAmbiguities(state),
      assumptions: ["LLM returned unparseable plan — using deterministic plan"],
      confidence: 0.45,
      reasoning: `Parse failed: ${detail}`,
    };

    if (shouldClarify(state, parseFallbackPlan)) {
      const clarification = buildClarificationQuestion(state, parseFallbackPlan);
      return {
        result: { plan: parseFallbackPlan, usage: result.usage, effectiveMaxTokens },
        clarification,
      };
    }

    return {
      result: {
        plan: { ...parseFallbackPlan, open_questions: [] },
        usage: result.usage,
        effectiveMaxTokens,
      },
    };
  }

  const planResult: LlmPlannerResult = { plan: parsed, usage: result.usage, effectiveMaxTokens };

  if (shouldClarify(state, parsed)) {
    const clarification = buildClarificationQuestion(state, parsed);
    return { result: planResult, clarification };
  }

  return { result: planResult };
}
