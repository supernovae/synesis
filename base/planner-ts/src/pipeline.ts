import { randomUUID } from "node:crypto";
import { routeAfterCritic } from "./nodes/critic-routing.js";
import { classifyEntry } from "./nodes/entry-classifier.js";
import {
  annotateViolations,
  fingerprintDraft,
  validateCitationPreservation,
  validateDecisionDrift,
  validateStyleCompliance
} from "./nodes/contract-validator.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { planGate } from "./nodes/plan-gate.js";
import { runRouter } from "./nodes/router.js";
import { validatedNode } from "./nodes/validated-node.js";
import { composeWriterDraft, composeWriterDraftStream } from "./nodes/writer-compose.js";
import { runLlmPlanner, isClarificationWaiver } from "./nodes/llm-planner.js";
import { isLlmAvailable } from "./llm/client.js";
import type { StreamDelta } from "./llm/client.js";
import { mergeUsage } from "@synesis/telemetry";
import type { DecisionEntry } from "./contracts/schemas.js";
import type { GraphState } from "./state/types.js";

function ensureForwarded(state: GraphState): GraphState {
  return {
    ...state,
    evidence_packets: state.evidence_packets ?? [],
    generated_code: state.generated_code ?? "",
    code_explanation: state.code_explanation ?? "",
    patch_ops: state.patch_ops ?? []
  };
}

function withNodeTrace(state: GraphState, nodeName: string): GraphState {
  const traces = state.node_traces ?? [];
  return {
    ...state,
    node_traces: [...traces, { node_name: nodeName, authz_trace_id: state.authz_trace_id ?? "" }]
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

export async function entryPipelineNode(state: GraphState): Promise<GraphState> {
  return ensureForwarded(withNodeTrace(classifyEntry({
    ...state,
    iteration_count: state.iteration_count ?? 0,
    max_iterations: state.max_iterations ?? 4
  }), "entry_pipeline"));
}

export async function plannerNode(state: GraphState): Promise<GraphState> {
  if (state.plan_required === false) {
    return ensureForwarded(withNodeTrace({
      ...state,
      execution_plan: {
        steps: [{ id: 1, action: `Directly answer: ${state.task_description ?? "User request"}`, files: [], dependencies: [] }],
        open_questions: [],
        assumptions: []
      },
      planner_confidence: 0.9,
      plan_gate_passed: true,
      next_node: "router"
    }, "planner"));
  }

  if (state.user_answer_to_clarification && isClarificationWaiver(state.user_answer_to_clarification)) {
    return ensureForwarded(withNodeTrace({
      ...state,
      clarification_question: undefined,
      clarification_options: undefined,
      plan_gate_passed: true,
      next_node: "router"
    }, "planner"));
  }

  if (isLlmAvailable()) {
    return llmDrivenPlanner(state);
  }
  return deterministicPlanner(state);
}

async function llmDrivenPlanner(state: GraphState): Promise<GraphState> {
  const task = state.task_description ?? "User request";
  let plannerResult: Awaited<ReturnType<typeof runLlmPlanner>>;
  try {
    plannerResult = await runLlmPlanner(state);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 40, msg: "llmDrivenPlanner failed, falling back to deterministic", error: detail, time: Date.now() }) + "\n");
    return deterministicPlanner(state);
  }
  const { result, clarification } = plannerResult;

  if (clarification) {
    const planned = ensureForwarded(withNodeTrace({
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
    }, "planner"));
    return appendDecisionLedger(planned, {
      category: "approach",
      chosen: "clarify_before_acting",
      rejected_alternatives: ["proceed_with_assumptions"],
      rationale: `Planner triggered clarification (confidence=${result.plan.confidence}, open_questions=${result.plan.open_questions.length}, frame=${state.domain_profile?.frameCoherence ?? "unknown"})`,
      decided_by: "planner",
      frozen: false,
    });
  }

  const feedback = state.plan_gate_feedback ? `\nFeedback: ${state.plan_gate_feedback}` : "";
  const planned = ensureForwarded(withNodeTrace({
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
  }, "planner"));
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
  const planned = ensureForwarded(withNodeTrace({
    ...state,
    execution_plan: {
      steps: [{ id: 1, action: stepAction, files: [], dependencies: [] }],
      open_questions: [],
      assumptions: []
    },
    planner_confidence: 0.7,
    next_node: "plan_gate",
    plan_gate_feedback: `Plan drafted for: ${task}${feedback}`
  }, "planner"));
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
  if (state.rag_mode === "disabled") {
    return appendDecisionLedger(
      ensureForwarded(
        withNodeTrace(
          {
            ...state,
            evidence_packets: state.evidence_packets ?? [],
            need_more_evidence: false,
            next_node: "writer"
          },
          "router"
        )
      ),
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
  const routed = await runRouter(state);
  const traced = ensureForwarded(withNodeTrace(routed, "router"));
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
  const result = await composeWriterDraft(state);
  const fingerprint = fingerprintDraft(result.content);
  return ensureForwarded(withNodeTrace({
    ...state,
    generated_code: result.content,
    draft_fingerprints: [...(state.draft_fingerprints ?? []), fingerprint],
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "critic"
  }, "writer"));
}

async function writerNodeStreamingCore(
  state: GraphState,
  onDelta: (delta: StreamDelta) => void,
): Promise<GraphState> {
  const result = await composeWriterDraftStream(state, onDelta);
  const fingerprint = fingerprintDraft(result.content);
  return ensureForwarded(withNodeTrace({
    ...state,
    generated_code: result.content,
    draft_fingerprints: [...(state.draft_fingerprints ?? []), fingerprint],
    llm_usage: mergeUsage(state.llm_usage, result.usage),
    next_node: "critic"
  }, "writer"));
}

async function criticNodeCore(state: GraphState): Promise<GraphState> {
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
  const critiqued = ensureForwarded(withNodeTrace({
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
  }, "critic"));
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
  [validateStyleCompliance],
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
  if (styleCheck.violations.length > 0) {
    return {
      ...result,
      _validation_warnings: [...(result._validation_warnings ?? []), ...styleCheck.violations],
    };
  }
  return result;
}

export const criticNode = validatedNode(
  criticNodeCore,
  [validateStyleCompliance, validateDecisionDrift, validateCitationPreservation],
  [validateStyleCompliance, validateDecisionDrift, validateCitationPreservation],
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

export async function finalScrubberNode(state: GraphState): Promise<GraphState> {
  return ensureForwarded(withNodeTrace({
    ...state,
    generated_code: scrubInternalScaffolding((state.generated_code ?? "").trim()),
    next_node: "respond"
  }, "final_scrubber"));
}

export async function respondNode(state: GraphState): Promise<GraphState> {
  return ensureForwarded(withNodeTrace({
    ...state,
    next_node: "respond"
  }, "respond"));
}

export async function runCanonicalPipeline(input: GraphState): Promise<GraphState> {
  let state: GraphState = { ...input, run_id: input.run_id ?? randomUUID() };
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
