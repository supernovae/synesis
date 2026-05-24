import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { ExecutionGovernorDecision } from "../governance/execution-governor.js";

export type PipelineMode = "raw" | "compat" | "optimized" | "governed" | "workflow";

export interface CanonicalChatRequest {
  protocol: "openai" | "claude";
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown[];
  metadata?: Record<string, unknown> | null;
  raw: OpenAIChatCompletionRequest | Record<string, unknown>;
}

export interface PipelineContext {
  requestId: string;
  mode: PipelineMode;
  userId: string;
  orgId: string;
  clientKind: string;
  conversationId: string;
  sessionKey?: string;
  startedAt: number;
  headers?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

export interface RequestMutation {
  kind: "message_injection" | "tool_filter" | "tool_choice" | "metadata" | "other";
  reason: string;
  payload?: unknown;
}

export interface GovernorDecision {
  action: "pass" | "mutate" | "pause";
  reason: string;
  matchedRules: string[];
  mutations: RequestMutation[];
  execution?: ExecutionGovernorDecision;
  telemetry?: Record<string, unknown>;
}

export interface PipelineStage<TInput = unknown, TOutput = unknown> {
  name: string;
  run(ctx: PipelineContext, input: TInput): Promise<TOutput> | TOutput;
}

export interface PipelineStageTelemetry {
  startStage(stage: string): () => void;
  recordStageDuration?(stage: string, durationMs: number): void;
}

export interface PipelineResult {
  kind: "json" | "stream" | "soft_fail";
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown;
  stream?: unknown;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    costUsd?: number;
  };
  governor?: GovernorDecision | null;
}
