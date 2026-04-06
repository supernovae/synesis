import type { z } from "zod";
import type {
  DecisionRecordSchema,
  ExecutionPlanSchema,
  FinalReviewSchema,
  WorkerResultSchema,
  WorkerTaskPacketSchema,
} from "./schemas.js";

export type CynefinDomain = "clear" | "complicated" | "complex" | "chaotic";
export type IntakeAction = "answer_directly" | "ask_for_clarification" | "plan_and_execute" | "offer_paths";
export type RiskLevel = "low" | "medium" | "high";
export type Role = "planner" | "worker" | "reviewer";
export type EditStrategy = "line_edits" | "patch_hunks" | "symbol_targeted" | "full_file";

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type WorkerTaskPacket = z.infer<typeof WorkerTaskPacketSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export type FinalReview = z.infer<typeof FinalReviewSchema>;

export interface SupervisorRequest {
  traceId: string;
  objective: string;
  projectRoot: string;
  availableFiles?: string[];
  initialContextSummary?: string;
  userInstructions?: string[];
  allowFullFileOverride?: boolean;
}

export interface SupervisorResponse {
  accepted: boolean;
  action: IntakeAction;
  domain: CynefinDomain;
  traceId: string;
  artifactIds: string[];
  finalReview?: FinalReview;
  decisionRecord?: DecisionRecord;
  userQuestions?: string[];
  responseSummary: string;
}

export interface RepoOperationRequest {
  op: string;
  args: Record<string, unknown>;
}

export interface RepoOperationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface RepoOpsAdapter {
  call(request: RepoOperationRequest): Promise<RepoOperationResult>;
}

export interface PlannerModule {
  classifyAndPlan(input: {
    objective: string;
    availableFiles: string[];
    contextSummary: string;
  }): Promise<{
    domain: CynefinDomain;
    action: IntakeAction;
    plan?: ExecutionPlan;
    openQuestions: string[];
  }>;
}

export interface WorkerModule {
  execute(task: WorkerTaskPacket): Promise<WorkerResult>;
}

export interface ReviewerModule {
  review(input: {
    plan: ExecutionPlan;
    workerResults: WorkerResult[];
    allowFullFileOverride: boolean;
    repairRound: number;
  }): Promise<FinalReview>;
}

export interface PolicyEngine {
  validateWorkerTask(task: WorkerTaskPacket): { ok: boolean; reasons: string[] };
  validateWorkerResult(result: WorkerResult, allowFullFileOverride: boolean): { ok: boolean; reasons: string[] };
  detectOverlappingChanges(results: WorkerResult[]): { hasOverlap: boolean; conflicts: string[] };
}

export interface ArtifactEnvelope<T = unknown> {
  artifactId: string;
  traceId: string;
  kind:
    | "execution_plan"
    | "worker_task"
    | "worker_result"
    | "decision_record"
    | "final_review"
    | "context_summary"
    | "instruction_set";
  payload: T;
  createdAtIso: string;
}

export interface ArtifactStore {
  put<T>(artifact: Omit<ArtifactEnvelope<T>, "artifactId" | "createdAtIso">): Promise<ArtifactEnvelope<T>>;
  get<T>(artifactId: string): Promise<ArtifactEnvelope<T> | null>;
  listByTrace(traceId: string): Promise<ArtifactEnvelope[]>;
}

export interface TraceEvent {
  traceId: string;
  eventId: string;
  stage: "intake" | "planning" | "execution" | "review" | "finalize";
  message: string;
  artifactIds: string[];
  data?: Record<string, unknown>;
  createdAtIso: string;
}

export interface TraceLogger {
  log(event: Omit<TraceEvent, "eventId" | "createdAtIso">): Promise<TraceEvent>;
  list(traceId: string): Promise<TraceEvent[]>;
}

export interface ProjectInstructionSet {
  normalized: string;
  sections: Array<{ source: string; content: string }>;
}

export interface ExecutionContextSummary {
  summary: string;
  assumptions: string[];
  unresolvedQuestions: string[];
  artifactRefs: string[];
}

export interface OrchestrationRuntime {
  run(request: SupervisorRequest): Promise<SupervisorResponse>;
}
