import type { CritiqueItem, DecisionEntry, EvidencePacket } from "../contracts/schemas.js";
import type { CohesionLockData } from "../retrieval/types.js";
import type { SpanCollector } from "../tracing/span-collector.js";

export type GraphNodeName =
  | "entry_pipeline"
  | "planner"
  | "plan_gate"
  | "router"
  | "writer"
  | "critic"
  | "final_scrubber"
  | "respond";

export type CynefinDomain = "clear" | "complicated" | "complex" | "chaotic";

export interface GraphState {
  messages?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  user_id?: string;
  org_id?: string;
  tenant_ids?: string[];
  token_scopes?: string[];
  auth_method?: "anonymous" | "bearer" | "pat" | "internal_service";
  conversation_id?: string;
  authz_trace_id?: string;
  authz_engine?: string;
  authz_rules?: string[];
  requested_model?: string;
  response_model?: string;
  model_tier?: "auto" | "pulse" | "core" | "horizon";
  task_size?: "easy" | "medium" | "hard";
  difficulty?: number;
  risk_score?: number;
  plan_required?: boolean;
  task_is_trivial?: boolean;
  /** When true, unified retrieval should prefer web (SearXNG) and not drop it to zero on L-RAG gating. */
  force_live_web?: boolean;
  rag_mode?: "disabled" | "light" | "normal";
  requested_effort_mode?: "auto" | "pulse" | "core" | "horizon";
  recommended_effort_mode?: "pulse" | "core" | "horizon";
  selected_effort_mode?: "pulse" | "core" | "horizon";
  taxonomy_metadata?: Record<string, unknown>;
  task_description?: string;
  task_frame?: Record<string, unknown>;
  execution_plan?: Record<string, unknown>;
  evidence_packets?: EvidencePacket[];
  evidence_requests?: Array<Record<string, unknown>>;
  decision_ledger?: DecisionEntry[];
  critique_register?: Record<string, CritiqueItem>;
  draft_fingerprints?: string[];
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
  /** Policy/scaled writer output budget (tier-clamped); used for utilization_vs_target telemetry. */
  writer_budget_target?: number;
  /** Effective `max_tokens` passed to the writer LLM. */
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
  _validation_warnings?: string[];
  llm_usage?: import("@synesis/telemetry").LlmUsage;
  pricing_rates_by_role?: {
    router: import("@synesis/telemetry").PricingRates;
    general: import("@synesis/telemetry").PricingRates;
    critic: import("@synesis/telemetry").PricingRates;
  };
  error?: string;
  run_id?: string;
  traceparent?: string;
  requested_response_format?: Record<string, unknown>;
  stream_include_usage?: boolean;

  cynefin_domain?: CynefinDomain;
  domain_profile?: {
    domains: Array<{ key: string; weight: number }>;
    frameCoherence: "focused" | "composite" | "diffuse";
  };
  clarification_question?: string;
  clarification_options?: string[];
  user_answer_to_clarification?: string;
  assumptions?: string[];
  show_assumptions?: boolean;
  planner_confidence?: number;
  cohesion_lock?: CohesionLockData;
  injection_detected?: boolean;
  injection_scan_result?: { detected: boolean; patterns_found: string[]; source: string };
  _span_collector?: SpanCollector;
}
