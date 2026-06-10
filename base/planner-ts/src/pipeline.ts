import { randomUUID } from "node:crypto";
import { routeAfterCritic } from "./nodes/critic-routing.js";
import { classifyEntry } from "./nodes/entry-classifier.js";
import {
  annotateViolations,
  fingerprintDraft,
  validateMermaidSyntax,
  validateCitationPreservation,
  validateDecisionDrift,
  validateStyleCompliance
} from "./nodes/contract-validator.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { planGate } from "./nodes/plan-gate.js";
import { runRouter } from "./nodes/router.js";
import { frameExtractorNode } from "./nodes/frame-extractor.js";
import type { RetrievalClient } from "./retrieval/client.js";
import { validatedNode } from "./nodes/validated-node.js";
import { composeWriterDraft, composeWriterDraftStream } from "./nodes/writer-compose.js";
import { runLlmPlanner, isClarificationWaiver, computeAdaptivePlannerCap } from "./nodes/llm-planner.js";
import { isLlmAvailable } from "./llm/client.js";
import type { StreamDelta } from "./llm/client.js";
import { mergeUsage } from "@synesis/telemetry";
import type { LlmUsage, TraceLLMCallRecord } from "@synesis/telemetry";
import type { DecisionEntry } from "./contracts/schemas.js";
import type { GraphState } from "./state/types.js";
import { SpanCollector } from "./tracing/span-collector.js";
import { loadConfig } from "./config.js";
import { budgetSpanMetadata } from "./budgets.js";
import { maybePublishKnowledgeGap } from "./knowledge-backlog.js";
import { refreshPlannerArchitectureMediation } from "./context/architecture-mediation.js";

let _retrievalClient: RetrievalClient | undefined;

export function setRetrievalClient(client: RetrievalClient): void {
  _retrievalClient = client;
}

/** True after `setRetrievalClient` (unified RAG+web path); false means router uses NullRetrievalClient. */
export function isRetrievalClientRegistered(): boolean {
  return _retrievalClient !== undefined;
}

function ensureForwarded(state: GraphState): GraphState {
  return {
    ...state,
    evidence_packets: state.evidence_packets ?? [],
    generated_code: state.generated_code ?? "",
    code_explanation: state.code_explanation ?? "",
    patch_ops: state.patch_ops ?? []
  };
}

function ensureCollector(state: GraphState): SpanCollector {
  if (!state._span_collector) {
    state._span_collector = new SpanCollector();
  }
  return state._span_collector;
}

function usageToLlmCall(
  nodeName: string,
  model: string,
  usage: LlmUsage | undefined,
  latencyMs: number,
): TraceLLMCallRecord | undefined {
  if (!usage || usage.total_tokens === 0) return undefined;
  const node = (nodeName || "").toLowerCase();
  const role =
    node.includes("critic")
      ? "critic"
      : (node.includes("router") || node.includes("planner") || node.includes("entry") || node.includes("frame"))
        ? "router"
        : "general";
  return {
    model,
    node: nodeName,
    role,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cached_prompt_tokens: usage.cached_prompt_tokens || undefined,
    latency_ms: latencyMs,
    timestamp: Date.now() / 1000,
    actual_cost: usage.actual_cost_usd || undefined,
    estimated_cost: usage.estimated_cost_usd || undefined,
  };
}

function appendDecisionLedger(
  state: GraphState,
  entry: Omit<DecisionEntry, "decision_id"> & { decision_id?: string }
): GraphState {
  const ledger = state.decision_ledger ?? [];
  const nextId = entry.decision_id ?? `${state.run_id ?? "run"}:${ledger.length + 1}`;
  return {
    ...state,
    decision_ledger: [...ledger, { ...entry, decision_id: nextId }]
  };
}

