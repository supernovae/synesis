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
import { composePlannerPrompt } from "../prompt-composer.js";

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

const AmbiguityAssessmentSchema = z.object({
  ambiguity_level: z.number().min(0).max(1).optional().default(0),
  can_proceed_without_clarification: z.boolean().optional().default(true),
  material_gaps: z.array(z.object({
    missing_information: z.string(),
    impact_on_outcome: z.string(),
    suggested_question: z.string().optional().default(""),
  })).optional().default([]),
  clarification_questions: z.array(z.string()).optional().default([]),
  rationale: z.string().optional().default(""),
});

type AmbiguityAssessment = z.infer<typeof AmbiguityAssessmentSchema>;

export interface LlmPlannerResult {
  plan: PlannerOutput;
  usage: LlmUsage;
  effectiveMaxTokens: number;
  ambiguity_assessment?: AmbiguityAssessment;
  ambiguity_scorer_latency_ms?: number;
  ambiguity_scorer_error?: string;
  ambiguity_decision_reason?: string;
}

const PLANNER_CAP_HARD_CEILING = 4096;

/**
 * Always appended after composePlannerPrompt() so Prompt Library profiles
 * (style, Kimi tweaks, etc.) are never the last instruction — models often weigh
 * recency heavily; this re-anchors JSON-only output.
 */
const PLANNER_JSON_FOOTER = [
  "---",
  "FINAL OUTPUT (non-negotiable): Your entire assistant message must be one JSON object only.",
  "No markdown code fences, no text before or after the JSON.",
  "Keys: steps (array of { id: number, action: string, dependencies?: number[] }),",
  "open_questions (string[]), assumptions (string[]), confidence (number 0..1), reasoning (string).",
].join("\n");

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

export function isClarificationWaiver(text: string): boolean {
  return WAIVER_PATTERNS.test(text.trim());
}

async function runAmbiguityScorer(
  state: GraphState,
  plannerPlan: PlannerOutput,
): Promise<{ assessment?: AmbiguityAssessment; latencyMs?: number; error?: string }> {
  const cfg = loadConfig();
  if (!cfg.SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_ENABLED) {
    return {};
  }
  const model = cfg.SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MODEL
    || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
    || "synesis-general";
  const started = Date.now();
  try {
    const messages = [
      {
        role: "system" as const,
        content: [
          "You are Synesis Ambiguity Scorer.",
          "Return JSON only.",
          "Assess whether ambiguity is material to action quality.",
          "Do not over-ask; prefer 1-3 high-impact clarification questions.",
          "Schema:",
          "{ ambiguity_level: number 0..1, can_proceed_without_clarification: boolean, material_gaps: [{ missing_information: string, impact_on_outcome: string, suggested_question?: string }], clarification_questions: string[], rationale: string }",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          task_description: state.task_description ?? "",
          recent_messages: (state.messages ?? [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-6)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 500) })),
          planner_open_questions: plannerPlan.open_questions,
          planner_assumptions: plannerPlan.assumptions,
          planner_confidence: plannerPlan.confidence,
          frame_coherence: state.domain_profile?.frameCoherence ?? "focused",
          difficulty: state.difficulty ?? 0.3,
        }),
      },
    ];
    const result = await chatCompletion({
      model,
      temperature: 0,
      max_tokens: cfg.SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MAX_TOKENS,
      pricingRates: state.pricing_rates_by_role?.router,
      request_id: state.run_id,
      authz_trace_id: state.authz_trace_id,
      traceparent: state.traceparent,
      messages,
      response_format: { type: "json_object" },
    });
    const parsed = validateWithRepair(result.content, AmbiguityAssessmentSchema);
    const trimmedQuestions = parsed.clarification_questions
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 3);
    const trimmedGaps = parsed.material_gaps.slice(0, 5).map((g) => ({
      missing_information: g.missing_information.trim(),
      impact_on_outcome: g.impact_on_outcome.trim(),
      suggested_question: g.suggested_question.trim(),
    }));
    return {
      assessment: {
        ...parsed,
        clarification_questions: trimmedQuestions,
        material_gaps: trimmedGaps,
      },
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({
      level: 30,
      msg: "ambiguity scorer unavailable; using planner-only epistemic checks",
      error: detail,
      time: Date.now(),
    }) + "\n");
    return { error: detail, latencyMs: Date.now() - started };
  }
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

