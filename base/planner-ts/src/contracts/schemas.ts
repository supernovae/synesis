import { z } from "zod";
import { AttributionV1 } from "@synesis/context-trust";

export const EvidenceSourceMetadataSchema = z.object({
  authority: z.string().max(64).optional(),
  origin_type: z.string().max(64).optional(),
  heading_path: z.string().max(1024).optional(),
  document_name: z.string().max(512).optional(),
  source_id: z.string().max(256).optional(),
  scan_status: z.enum(["clean", "flagged", "unscanned"]).optional(),
  review_status: z.enum(["unreviewed", "vetted", "rejected"]).optional(),
  content_hash: z.string().max(256).optional(),
}).strict();

export const EvidenceSourceSchema = z.object({
  uri: z.string().min(1),
  type: z.enum(["doc", "code", "wiki", "web", "repo", "api"]),
  metadata: EvidenceSourceMetadataSchema.default({}),
  attribution: AttributionV1.optional(),
});

export const EvidenceSnippetSchema = z.object({
  text: z.string().min(1),
  relevance: z.number().min(0).max(1),
  source_uri: z.string().min(1)
});

export const EvidencePacketSchema = z.object({
  query: z.string().default(""),
  sources: z.array(EvidenceSourceSchema).default([]),
  snippets: z.array(EvidenceSnippetSchema).default([]),
  summary: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  retrieval_notes: z.string().default(""),
  section_id: z.number().int().nullable().optional()
});

export const DecisionEntrySchema = z.object({
  decision_id: z.string().min(1),
  category: z.enum(["architecture", "tooling", "style", "scope", "approach"]),
  chosen: z.string().default(""),
  rejected_alternatives: z.array(z.string()).default([]),
  rationale: z.string().default(""),
  decided_by: z.string().default("planner"),
  frozen: z.boolean().default(false)
});

export const CritiqueItemSchema = z.object({
  item_id: z.string().min(1),
  category: z.string().default("general"),
  description: z.string().default(""),
  status: z.enum(["open", "resolved", "settled"]).default("open"),
  evidence_ref: z.string().optional(),
  resolved_by: z.string().optional(),
  reopen_count: z.number().int().min(0).default(0)
});

export const RepairInstructionSchema = z.object({
  priority: z.number().int().min(0).default(0),
  target: z.string().default(""),
  action: z.string().default(""),
  reason: z.string().default("")
});

export const PlanStepSchema = z.object({
  id: z.number().int().default(0),
  action: z.string().default(""),
  dependencies: z.array(z.number().int()).default([]),
  files: z.array(z.string()).default([]),
  verification_command: z.string().default(""),
  deliverable_ids: z.array(z.number().int()).default([])
});

export const PlanBodySchema = z.object({
  steps: z.array(PlanStepSchema).default([]),
  open_questions: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([])
});

export const PlannerOutSchema = z.object({
  plan: PlanBodySchema.default({ steps: [], open_questions: [], assumptions: [] }),
  open_questions: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
  touched_files: z.array(z.string()).default([])
});

export const CriticScoresSchema = z.object({
  grounding: z.number().min(0).max(10).default(0),
  correctness: z.number().min(0).max(10).default(0),
  actionability: z.number().min(0).max(10).default(0),
  clarity: z.number().min(0).max(10).default(0),
  evidence_utilization: z.number().min(0).max(10).default(0),
  weighted_overall: z.number().min(0).max(10).default(0)
});

export const CriticOutSchema = z.object({
  approved: z.boolean().default(false),
  need_more_evidence: z.boolean().default(false),
  continue_reason: z.string().optional(),
  blocking_issues: z.array(CritiqueItemSchema).default([]),
  nonblocking: z.array(CritiqueItemSchema).default([]),
  repair_instructions: z.array(RepairInstructionSchema).default([]),
  scores: CriticScoresSchema.default({
    grounding: 0,
    correctness: 0,
    actionability: 0,
    clarity: 0,
    evidence_utilization: 0,
    weighted_overall: 0
  })
});

export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
export type CritiqueItem = z.infer<typeof CritiqueItemSchema>;
export type PlannerOut = z.infer<typeof PlannerOutSchema>;
export type CriticOut = z.infer<typeof CriticOutSchema>;
