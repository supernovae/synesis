/**
 * Synesis Prefix Optimizer — Core Types
 *
 * Provider-agnostic prompt prefix optimizer that restructures IDE traffic
 * into a stable-prefix-first layout for maximum KV-cache reuse at any
 * OpenAI-compatible endpoint. Optionally places explicit cache markers
 * for providers that support them (DashScope, Anthropic).
 */

export type ContentStability = "stable" | "semi_stable" | "volatile";

export type SegmentCategory =
  | "core_instructions"
  | "project_guidance"
  | "tool_definitions"
  | "task_frame"
  | "conversation_history"
  | "live_context"
  | "latest_user_turn"
  | "tool_results";

/**
 * Which provider-specific explicit cache marker backend to use.
 * "none" still restructures messages for implicit KV-cache benefit.
 */
export type MarkerBackend = "dashscope" | "anthropic" | "none";

export interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: string;
  function: ToolFunction;
  [key: string]: unknown;
}

export interface ParsedSegment {
  category: SegmentCategory;
  stability: ContentStability;
  content: string;
  hash: string;
  /** Original message indices this segment was extracted from. */
  sourceIndices: number[];
  tokenEstimate: number;
}

export interface OptimizedRequest {
  messages: ChatMessage[];
  /** Message indices where explicit cache markers should be placed (empty for non-explicit providers). */
  markerIndices: number[];
  diagnostics: PrefixDiagnostics;
}

export interface PrefixDiagnostics {
  coreHash: string;
  projectHash: string;
  toolsetHash: string;
  frameHash: string;
  volatileHash: string;
  userTurnHash: string;
  markerBackend: MarkerBackend;
  markerCount: number;
  markerIndices: number[];
  segmentSizes: Partial<Record<SegmentCategory, number>>;
  cacheMissReason: string | null;
  totalTokenEstimate: number;
}
