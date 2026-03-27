import type { CritiqueItem, DecisionEntry, EvidencePacket } from "../contracts/schemas.js";

export type GraphNodeName =
  | "entry_pipeline"
  | "planner"
  | "plan_gate"
  | "router"
  | "writer"
  | "critic"
  | "final_scrubber"
  | "respond";

export interface GraphState {
  messages?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  user_id?: string;
  org_id?: string;
  tenant_ids?: string[];
  token_scopes?: string[];
  auth_method?: "anonymous" | "bearer" | "pat" | "internal_service";
  authz_trace_id?: string;
  authz_engine?: string;
  authz_rules?: string[];
  requested_model?: string;
  response_model?: string;
  model_tier?: "auto" | "pulse" | "core" | "horizon";
  task_description?: string;
  task_frame?: Record<string, unknown>;
  execution_plan?: Record<string, unknown>;
  evidence_packets?: EvidencePacket[];
  evidence_requests?: Array<Record<string, unknown>>;
  decision_ledger?: DecisionEntry[];
  critique_register?: Record<string, CritiqueItem>;
  draft_fingerprints?: string[];
  rag_source_urls?: string[];
  rag_document_names?: string[];
  repair_instructions?: Array<Record<string, unknown>>;
  style_contract_locked?: Record<string, unknown>;
  plan_gate_passed?: boolean;
  plan_gate_errors?: string[];
  plan_gate_feedback?: string;
  critic_approved?: boolean;
  need_more_evidence?: boolean;
  critic_should_continue?: boolean;
  critic_continue_reason?: string | null;
  critic_feedback?: string;
  critic_raw_json?: string;
  critic_scores?: Record<string, number>;
  blocking_issues?: Array<Record<string, unknown>>;
  critic_nonblocking?: Array<Record<string, unknown>>;
  execution_policy?: Record<string, unknown>;
  writer_max_tokens?: number;
  critic_max_tokens?: number;
  generated_code?: string;
  code_explanation?: string;
  patch_ops?: unknown[];
  next_node?: GraphNodeName;
  iteration_count?: number;
  max_iterations?: number;
  planner_error_count?: number;
  override_log?: Array<Record<string, unknown>>;
  node_traces?: Array<{ node_name?: string } | Record<string, unknown>>;
  _validation_warnings?: string[];
  error?: string;
  run_id?: string;
}