export function shouldClarify(
  state: GraphState,
  plan: PlannerOutput,
  ambiguity?: AmbiguityAssessment,
  threshold = 0.58,
): boolean {
  const iteration = state.iteration_count ?? 0;
  if (iteration > 0) return false;

  // Clarification follow-ups are separate HTTP requests; iteration_count is not
  // carried across turns, so the iteration guard alone cannot prevent a second
  // clarification. After the user answers, proceed (even if the planner LLM
  // output is still unparseable — parse fallback must not re-prompt forever).
  if (state.user_answer_to_clarification?.trim()) return false;

  const frameCoherence = state.domain_profile?.frameCoherence ?? "focused";
  const difficulty = state.difficulty ?? 0.3;
  const confidence = plan.confidence;
  const openQCount = plan.open_questions.length;
  const ambiguityLevel = ambiguity?.ambiguity_level ?? 0;
  const materialGapCount = ambiguity?.material_gaps.length ?? 0;
  const canProceed = ambiguity?.can_proceed_without_clarification ?? true;

  const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const controls = (taxonomy.output_controls ?? {}) as Record<string, unknown>;
  const clarifyFirst = Boolean(controls.clarify_first);

  if (frameCoherence === "diffuse" && difficulty >= 0.4 && (openQCount >= 1 || materialGapCount >= 1)) return true;
  if (!canProceed && materialGapCount >= 1) return true;
  if (ambiguityLevel >= threshold && materialGapCount >= 1) return true;
  if (confidence < 0.5 && (openQCount >= 1 || materialGapCount >= 1)) return true;
  if (clarifyFirst && difficulty >= 0.4 && (openQCount >= 1 || materialGapCount >= 1)) return true;

  return false;
}

function buildClarificationQuestion(
  state: GraphState,
  plan: PlannerOutput,
  ambiguity?: AmbiguityAssessment,
): { question: string; options: string[] } {
  const profile = state.domain_profile;
  const frameDesc = profile
    ? profile.domains.slice(0, 3).map((d) => d.key.replace(/_/g, " ")).join(", ")
    : "general";

  const suggestedByGap = (ambiguity?.material_gaps ?? [])
    .map((g) => g.suggested_question)
    .filter(Boolean);
  const questions = plan.open_questions.slice(0, 5);
  const scorerQuestions = ambiguity?.clarification_questions ?? [];
  const assumptions = plan.assumptions.slice(0, 3);

  const parts: string[] = [
    `I want to make sure I address your request accurately. Your question touches on **${frameDesc}**, and I have a few points I'd like to clarify before responding:`,
    "",
  ];

  const allQuestions = dedupeClarificationQuestions([
    ...questions,
    ...scorerQuestions,
    ...suggestedByGap,
  ]).slice(0, 3);

  if (allQuestions.length === 0 && (ambiguity?.material_gaps.length ?? 0) > 0) {
    allQuestions.push("Could you clarify the highest-priority constraints that should drive the approach?");
  }
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

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/^[\d\-\)\.\s]+/, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lexicalNearDuplicate(a: string, b: string): boolean {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const as = new Set(na.split(" ").filter((t) => t.length > 2));
  const bs = new Set(nb.split(" ").filter((t) => t.length > 2));
  if (as.size === 0 || bs.size === 0) return false;
  let intersection = 0;
  for (const token of as) {
    if (bs.has(token)) intersection += 1;
  }
  const union = as.size + bs.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard >= 0.5;
}

