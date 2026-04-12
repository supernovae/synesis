import type { PlanStage, TaskIntake } from "./task-intake.js";

export type PlanNodeStatus = "pending" | "in_progress" | "done";

export interface PlanGraphNode {
  stage: PlanStage;
  status: PlanNodeStatus;
  updatedAt: number;
}

export interface PlanGraph {
  sourceHash: string;
  nodes: PlanGraphNode[];
  activeStage: PlanStage;
  updatedAt: number;
}

export interface PlanGraphSignal {
  recentToolNames: string[];
  latestAssistantText?: string;
  verificationFailures?: number;
}

function nowTs(): number {
  return Date.now();
}

export function createPlanGraph(intake: TaskIntake): PlanGraph {
  const ts = nowTs();
  return {
    sourceHash: intake.sourceHash,
    nodes: intake.stages.map((stage, idx) => ({
      stage,
      status: idx === 0 ? "in_progress" : "pending",
      updatedAt: ts,
    })),
    activeStage: intake.stages[0] ?? "discover",
    updatedAt: ts,
  };
}

function setActive(graph: PlanGraph, stage: PlanStage): PlanGraph {
  const ts = nowTs();
  const nextNodes = graph.nodes.map((n) => {
    if (n.stage === stage) {
      const status: PlanNodeStatus = n.status === "done" ? "done" : "in_progress";
      return { ...n, status, updatedAt: ts };
    }
    return n;
  });
  return { ...graph, nodes: nextNodes, activeStage: stage, updatedAt: ts };
}

function markDone(graph: PlanGraph, stage: PlanStage): PlanGraph {
  const ts = nowTs();
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.stage === stage ? { ...n, status: "done", updatedAt: ts } : n)),
    updatedAt: ts,
  };
}

export function advancePlanGraph(graph: PlanGraph, signal: PlanGraphSignal): PlanGraph {
  const lowerTools = signal.recentToolNames.map((v) => v.toLowerCase());
  const hasEdit = lowerTools.some((t) => t.includes("patch") || t.includes("write") || t.includes("replace"));
  const hasVerify = lowerTools.some((t) => t.includes("run_test") || t.includes("run_build") || t.includes("run_lint"));
  const hasDiscover = lowerTools.some((t) => t.includes("search") || t.includes("read") || t.includes("inspect"));
  const hasTaskDone = lowerTools.some((t) => t.includes("taskupdate") || t.includes("todowrite"));
  const assistantText = (signal.latestAssistantText ?? "").toLowerCase();
  const looksFinal = /\b(done|completed|final|implemented)\b/.test(assistantText);

  let next = graph;
  if (hasDiscover && graph.activeStage === "discover") {
    next = markDone(next, "discover");
    next = setActive(next, "implement");
  }
  if (hasEdit && (next.activeStage === "discover" || next.activeStage === "implement")) {
    next = markDone(next, "discover");
    next = setActive(next, "implement");
  }
  if (hasVerify && next.activeStage !== "finalize") {
    next = markDone(next, "implement");
    next = setActive(next, "verify");
  }
  if ((signal.verificationFailures ?? 0) === 0 && looksFinal && next.activeStage === "verify") {
    next = markDone(next, "verify");
    next = setActive(next, "finalize");
  }
  if (next.activeStage === "finalize" && looksFinal && hasTaskDone) {
    next = markDone(next, "finalize");
  }
  return next;
}

export function isPlanComplete(graph: PlanGraph): boolean {
  return graph.nodes.every((n) => n.status === "done");
}

export function formatPlanGraphBlock(graph: PlanGraph): string {
  const lines = [
    `<synesis_plan_graph active_stage="${graph.activeStage}">`,
    ...graph.nodes.map((n) => `- ${n.stage}:${n.status}`),
    "</synesis_plan_graph>",
  ];
  return lines.join("\n");
}

export function formatPlanProgressBlock(graph: PlanGraph): string {
  const done = graph.nodes.filter((n) => n.status === "done").length;
  const total = graph.nodes.length;
  return [
    `<synesis_plan_progress done="${done}" total="${total}" active="${graph.activeStage}" complete="${isPlanComplete(graph)}">`,
    ...graph.nodes.map((n) => `  ${n.stage}: ${n.status}`),
    "</synesis_plan_progress>",
  ].join("\n");
}

export function serializePlanGraph(graph: PlanGraph): Record<string, unknown> {
  return {
    sourceHash: graph.sourceHash,
    activeStage: graph.activeStage,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes.map((n) => ({
      stage: n.stage,
      status: n.status,
      updatedAt: n.updatedAt,
    })),
  };
}

export function deserializePlanGraph(data: Record<string, unknown>): PlanGraph | null {
  if (!data || typeof data !== "object") return null;
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  if (nodes.length === 0) return null;
  return {
    sourceHash: typeof data.sourceHash === "string" ? data.sourceHash : "",
    activeStage: (typeof data.activeStage === "string" ? data.activeStage : "discover") as PlanStage,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
    nodes: nodes.map((n: Record<string, unknown>) => ({
      stage: (typeof n.stage === "string" ? n.stage : "discover") as PlanStage,
      status: (typeof n.status === "string" ? n.status : "pending") as PlanNodeStatus,
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now(),
    })),
  };
}
