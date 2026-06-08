import { z } from "zod";
import { ORCHESTRATION_LIMITS } from "./constants.js";

export const CynefinDomainSchema = z.enum(["clear", "complicated", "complex", "chaotic"]);
export const IntakeActionSchema = z.enum([
  "answer_directly",
  "ask_for_clarification",
  "plan_and_execute",
  "offer_paths",
]);
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export const RoleSchema = z.enum(["planner", "worker", "reviewer"]);
export const EditStrategySchema = z.enum(["line_edits", "patch_hunks", "symbol_targeted", "full_file"]);

export const ProposedChangeSchema = z.object({
  kind: z.enum(["line_edit", "patch_hunk", "symbol_targeted", "full_file"]),
  filePath: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  summary: z.string().min(1),
  patch: z.string().optional(),
  symbol: z.string().optional(),
}).strict();

export const ExecutionSliceSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  allowedFiles: z.array(z.string().min(1)).default([]),
  forbiddenFiles: z.array(z.string().min(1)).default([]),
  requiredValidation: z.array(z.string().min(1)).default([]),
  requiredEvidence: z.array(z.string().min(1)).default([]),
  tokenBudget: z.number().int().min(1).optional(),
  stepBudget: z.number().int().min(1).optional(),
  locBudget: z.number().int().min(1).optional(),
}).strict();

export const ExecutionPlanSchema = z.object({
  objective: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  riskLevel: RiskLevelSchema,
  domain: CynefinDomainSchema,
  executionSlices: z.array(ExecutionSliceSchema).min(1).max(ORCHESTRATION_LIMITS.maxParallelWorkers),
  validationPlan: z.array(z.string()).default([]),
  rollbackPlan: z.array(z.string()).default([]),
  stopConditions: z.array(z.string()).default([]),
}).strict();

export const WorkerTaskPacketSchema = z.object({
  taskId: z.string().min(1),
  role: RoleSchema,
  objective: z.string().min(1),
  allowedFiles: z.array(z.string().min(1)).default([]),
  forbiddenFiles: z.array(z.string().min(1)).default([]),
  allowedTools: z.array(z.string().min(1)).default([]),
  tokenBudget: z.number().int().min(1),
  stepBudget: z.number().int().min(1),
  locBudget: z.number().int().min(1),
  editStrategy: EditStrategySchema,
  requiredValidation: z.array(z.string()).default([]),
  requiredEvidence: z.array(z.string()).default([]),
}).strict();

export const WorkerResultSchema = z.object({
  summary: z.string().min(1),
  proposedChanges: z.array(ProposedChangeSchema).default([]),
  touchedFiles: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string()).default([]),
  unresolvedIssues: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  needsHumanInput: z.boolean().default(false),
  tokensUsed: z.number().int().min(0).optional(),
  stepsUsed: z.number().int().min(0).optional(),
}).strict();

export const DecisionOptionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
}).strict();

const DecisionOptionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const DecisionEvidenceSchema = z.string().min(1).max(512);
const DecisionRiskSchema = z.string().min(1).max(256);

export const DecisionRecordSchema = z.object({
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(2),
  evidencePerOption: z.record(DecisionOptionIdSchema, z.array(DecisionEvidenceSchema).max(16)),
  riskPerOption: z.record(DecisionOptionIdSchema, DecisionRiskSchema),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  requiresUserChoice: z.boolean().default(false),
}).strict();

export const ConflictSchema = z.object({
  type: z.enum(["overlap", "policy", "validation"]),
  message: z.string().min(1),
  files: z.array(z.string()).default([]),
}).strict();

export const FinalReviewSchema = z.object({
  accepted: z.boolean(),
  reviewSummary: z.string(),
  mergedPatchPlan: z.array(z.string()).default([]),
  conflicts: z.array(ConflictSchema).default([]),
  followUps: z.array(z.string()).default([]),
  userQuestions: z.array(z.string()).default([]),
  prSummaryDraft: z.string().default(""),
}).strict();

export const ExecutionContextSummarySchema = z.object({
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
  artifactRefs: z.array(z.string().min(1)).default([]),
}).strict();

export const ProjectInstructionSetSchema = z.object({
  normalized: z.string(),
  sections: z.array(z.object({
    source: z.enum(["AGENTS.md", "CLAUDE.md", "internal"]),
    content: z.string().min(1),
  }).strict()).default([]),
}).strict();

export const TraceEventDataSchema = z.union([
  z.object({ objective: z.string().min(1) }).strict(),
  z.object({ domain: CynefinDomainSchema, risk: RiskLevelSchema }).strict(),
  z.object({ conflicts: z.number().int().min(0), repairRound: z.number().int().min(0) }).strict(),
]);

export const TraceEventSchema = z.object({
  traceId: z.string().min(1),
  eventId: z.string().min(1),
  stage: z.enum(["intake", "planning", "execution", "review", "finalize"]),
  message: z.string().min(1),
  artifactIds: z.array(z.string().min(1)).default([]),
  data: TraceEventDataSchema.optional(),
  createdAtIso: z.string().min(1),
}).strict();

const ArtifactEnvelopeBaseSchema = z.object({
  artifactId: z.string().min(1),
  traceId: z.string().min(1),
  createdAtIso: z.string().min(1),
});

export const ArtifactEnvelopeSchema = z.discriminatedUnion("kind", [
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("execution_plan"),
    payload: ExecutionPlanSchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("worker_task"),
    payload: WorkerTaskPacketSchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("worker_result"),
    payload: WorkerResultSchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("decision_record"),
    payload: DecisionRecordSchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("final_review"),
    payload: FinalReviewSchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("context_summary"),
    payload: ExecutionContextSummarySchema,
  }).strict(),
  ArtifactEnvelopeBaseSchema.extend({
    kind: z.literal("instruction_set"),
    payload: ProjectInstructionSetSchema,
  }).strict(),
]);