function dedupeClarificationQuestions(input: string[]): string[] {
  const out: string[] = [];
  for (const q of input) {
    if (!q?.trim()) continue;
    if (out.some((existing) => lexicalNearDuplicate(existing, q))) continue;
    out.push(q);
  }
  return out;
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
    const plannerSystemPrompt = [
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
    ].filter(Boolean).join("\n");
    const composed = composePlannerPrompt(plannerSystemPrompt, {
      tier: state.model_tier,
      role: "router",
      node: "planner",
      model: plannerModel,
    });
    const composedSystemPrompt = `${composed.content}\n\n${PLANNER_JSON_FOOTER}`;
    const plannerMessages = [
      {
        role: "system" as const,
        content: composedSystemPrompt,
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
      traceparent: state.traceparent,
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
      open_questions: [],
      assumptions: ["LLM returned unparseable plan — using deterministic plan"],
      confidence: 0.45,
      reasoning: `Parse failed: ${detail}`,
    };
    const ambiguity = await runAmbiguityScorer(state, parseFallbackPlan);
    const ambiguityThreshold = plannerCfg.SYNESIS_PLANNER_TS_AMBIGUITY_THRESHOLD;
    const clarify = shouldClarify(state, parseFallbackPlan, ambiguity.assessment, ambiguityThreshold);
    const decisionReason = clarify
      ? "clarify:parse-fallback-epistemic-ambiguity"
      : "proceed:parse-fallback-low-material-ambiguity";
    process.stderr.write(JSON.stringify({
      level: 30,
      msg: "planner ambiguity decision",
      decision: clarify ? "clarify" : "proceed",
      reason: decisionReason,
      ambiguity_level: ambiguity.assessment?.ambiguity_level ?? null,
      material_gaps: ambiguity.assessment?.material_gaps.length ?? 0,
      can_proceed_without_clarification: ambiguity.assessment?.can_proceed_without_clarification ?? null,
      scorer_latency_ms: ambiguity.latencyMs ?? null,
      time: Date.now(),
    }) + "\n");

    if (clarify) {
      const clarification = buildClarificationQuestion(state, parseFallbackPlan, ambiguity.assessment);
      return {
        result: {
          plan: parseFallbackPlan,
          usage: result.usage,
          effectiveMaxTokens,
          ambiguity_assessment: ambiguity.assessment,
          ambiguity_scorer_latency_ms: ambiguity.latencyMs,
          ambiguity_scorer_error: ambiguity.error,
          ambiguity_decision_reason: decisionReason,
        },
        clarification,
      };
    }

    return {
      result: {
        plan: { ...parseFallbackPlan, open_questions: [] },
        usage: result.usage,
        effectiveMaxTokens,
        ambiguity_assessment: ambiguity.assessment,
        ambiguity_scorer_latency_ms: ambiguity.latencyMs,
        ambiguity_scorer_error: ambiguity.error,
        ambiguity_decision_reason: decisionReason,
      },
    };
  }

  const ambiguity = await runAmbiguityScorer(state, parsed);
  const ambiguityThreshold = plannerCfg.SYNESIS_PLANNER_TS_AMBIGUITY_THRESHOLD;
  const clarify = shouldClarify(state, parsed, ambiguity.assessment, ambiguityThreshold);
  const decisionReason = clarify
    ? "clarify:epistemic-material-ambiguity"
    : "proceed:sufficiently-specified";
  process.stderr.write(JSON.stringify({
    level: 30,
    msg: "planner ambiguity decision",
    decision: clarify ? "clarify" : "proceed",
    reason: decisionReason,
    ambiguity_level: ambiguity.assessment?.ambiguity_level ?? null,
    material_gaps: ambiguity.assessment?.material_gaps.length ?? 0,
    can_proceed_without_clarification: ambiguity.assessment?.can_proceed_without_clarification ?? null,
    scorer_latency_ms: ambiguity.latencyMs ?? null,
    time: Date.now(),
  }) + "\n");
  const planResult: LlmPlannerResult = {
    plan: parsed,
    usage: result.usage,
    effectiveMaxTokens,
    ambiguity_assessment: ambiguity.assessment,
    ambiguity_scorer_latency_ms: ambiguity.latencyMs,
    ambiguity_scorer_error: ambiguity.error,
    ambiguity_decision_reason: decisionReason,
  };

  if (clarify) {
    const clarification = buildClarificationQuestion(state, parsed, ambiguity.assessment);
    return { result: planResult, clarification };
  }

  return { result: planResult };
}
