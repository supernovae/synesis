import type { GraphState } from "../state/types.js";

const URL_RE = /https?:\/\/\S+/i;
const DOC_REF_RE = /\b(?:according to|as described in|per|see|ref(?:erence)?:?)\s+["']?[A-Z]/i;
const EVIDENCE_CITE_RE = /\[(?:source|ref|doc|evidence)\s*\d/i;
const STRUCTURED_FORMATS = new Set(["json", "yaml", "yml", "xml", "csv", "toml"]);

function checkPlanNonEmpty(steps: Array<Record<string, unknown>>): string[] {
  return steps.length === 0 ? ["plan_empty: planner produced zero steps"] : [];
}

function checkStepQuality(steps: Array<Record<string, unknown>>): string[] {
  const errors: string[] = [];
  for (const step of steps) {
    const action = String(step.action ?? "").trim();
    if (action.length < 10) {
      errors.push(`step_trivial: step ${String(step.id ?? "?")} action is too short (${action.length} chars)`);
    }
  }
  return errors;
}

function checkDeliverableCoverage(steps: Array<Record<string, unknown>>, deliverables: string[]): string[] {
  if (deliverables.length === 0) return [];
  const actionsText = steps.map((s) => String(s.action ?? "").toLowerCase()).join(" ");
  const uncovered = deliverables.filter((d) => {
    const words = d
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length === 0) return false;
    const hits = words.filter((w) => actionsText.includes(w)).length;
    return hits / words.length < 0.5;
  });
  if (uncovered.length > 0) {
    return [`deliverable_uncovered: ${uncovered.length} deliverable(s) not addressed in plan actions: ${uncovered.slice(0, 5).join(", ")}`];
  }
  return [];
}

function checkFormatAlignment(steps: Array<Record<string, unknown>>, requestedFormat: string): string[] {
  if (!STRUCTURED_FORMATS.has(requestedFormat.toLowerCase())) return [];
  const actionsText = steps.map((s) => String(s.action ?? "").toLowerCase()).join(" ");
  if (
    actionsText.includes(requestedFormat.toLowerCase()) ||
    actionsText.includes("output") ||
    actionsText.includes("structured")
  ) {
    return [];
  }
  return [
    `format_blind: plan does not reference required output format (${requestedFormat.toUpperCase()})`
  ];
}

function checkSchemaFieldMapping(steps: Array<Record<string, unknown>>, outputSchema: string[]): string[] {
  if (outputSchema.length === 0) return [];
  const actionsText = steps.map((s) => String(s.action ?? "").toLowerCase()).join(" ");
  const missing = outputSchema.filter((field) => !actionsText.includes(field.toLowerCase()));
  return missing.length > outputSchema.length * 0.5
    ? [`schema_gap: ${missing.length}/${outputSchema.length} required schema fields not referenced: ${missing.slice(0, 8).join(", ")}`]
    : [];
}

function checkHallucinationGuard(steps: Array<Record<string, unknown>>, hasEvidence: boolean): string[] {
  if (hasEvidence) return [];
  const errors: string[] = [];
  for (const step of steps) {
    const action = String(step.action ?? "");
    if (URL_RE.test(action)) errors.push(`phantom_url: step ${String(step.id ?? "?")} references URL without evidence`);
    if (DOC_REF_RE.test(action) || EVIDENCE_CITE_RE.test(action)) {
      errors.push(`phantom_citation: step ${String(step.id ?? "?")} cites source without evidence`);
    }
  }
  return errors;
}

function checkConstraintCoverage(steps: Array<Record<string, unknown>>, constraints: string[]): string[] {
  if (constraints.length < 2) return [];
  const actionsText = steps.map((s) => String(s.action ?? "").toLowerCase()).join(" ");
  const unaddressed = constraints.filter((constraint) => {
    const words = constraint
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length === 0) return false;
    const hits = words.filter((w) => actionsText.includes(w)).length;
    return hits / words.length < 0.3;
  });
  return unaddressed.length > constraints.length * 0.6
    ? [`constraints_ignored: ${unaddressed.length}/${constraints.length} constraints have no keyword presence`]
    : [];
}

function gateFeedback(errors: string[]): string {
  if (errors.length === 0) return "";
  return [
    "Your previous plan failed validation:",
    ...errors.map((error) => `  - ${error}`),
    "Revise the plan to address ALL issues above."
  ].join("\n");
}

export function planGate(state: GraphState): GraphState {
  const traces = state.node_traces ?? [];
  if (state.next_node === "respond") return state;

  const plan = state.execution_plan ?? {};
  const rawSteps = Array.isArray((plan as Record<string, unknown>).steps)
    ? ((plan as Record<string, unknown>).steps as Array<Record<string, unknown>>)
    : [];
  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(taskFrame.tasks) ? (taskFrame.tasks as Array<Record<string, unknown>>) : [];
  const deliverables = tasks.map((t) => String(t.description ?? "")).filter(Boolean);
  const requestedFormat = String(taskFrame.requested_format ?? "prose");
  const outputSchema = Array.isArray(taskFrame.output_schema) ? taskFrame.output_schema.map(String) : [];
  const constraints = Array.isArray(taskFrame.global_constraints) ? taskFrame.global_constraints.map(String) : [];
  const hasEvidence = (state.evidence_packets ?? []).length > 0;

  const errors = [
    ...checkPlanNonEmpty(rawSteps),
    ...checkStepQuality(rawSteps),
    ...checkDeliverableCoverage(rawSteps, deliverables),
    ...checkFormatAlignment(rawSteps, requestedFormat),
    ...checkSchemaFieldMapping(rawSteps, outputSchema),
    ...checkHallucinationGuard(rawSteps, hasEvidence),
    ...checkConstraintCoverage(rawSteps, constraints)
  ];

  const passed = errors.length === 0;
  const plannerErrorCount = passed ? state.planner_error_count ?? 0 : (state.planner_error_count ?? 0) + 1;
  const maxRetries = 2;
  const nextNode = passed ? "router" : plannerErrorCount > maxRetries ? "respond" : "planner";

  return {
    ...state,
    node_traces: [...traces, { node_name: "plan_gate", authz_trace_id: state.authz_trace_id ?? "" }],
    plan_gate_passed: passed,
    plan_gate_errors: errors,
    plan_gate_feedback: gateFeedback(errors),
    planner_error_count: plannerErrorCount,
    next_node: nextNode
  };
}