function scrubInternalScaffolding(output: string): string {
  let text = output ?? "";
  text = text.replace(/^\s*\[planner\].*$/gim, "");
  const hasPlan = /(^|\n)\s*(?:#+\s*)?Plan:?(\s|$)/i.test(text);
  const hasEvidence = /(^|\n)\s*(?:#+\s*)?Evidence:?(\s|$)/i.test(text);
  const hasAnswer = /(^|\n)\s*(?:#+\s*)?Answer:?(\s|$)/i.test(text);
  const hasScaffold = hasPlan && hasEvidence && hasAnswer;
  if (hasScaffold) {
    const answerMatch = text.match(/(?:^|\n)\s*(?:#+\s*)?Answer:?\s*([\s\S]*)$/i);
    if (answerMatch?.[1]) {
      text = answerMatch[1];
    }
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function renderEvidenceMediationBlock(state: GraphState): string {
  const packets = state.evidence_packets ?? [];
  if (packets.length === 0) return "";
  const lines: string[] = [];
  for (const packet of packets.slice(0, 4)) {
    lines.push(`Query: ${packet.query}`);
    if (packet.summary) lines.push(`Summary: ${packet.summary}`);
    for (const source of packet.sources.slice(0, 6)) {
      lines.push(`Source: ${source.uri}`);
    }
  }
  return lines.join("\n");
}

function refreshArchitectureStateForWriter(state: GraphState): GraphState {
  const refreshed = refreshPlannerArchitectureMediation(state.architecture_mediation, {
    messages: state.messages ?? [],
    taskDescription: state.task_description,
    evidenceBlock: renderEvidenceMediationBlock(state),
    plannerSignals: {
      assumptions: state.assumptions,
      openQuestions: Array.isArray((state.execution_plan ?? {}).open_questions)
        ? ((state.execution_plan as Record<string, unknown>).open_questions as string[])
        : undefined,
      commitments: (state.decision_ledger ?? []).slice(-3).map((entry) => `${entry.category}: ${entry.chosen}`),
    },
  });
  if (!refreshed) return state;
  return {
    ...state,
    architecture_mediation: refreshed,
    planner_active_state_header: refreshed.activeStateHeader,
    planner_architecture_trace: {
      ...refreshed.trace,
      hygiene_removed_messages: state.planner_architecture_trace?.hygiene_removed_messages,
    },
  };
}

function isJsonOutputRequested(state: GraphState): boolean {
  const type = String((state.requested_response_format ?? {}).type ?? "").toLowerCase();
  return type === "json_object" || type === "json_schema";
}

export async function entryPipelineNode(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("entry_pipeline");
  const classified = await classifyEntry({
    ...state,
    _span_collector: collector,
    iteration_count: state.iteration_count ?? 0,
    max_iterations: state.max_iterations ?? 4
  });
  let withFrame = classified;
  if (!classified.task_is_trivial && (classified.difficulty ?? 0) >= 0.15) {
    try {
      withFrame = await frameExtractorNode(classified);
    } catch {
      // Frame extraction is best-effort; classification is sufficient to proceed
    }
  }

  collector.endSpan("entry_pipeline", {
    outcome: withFrame.task_is_trivial ? "trivial_fast_path" : "classified",
    confidence: withFrame.difficulty ?? 0,
    metadata: {
      difficulty: withFrame.difficulty,
      writer_max_tokens: withFrame.writer_max_tokens,
      critic_max_tokens: withFrame.critic_max_tokens,
      task_is_trivial: withFrame.task_is_trivial,
      model_tier: withFrame.model_tier,
      task_size: withFrame.task_size,
      cynefin_domain: withFrame.cynefin_domain,
      plan_required: withFrame.plan_required,
      rag_mode: withFrame.rag_mode,
      domain_profile: withFrame.domain_profile,
      taxonomy: withFrame.taxonomy_metadata,
      has_task_frame: Boolean(withFrame.task_frame),
      task_frame_summary: withFrame.task_frame
        ? {
            main_question: (withFrame.task_frame as Record<string, unknown>).main_question,
            requested_format: (withFrame.task_frame as Record<string, unknown>).requested_format,
            tasks_count: Array.isArray((withFrame.task_frame as Record<string, unknown>).tasks)
              ? ((withFrame.task_frame as Record<string, unknown>).tasks as unknown[]).length
              : 0,
            ambiguities_count: Array.isArray((withFrame.task_frame as Record<string, unknown>).ambiguities)
              ? ((withFrame.task_frame as Record<string, unknown>).ambiguities as unknown[]).length
              : 0,
          }
        : undefined,
    },
  });
  return ensureForwarded(withFrame);
}

export async function plannerNode(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("planner");

  if (state.plan_required === false) {
    collector.endSpan("planner", {
      outcome: "skip_plan_not_required",
      confidence: 0.9,
      metadata: { reason: "plan_required=false" },
    });
    return ensureForwarded({
      ...state,
      execution_plan: {
        steps: [{ id: 1, action: `Directly answer: ${state.task_description ?? "User request"}`, files: [], dependencies: [] }],
        open_questions: [],
        assumptions: []
      },
      planner_confidence: 0.9,
      plan_gate_passed: true,
      next_node: "router"
    });
  }

  if (state.user_answer_to_clarification && isClarificationWaiver(state.user_answer_to_clarification)) {
    collector.endSpan("planner", {
      outcome: "clarification_waived",
      metadata: { waiver: state.user_answer_to_clarification },
    });
    return ensureForwarded({
      ...state,
      clarification_question: undefined,
      clarification_options: undefined,
      plan_gate_passed: true,
      next_node: "router"
    });
  }

  if (isLlmAvailable()) {
    return llmDrivenPlanner(state);
  }
  return deterministicPlanner(state);
}

async function llmDrivenPlanner(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  const task = state.task_description ?? "User request";
  let plannerResult: Awaited<ReturnType<typeof runLlmPlanner>>;
  try {
    plannerResult = await runLlmPlanner(state);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "llmDrivenPlanner failed, falling back to deterministic", error: detail, time: Date.now() }) + "\n");
    const fallbackCap = computeAdaptivePlannerCap(loadConfig().SYNESIS_PLANNER_TS_PLANNER_MAX_TOKENS, state);
    collector.endSpan("planner", { outcome: "llm_fallback_to_deterministic", metadata: { error: detail, ...budgetSpanMetadata(fallbackCap, undefined) } });
    return deterministicPlanner(state);
  }
  const { result, clarification } = plannerResult;
  const effectiveCap = result.effectiveMaxTokens;
  const model = state.response_model ?? state.requested_model ?? "unknown";
  const llmCall = usageToLlmCall("planner", model, result.usage, 0);

  if (clarification) {
    collector.endSpan("planner", {
      outcome: "clarification_triggered",
      confidence: result.plan.confidence,
      tokens_used: result.usage?.total_tokens ?? 0,
      llm_calls: llmCall ? [llmCall] : [],
      metadata: {
        open_questions: result.plan.open_questions,
        assumptions: result.plan.assumptions,
        clarification_question: clarification.question,
        ambiguity_assessment: result.ambiguity_assessment,
        ambiguity_scorer_latency_ms: result.ambiguity_scorer_latency_ms,
        ambiguity_scorer_error: result.ambiguity_scorer_error,
        ambiguity_decision_reason: result.ambiguity_decision_reason,
        ...budgetSpanMetadata(effectiveCap, result.usage),
      },
    });
    const planned = ensureForwarded({
      ...state,
      execution_plan: {
        steps: result.plan.steps.map((s) => ({ ...s, files: [], dependencies: s.dependencies ?? [] })),
        open_questions: result.plan.open_questions,
        assumptions: result.plan.assumptions,
      },
      assumptions: result.plan.assumptions,
      planner_confidence: result.plan.confidence,
      clarification_question: clarification.question,
      clarification_options: clarification.options,
      llm_usage: mergeUsage(state.llm_usage, result.usage),
      next_node: "respond",
      generated_code: clarification.question,
    });
    return appendDecisionLedger(planned, {
      category: "approach",
      chosen: "clarify_before_acting",
      rejected_alternatives: ["proceed_with_assumptions"],
      rationale: `Planner triggered clarification (confidence=${result.plan.confidence}, open_questions=${result.plan.open_questions.length}, frame=${state.domain_profile?.frameCoherence ?? "unknown"})`,
      decided_by: "planner",
      frozen: false,
    });
  }

  collector.endSpan("planner", {
    outcome: "plan_generated",
    confidence: result.plan.confidence,
    tokens_used: result.usage?.total_tokens ?? 0,
    llm_calls: llmCall ? [llmCall] : [],
    metadata: {
      steps_count: result.plan.steps.length,
      open_questions: result.plan.open_questions,
      assumptions: result.plan.assumptions,
      ambiguity_assessment: result.ambiguity_assessment,
      ambiguity_scorer_latency_ms: result.ambiguity_scorer_latency_ms,
      ambiguity_scorer_error: result.ambiguity_scorer_error,
      ambiguity_decision_reason: result.ambiguity_decision_reason,
      ...budgetSpanMetadata(effectiveCap, result.usage),
    },
  });
  const feedback = state.plan_gate_feedback ? `\nFeedback: ${state.plan_gate_feedback}` : "";
  const planned = ensureForwarded({
    ...state,
    execution_plan: {
      steps: result.plan.steps.map((s) => ({ ...s, files: [], dependencies: s.dependencies ?? [] })),
      open_questions: result.plan.open_questions,
      assumptions: result.plan.assumptions,
    },
    assumptions: result.plan.assumptions,
    planner_confidence: result.plan.confidence,
    clarification_question: undefined,
    clarification_options: undefined,
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "plan_gate",
    plan_gate_feedback: `Plan drafted for: ${task}${feedback}`,
  });
  return appendDecisionLedger(planned, {
    category: "approach",
    chosen: "plan_then_gate",
    rejected_alternatives: ["direct_writer_without_plan", "clarify_before_acting"],
    rationale: `LLM planner generated plan (confidence=${result.plan.confidence}, assumptions=${result.plan.assumptions.length}, authz_trace_id=${state.authz_trace_id ?? "none"})`,
    decided_by: "planner",
    frozen: false,
  });
}

function deterministicPlanner(state: GraphState): GraphState {
  const collector = ensureCollector(state);
  const task = state.task_description ?? "User request";
  const feedback = state.plan_gate_feedback ? `\n\nPlan gate feedback:\n${state.plan_gate_feedback}` : "";
  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const requestedFormat = String(taskFrame.requested_format ?? "prose");
  const outputSchema = Array.isArray(taskFrame.output_schema) ? taskFrame.output_schema.map(String) : [];
  const deliverableLabels = Array.isArray(taskFrame.tasks)
    ? (taskFrame.tasks as Array<Record<string, unknown>>).map((t) => String(t.description ?? "")).filter(Boolean)
    : [];
  const schemaHint = outputSchema.length > 0 ? ` with schema fields ${outputSchema.join(", ")}` : "";
  const deliverableHint = deliverableLabels.length > 0 ? ` covering deliverables ${deliverableLabels.join(", ")}` : "";
  const stepAction = `Produce a grounded ${requestedFormat} response${schemaHint}${deliverableHint} for: ${task}`;
  collector.endSpan("planner", {
    outcome: "deterministic_plan",
    confidence: 0.7,
    metadata: { mode: "deterministic", requested_format: requestedFormat },
  });
  const planned = ensureForwarded({
    ...state,
    execution_plan: {
      steps: [{ id: 1, action: stepAction, files: [], dependencies: [] }],
      open_questions: [],
      assumptions: []
    },
    planner_confidence: 0.7,
    next_node: "plan_gate",
    plan_gate_feedback: `Plan drafted for: ${task}${feedback}`
  });
  return appendDecisionLedger(planned, {
    category: "approach",
    chosen: "plan_then_gate",
    rejected_alternatives: ["direct_writer_without_plan"],
    rationale: `Deterministic planner generated execution plan (authz_trace_id=${state.authz_trace_id ?? "none"})`,
    decided_by: "planner",
    frozen: false,
  });
}

export async function routerNode(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("router");

  if (state.rag_mode === "disabled") {
    collector.endSpan("router", {
      outcome: "skip_retrieval_rag_disabled",
      metadata: { rag_mode: "disabled", packets: 0 },
    });
    return appendDecisionLedger(
      ensureForwarded({
        ...state,
        evidence_packets: state.evidence_packets ?? [],
        need_more_evidence: false,
        next_node: "writer"
      }),
      {
        category: "scope",
        chosen: "skip_retrieval_trivial_path",
        rejected_alternatives: ["retrieve_more_evidence"],
        rationale: "Entry classifier selected trivial/no-RAG path for latency protection",
        decided_by: "router",
        frozen: false
      }
    );
  }
  const routed = await runRouter(state, { retrievalClient: _retrievalClient });
  const packets = routed.evidence_packets ?? [];
  collector.endSpan("router", {
    outcome: routed.need_more_evidence ? "needs_more_evidence" : "evidence_sufficient",
    metadata: {
      packets_found: packets.length,
      rag_mode: state.rag_mode,
    },
  });
  const traced = ensureForwarded(routed);
  maybePublishKnowledgeGap(traced);
  const chosen = traced.need_more_evidence ? "retrieve_more_evidence" : "use_current_evidence";
  return appendDecisionLedger(traced, {
    category: "scope",
    chosen,
    rejected_alternatives: traced.need_more_evidence ? ["proceed_without_retrieval"] : ["retrieve_more_evidence"],
    rationale: `Router set evidence policy based on retrieval confidence (authz_trace_id=${state.authz_trace_id ?? "none"})`,
    decided_by: "router",
    frozen: false
  });
}

async function writerNodeCore(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("writer");
  const writerState = refreshArchitectureStateForWriter(state);
  const result = await composeWriterDraft(writerState);
  const fingerprint = fingerprintDraft(result.content);
  const model = state.response_model ?? state.requested_model ?? "unknown";
  const llmCall = usageToLlmCall("writer", model, result.usage, 0);
  collector.endSpan("writer", {
    outcome: "draft_composed",
    tokens_used: result.usage?.total_tokens ?? 0,
    llm_calls: llmCall ? [llmCall] : [],
    metadata: {
      content_length: result.content.length,
      evidence_packets_used: (state.evidence_packets ?? []).length,
      ...budgetSpanMetadata(
        state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
        result.usage,
      ),
    },
  });
  return ensureForwarded({
    ...writerState,
    generated_code: result.content,
    draft_fingerprints: [...(state.draft_fingerprints ?? []), fingerprint],
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "critic"
  });
}

async function writerNodeStreamingCore(
  state: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("writer");
  const writerState = refreshArchitectureStateForWriter(state);
  const result = await composeWriterDraftStream(writerState, onDelta);
  const fingerprint = fingerprintDraft(result.content);
  const model = state.response_model ?? state.requested_model ?? "unknown";
  const llmCall = usageToLlmCall("writer", model, result.usage, 0);
  collector.endSpan("writer", {
    outcome: "draft_composed_streaming",
    tokens_used: result.usage?.total_tokens ?? 0,
    llm_calls: llmCall ? [llmCall] : [],
    metadata: {
      content_length: result.content.length,
      evidence_packets_used: (state.evidence_packets ?? []).length,
      ...budgetSpanMetadata(
        state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
        result.usage,
      ),
    },
  });
  return ensureForwarded({
    ...writerState,
    generated_code: result.content,
    draft_fingerprints: [...(state.draft_fingerprints ?? []), fingerprint],
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "critic"
  });
}

async function criticNodeCore(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("critic");
  const iteration = (state.iteration_count ?? 0) + 1;
  const criticResult = await evaluateCritic(state);
  const critic = criticResult;
  const style = validateStyleCompliance(state);
  const drift = validateDecisionDrift(state);
  const citations = validateCitationPreservation(state);
  const allViolations = [...style.violations, ...drift.violations, ...citations.violations];
  const approved = allViolations.length === 0 && critic.approved;
  const needMoreEvidence = citations.violations.length > 0 || critic.need_more_evidence || (state.need_more_evidence ?? false);
  const shouldContinue = !approved;
  const routed = routeAfterCritic({
    ...state,
    iteration_count: iteration,
    critic_approved: approved,
    need_more_evidence: needMoreEvidence,
    critic_should_continue: shouldContinue
  });
  const model = loadConfig().SYNESIS_PLANNER_TS_CRITIC_MODEL || "synesis-critic";
  const llmCall = usageToLlmCall("critic", model, criticResult.usage, 0);
  collector.endSpan("critic", {
    outcome: approved ? "approved" : "rejected",
    confidence: typeof critic.scores === "object"
      ? Object.values(critic.scores as Record<string, number>).reduce((a, b) => a + b, 0) /
        Math.max(Object.keys(critic.scores as Record<string, number>).length, 1)
      : 0,
    tokens_used: criticResult.usage?.total_tokens ?? 0,
    llm_calls: llmCall ? [llmCall] : [],
    metadata: {
      approved,
      scores: critic.scores,
      blocking_issues: critic.blocking_issues,
      violations: allViolations.length,
      routed_to: routed,
      iteration,
      execution_mode: criticResult.usage?.total_tokens ? "llm" : "deterministic",
      ...budgetSpanMetadata(
        state.critic_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE,
        criticResult.usage,
      ),
    },
  });
  const critiqued = ensureForwarded({
    ...state,
    iteration_count: iteration,
    critic_approved: approved,
    need_more_evidence: needMoreEvidence,
    critic_should_continue: shouldContinue,
    critic_scores: critic.scores as unknown as Record<string, number>,
    blocking_issues: critic.blocking_issues as unknown as Array<Record<string, unknown>>,
    critic_nonblocking: critic.nonblocking as unknown as Array<Record<string, unknown>>,
    critic_feedback: critic.continue_reason ?? "",
    critic_continue_reason: critic.continue_reason ?? null,
    llm_usage: mergeUsage(state.llm_usage, criticResult.usage),
    next_node: routed
  });
  return appendDecisionLedger(critiqued, {
    category: "approach",
    chosen: routed,
    rejected_alternatives: ["respond"],
    rationale: `Critic routed workflow to '${routed}' after validation (authz_trace_id=${state.authz_trace_id ?? "none"})`,
    decided_by: "critic",
    frozen: false
  });
}

export const writerNode = validatedNode(
  writerNodeCore,
  [],
  [validateStyleCompliance, validateMermaidSyntax],
  {
    onPostViolations: (result, violations) => ({
      ...result,
      _validation_warnings: [...(result._validation_warnings ?? []), ...violations]
    })
  }
);

export async function writerNodeStreaming(
  state: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<GraphState> {
  const result = await writerNodeStreamingCore(state, onDelta);
  const styleCheck = validateStyleCompliance(result);
  const mermaidCheck = validateMermaidSyntax(result);
  const violations = [...styleCheck.violations, ...mermaidCheck.violations];
  if (violations.length > 0) {
    return {
      ...result,
      _validation_warnings: [...(result._validation_warnings ?? []), ...violations],
    };
  }
  return result;
}

export const criticNode = validatedNode(
  criticNodeCore,
  [validateStyleCompliance, validateMermaidSyntax, validateDecisionDrift, validateCitationPreservation],
  [validateStyleCompliance, validateMermaidSyntax, validateDecisionDrift, validateCitationPreservation],
  {
    onPostViolations: (result, violations) => {
      const citationsDropped = violations.some((violation) => violation.startsWith("citation_dropped"));
      const annotated = annotateViolations(result, violations);
      return {
        ...result,
        critique_register: annotated.critique_register,
        critic_approved: false,
        critic_should_continue: true,
        need_more_evidence: result.need_more_evidence || citationsDropped
      };
    }
  }
);

/**
 * Domain-aware closing follow-up prompts. Keyed by taxonomy domain prefix;
 * falls back to a generic prompt when no domain matches.
 */
const DOMAIN_FOLLOWUPS: Record<string, string> = {
  software: "Would you like me to dive deeper into any of these sections, explore a specific implementation detail, or generate starter code for any component?",
  code: "Want me to extend this further, add tests, refactor any section, or explain a specific part in more detail?",
  data: "Would you like me to elaborate on any data aspect, generate sample queries, or explore alternative approaches?",
  security: "Should I expand on any security control, generate policy templates, or walk through a specific threat scenario?",
  devops: "Want me to generate manifests, write pipeline configs, or drill into any deployment detail?",
  ml_ai: "Would you like me to go deeper on model selection, training strategy, evaluation metrics, or generate implementation code?",
  cloud: "Should I detail a specific service, generate IaC templates, or compare alternative architectures?",
};
const GENERIC_FOLLOWUP = "Would you like me to expand on any section, explore a related topic, or go deeper on a specific detail?";

function buildClosingFollowup(state: GraphState): string | undefined {
  const cfg = loadConfig();
  if (!cfg.SYNESIS_PLANNER_TS_CLOSING_FOLLOWUP_ENABLED) return undefined;

  // Skip for: clarification turns, trivial tasks, error states, very short responses
  if (state.clarification_question) return undefined;
  if (state.user_answer_to_clarification) return undefined;
  if (state.task_is_trivial) return undefined;
  if (state.error) return undefined;
  const content = state.generated_code ?? "";
  if (content.length < 200) return undefined;

  const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const taxonomyKey = String(taxonomy.taxonomy_key ?? "");
  const domains = (state.domain_profile?.domains ?? []).map((d) => d.key);

  // Find the first matching domain follow-up
  const allKeys = [taxonomyKey, ...domains];
  for (const key of allKeys) {
    for (const [prefix, prompt] of Object.entries(DOMAIN_FOLLOWUPS)) {
      if (key.startsWith(prefix)) return prompt;
    }
  }
  return GENERIC_FOLLOWUP;
}

export async function finalScrubberNode(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("final_scrubber");
  const original = (state.generated_code ?? "").trim();
  if (isJsonOutputRequested(state)) {
    collector.endSpan("final_scrubber", {
      outcome: "json_passthrough",
      metadata: {
        original_length: original.length,
        scrubbed_length: original.length,
        chars_removed: 0,
        followup_appended: false,
      },
    });
    return ensureForwarded({
      ...state,
      generated_code: original,
      next_node: "respond",
    });
  }
  let scrubbed = scrubInternalScaffolding(original);

  const followup = buildClosingFollowup(state);
  if (followup) {
    scrubbed = `${scrubbed}\n\n---\n\n${followup}`;
  }

  collector.endSpan("final_scrubber", {
    outcome: scrubbed.length < original.length ? "scrubbed" : followup ? "followup_appended" : "pass_through",
    metadata: {
      original_length: original.length,
      scrubbed_length: scrubbed.length,
      chars_removed: original.length - scrubbed.length,
      followup_appended: Boolean(followup),
    },
  });
  return ensureForwarded({
    ...state,
    generated_code: scrubbed,
    next_node: "respond"
  });
}

export async function respondNode(state: GraphState): Promise<GraphState> {
  const collector = ensureCollector(state);
  collector.startSpan("respond");
  collector.endSpan("respond", {
    outcome: "ok",
    metadata: {
      response_length: (state.generated_code ?? "").length,
      iteration_count: state.iteration_count,
    },
  });
  return ensureForwarded({
    ...state,
    next_node: "respond"
  });
}

export { SpanCollector } from "./tracing/span-collector.js";

/**
 * Direct-stream fast path: classify, then stream from LLM immediately.
 *
 * Used for trivial/easy tasks where the full graph (planner -> plan_gate ->
 * router -> critic) would add latency without improving quality. Matches
 * Python's direct_stream_request behavior.
 *
 * Returns the final state if fast-pathed (next_node === "respond"), or
 * the input state unchanged if conditions aren't met (caller should run
 * the full graph).
 */
export async function directStreamPipeline(
  input: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<GraphState> {
  if (!isLlmAvailable()) return input;

  let state: GraphState = {
    ...input,
    run_id: input.run_id ?? randomUUID(),
    _span_collector: input._span_collector ?? new SpanCollector(),
  };

  const collector = ensureCollector(state);
  void state._status_reporter?.("classifying", "started");
  collector.startSpan("entry_pipeline");
  state = await classifyEntry({ ...state, _span_collector: collector, iteration_count: 0, max_iterations: 1 });
  void state._status_reporter?.("classifying", "done");
  collector.endSpan("entry_pipeline", {
    outcome: "direct_stream_fast_path",
    metadata: {
      difficulty: state.difficulty,
      task_size: state.task_size,
      writer_max_tokens: state.writer_max_tokens,
      critic_max_tokens: state.critic_max_tokens,
      task_is_trivial: state.task_is_trivial,
      model_tier: state.model_tier,
    },
  });

  if (
    state.plan_required === true ||
    state.force_live_web ||
    (!state.task_is_trivial && state.rag_mode !== "disabled")
  ) {
    return state;
  }

  void state._status_reporter?.("synthesizing", "started");
  collector.startSpan("writer");
  const result = await composeWriterDraftStream(state, onDelta);
  void state._status_reporter?.("synthesizing", "done");
  collector.endSpan("writer", {
    outcome: "direct_stream_complete",
    tokens_used: result.usage?.total_tokens ?? 0,
    metadata: {
      ...budgetSpanMetadata(
        state.writer_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE,
        result.usage,
      ),
    },
  });

  return ensureForwarded({
    ...state,
    generated_code: result.content,
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "respond",
  });
}

export async function runCanonicalPipeline(input: GraphState): Promise<GraphState> {
  let state: GraphState = {
    ...input,
    run_id: input.run_id ?? randomUUID(),
    _span_collector: input._span_collector ?? new SpanCollector(),
  };
  state = await entryPipelineNode(state);
  if (state.next_node === "respond") return ensureForwarded(state);
  while (state.next_node === "planner") {
    state = await plannerNode(state);
    if (state.plan_required !== false) {
      state = ensureForwarded(planGate(state));
    }
    if (state.next_node === "respond") return state;
    if (state.next_node === "router") break;
  }
  if (state.next_node === "router") state = await routerNode(state);
  if (state.next_node === "writer") state = await writerNode(state);
  if (state.next_node === "critic") {
    const background = Boolean((state.execution_policy ?? {}).critic_background);
    if (background) {
      state = await finalScrubberNode(state);
      state = await respondNode(state);
      return ensureForwarded(state);
    }
    state = await criticNode(state);
  }
  if (state.next_node === "respond") {
    return ensureForwarded(state);
  }
  if (state.next_node === "router") {
    state = await routerNode(state);
    state = await writerNode(state);
    state = await criticNode(state);
  }
  if (state.next_node === "writer") {
    state = await writerNode(state);
    state = await criticNode(state);
  }
  if (state.next_node === "respond") {
    return ensureForwarded(state);
  }
  state = await finalScrubberNode(state);
  return { ...state, next_node: "respond" };
}
