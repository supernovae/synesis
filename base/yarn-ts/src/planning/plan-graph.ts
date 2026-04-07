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
  return next;
}

export function formatPlanGraphBlock(graph: PlanGraph): string {
  const lines = [
    `<synesis_plan_graph active_stage="${graph.activeStage}">`,
    ...graph.nodes.map((n) => `- ${n.stage}:${n.status}`),
    "</synesis_plan_graph>",
  ];
  return lines.join("\n");
}
