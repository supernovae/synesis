import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { constantTimeBearerMatch, extractBearerToken } from "@synesis/auth-contracts";
import { Registry } from "prom-client";
import { z } from "zod";
import {
  ZERO_USAGE,
  PricingRegistry,
  createServiceMetrics,
  recordUsageMetrics,
  emitTrace,
  emitPlannerUsageMetering,
  type LlmUsage,
  type TraceRecord,
  type TraceSensemaking,
  type TraceCriticResult,
  type TraceClassification,
} from "@synesis/telemetry";
import { ChatCompletionRequestSchema } from "./api-schemas.js";
import { authorizeChatCompletionsWithPolicy } from "./auth/authorizer.js";
import {
  createAuthorizationPolicyEngine,
  type PolicyDecision
} from "./auth/policy-engine.js";
import { resolveAuthContext } from "./auth/resolver.js";
import type { AuthContext } from "./auth/types.js";
import { initFgaClient } from "./auth/openfga-client.js";
import { resolvePatFromDb } from "./auth/pat-resolver.js";
import { assertCapabilityLock } from "./capability-lock.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./context/session-manager.js";
import { selectConversationContext } from "./context/context-selector.js";
import { createSessionStore } from "./context/session-store.js";
import {
  applyPlannerContextHygiene,
  resolvePlannerArchitectureMediation,
} from "./context/architecture-mediation.js";
import { invokeGraph, streamGraph } from "./graph.js";
import {
  chatCompletionOpenAICompat,
  chatCompletionOpenAICompatStream,
  getLlmResilienceStats,
  setPricingContext,
  type OpenAICompatChatRequest,
} from "./llm/client.js";
import { setRetrievalClient, directStreamPipeline, isRetrievalClientRegistered } from "./pipeline.js";
import { UnifiedRetrievalClient } from "./retrieval/client.js";
import { resolvePacks, retrieveContext, retrieveKnowledgeBundle } from "./retrieval/rag-client.js";
import { searchAndProcess, setWebSearchObserver } from "./retrieval/web-search.js";
import { persistWebSearchLog } from "./retrieval/web-search-log.js";
import { buildMetadataFilter, extractTagMetadata } from "./retrieval/metadata-filter.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { buildDomainProfile } from "./nodes/domain-profile.js";
import { listModelIds, resolveTierSettings } from "./model-tiers.js";
import { hasLlmRoutes, startPublicModelCatalogPolling } from "./public-model-catalog.js";
import { optimizeContext } from "./optimization/context-optimizer.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import {
  endSse,
  initSse,
  isSseWritable,
  writeAssistantRoleDelta,
  writeContentDelta,
  writeReasoningDelta,
  writeFinalChunk,
} from "./streaming/sse.js";
import { describePhase } from "./streaming/phases.js";
import {
  emitStatus,
  emitPhaseDone,
  emitPhaseError,
  emitPhaseStarted,
  openWebUIContextFromConfig,
  type PlannerStatusPhase,
  type PlannerStatusReporter,
} from "./streaming/status-events.js";
import type { GenerationParams, GraphState } from "./state/types.js";
import {
  emitSecurityEvent,
  promptInjectionScoreToPayload,
  scorePromptInjection,
  shouldApplyUserInjectionMitigation,
} from "@synesis/context-trust";
import { scanUserInput, scanModelOutput, redactPatterns } from "./security/scanner.js";
import { FailureStore } from "./diagnostics/failure-store.js";
import { DependencyHealthMonitor } from "./diagnostics/health-monitor.js";
import { getTracer } from "./telemetry/otel.js";
import { PromptRegistry } from "./prompt-registry.js";
import { isLikelyClarificationAnswer } from "./clarification/clarification-answer-heuristic.js";
import type { ScopeFilterOptions, WebSearchAttribution, WebSearchResponse } from "./retrieval/types.js";
import { CapabilityMatrixClient } from "./capability-matrix/client.js";
import { resolveCapabilityMatrix } from "./capability-matrix/resolver.js";
import {
  legacyPlannerConversationSessionKeys,
  resolvePlannerSessionKey,
  withSupportHandleHint,
} from "./routes/route-support.js";

export {
  legacyPlannerConversationSessionKeys,
  resolvePlannerSessionKey,
  resolveSupportHandle,
  withSupportHandleHint,
} from "./routes/route-support.js";

type ErrorWithMeta = Error & {
  statusCode?: number;
  retryAfterSeconds?: number;
  policyDecision?: { matchedRules?: string[] };
};

type RateLimitOptions = { max: number; timeWindow: string | number };

const KnowledgeStringSchema = z.string().trim().max(4096);
const KnowledgeShortStringSchema = z.string().trim().max(512);
const KnowledgeStringArraySchema = z.array(KnowledgeShortStringSchema).max(50);
const KnowledgeNumericSchema = z.union([
  z.number(),
  z.string().trim().regex(/^\d{1,6}$/),
]);

const KnowledgeRouteBodySchema = z.object({
  query: KnowledgeStringSchema.optional(),
  mode: z.enum(["bundle", "cards"]).optional(),
  top_k: KnowledgeNumericSchema.optional(),
  domain: KnowledgeShortStringSchema.optional(),
  content_type: KnowledgeShortStringSchema.optional(),
  language: KnowledgeShortStringSchema.optional(),
  package_name: KnowledgeShortStringSchema.optional(),
  symbol: KnowledgeShortStringSchema.optional(),
  symbol_fqn: KnowledgeShortStringSchema.optional(),
  symbol_name: KnowledgeShortStringSchema.optional(),
  version: KnowledgeShortStringSchema.optional(),
  version_preference: KnowledgeShortStringSchema.optional(),
  pack_version: KnowledgeShortStringSchema.optional(),
  pack_id: KnowledgeShortStringSchema.optional(),
  pack_ids: KnowledgeStringArraySchema.optional(),
  pack_partition: KnowledgeShortStringSchema.optional(),
  topic: KnowledgeShortStringSchema.optional(),
  task: KnowledgeShortStringSchema.optional(),
  artifact_kind: KnowledgeShortStringSchema.optional(),
  routing_mode: z.enum(["auto", "local", "hosted", "hybrid"]).optional(),
  graph_depth: KnowledgeNumericSchema.optional(),
  edge_types: KnowledgeStringArraySchema.optional(),
  include_examples: z.boolean().optional(),
  include_antipatterns: z.boolean().optional(),
  include_context_cards: z.boolean().optional(),
  include_pack_cards: z.boolean().optional(),
  symbol_kind: KnowledgeShortStringSchema.optional(),
  perf_tier: KnowledgeShortStringSchema.optional(),
  corpus_class: KnowledgeShortStringSchema.optional(),
  constraint_kind: KnowledgeShortStringSchema.optional(),
  content_profile: KnowledgeShortStringSchema.optional(),
  constraint_source: KnowledgeShortStringSchema.optional(),
  golden_path_id: KnowledgeShortStringSchema.optional(),
  scope_tags: KnowledgeStringArraySchema.optional(),
  tags: KnowledgeStringSchema.optional(),
  content_format: KnowledgeShortStringSchema.optional(),
  repo_path: KnowledgeStringSchema.optional(),
  module_path: KnowledgeStringSchema.optional(),
  has_code: z.boolean().optional(),
  code_language: KnowledgeShortStringSchema.optional(),
  commit: KnowledgeShortStringSchema.optional(),
  branch: KnowledgeShortStringSchema.optional(),
  temporal_at: KnowledgeShortStringSchema.optional(),
  caller_org_id: KnowledgeShortStringSchema.optional(),
  caller_tenant_ids: KnowledgeStringArraySchema.optional(),
  caller_acl_groups: KnowledgeStringArraySchema.optional(),
  caller_user_id: KnowledgeShortStringSchema.optional(),
  caller_conversation_id: KnowledgeShortStringSchema.optional(),
}).strict();

type KnowledgeRouteBody = z.infer<typeof KnowledgeRouteBodySchema>;

const WebSearchNumericSchema = z.union([
  z.number(),
  z.string().trim().regex(/^\d{1,6}(\.\d{1,6})?$/),
]);

const WebSearchRouteBodySchema = z.object({
  query: KnowledgeStringSchema.optional(),
  top_k: WebSearchNumericSchema.optional(),
  profile: z.enum(["web", "code"]).optional(),
  fetch_pages: z.boolean().optional(),
  max_fetch_pages: WebSearchNumericSchema.optional(),
  min_relevance: WebSearchNumericSchema.optional(),
  preferred_domains: KnowledgeStringArraySchema.optional(),
  source_surface: z.enum(["yarn_chat", "yarn_mcp_http", "openwebui_planner", "planner_internal", "external_api"]).optional(),
  tool_name: KnowledgeShortStringSchema.optional(),
  request_id: KnowledgeShortStringSchema.optional(),
  session_key: KnowledgeShortStringSchema.optional(),
  conversation_id: KnowledgeShortStringSchema.optional(),
  trace_id: KnowledgeShortStringSchema.optional(),
  caller_org_id: KnowledgeShortStringSchema.optional(),
  caller_user_id: KnowledgeShortStringSchema.optional(),
  caller_tenant_ids: KnowledgeStringArraySchema.optional(),
}).strict();

type WebSearchRouteBody = z.infer<typeof WebSearchRouteBodySchema>;

function timeWindowMs(timeWindow: string | number): number {
  if (typeof timeWindow === "number" && Number.isFinite(timeWindow) && timeWindow > 0) return timeWindow;
  const match = String(timeWindow).trim().match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)$/i);
  if (!match) return 60000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "ms" || unit.startsWith("millisecond")) return amount;
  if (unit === "s" || unit.startsWith("second")) return amount * 1000;
  if (unit === "m" || unit.startsWith("minute")) return amount * 60_000;
  return amount * 3_600_000;
}

function createRouteRateLimit(options: RateLimitOptions) {
  const windowMs = timeWindowMs(options.timeWindow);
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(key);
      }
    }
    const routeId = request.routeOptions.url ?? request.url;
    const key = `${request.ip}:${request.method}:${routeId}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count <= options.max) return;

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply.header("retry-after", String(retryAfterSeconds));
    return reply.code(429).send({ error: "rate_limit_exceeded" });
  };
}

/** When the graph finishes with no assistant text (and no structured error), surface this instead of an empty message. */
const EMPTY_ASSISTANT_FALLBACK =
  "I wasn't able to complete a response for this request. Please try again or rephrase your question.";
const SYSTEM_FINGERPRINT = "synesis-planner-ts-compat-v1";

const SAFE_ERROR_PATTERNS = [
  /^Missing Bearer token$/,
  /^Invalid token$/,
  /^Untrusted forwarded identity/,
  /^Token missing required scope:/,
  /^Authorization denied/,
  /^Unsupported policy target:/,
  /is not configured yet/,
  /^Rate limit exceeded/,
  /^Request too large/,
  /^Too many requests/,
  /^Circuit breaker open/,
  /^LLM is not enabled$/,
];

function timingSafeTokenMatch(header: string | undefined, expected: string): boolean {
  return constantTimeBearerMatch(header, expected);
}

function sanitizeErrorMessage(raw: string): string {
  for (const pat of SAFE_ERROR_PATTERNS) {
    if (pat.test(raw)) return raw;
  }
  if (raw.startsWith("LLM HTTP ")) return "Upstream model service error";
  if (raw.includes("ZodError") || raw.includes("Expected")) return "Request validation failed";
  return "Internal server error";
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

type KnowledgeRoutingMode = "auto" | "local" | "hosted" | "hybrid";

function optionalRoutingMode(value: unknown): KnowledgeRoutingMode | undefined {
  const mode = optionalString(value);
  return mode === "auto" || mode === "local" || mode === "hosted" || mode === "hybrid" ? mode : undefined;
}

function hasCallerScopeHints(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  return [
    "caller_org_id",
    "caller_tenant_ids",
    "caller_acl_groups",
    "caller_user_id",
  ].some((key) => body[key] !== undefined && body[key] !== null);
}

function deriveKnowledgeSearchScope(
  auth: AuthContext,
  body: Record<string, unknown> | null,
  config: AppConfig,
  authzTraceId: string,
): ScopeFilterOptions {
  const trustedScopeSource = auth.trustedForwardedIdentity ? "trusted_forwarded_identity" : "auth_context";
  const callerOrgId = optionalString(auth.orgId);
  const callerUserId = auth.userId && auth.userId !== "anonymous" ? optionalString(auth.userId) : undefined;
  const callerConversationId = callerUserId ? optionalString(body?.caller_conversation_id) : undefined;

  return {
    callerOrgId,
    callerTenantIds: auth.tenantIds.length > 0 ? auth.tenantIds.slice(0, 50) : undefined,
    callerAclGroups: auth.aclGroups && auth.aclGroups.length > 0 ? auth.aclGroups.slice(0, 100) : undefined,
    callerUserId,
    callerConversationId,
    authzMode: config.SYNESIS_RAG_AUTHZ_MODE,
    authzTraceId,
    trustedScopeSource,
  };
}

function stringArrayBody(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((item) => String(item).trim()).filter(Boolean).slice(0, 50);
  return out.length ? out : undefined;
}

function metadataFromKnowledgeBody(body: Record<string, unknown> | null): import("./retrieval/metadata-filter.js").MetadataFilterParams {
  return {
    pack_id: body?.pack_id ? String(body.pack_id) : undefined,
    pack_ids: stringArrayBody(body?.pack_ids),
    pack_version: body?.pack_version ? String(body.pack_version) : undefined,
    pack_partition: body?.pack_partition ? String(body.pack_partition) : undefined,
    symbol_kind: body?.symbol_kind ? String(body.symbol_kind) : undefined,
    symbol_fqn: body?.symbol_fqn ? String(body.symbol_fqn) : undefined,
    package_name: body?.package_name ? String(body.package_name) : undefined,
    perf_tier: body?.perf_tier ? String(body.perf_tier) : undefined,
    language: body?.language ? String(body.language) : undefined,
    artifact_kind: body?.artifact_kind ? String(body.artifact_kind) : undefined,
    domain: body?.domain ? String(body.domain) : undefined,
    corpus_class: body?.corpus_class ? String(body.corpus_class) : undefined,
    constraint_kind: body?.constraint_kind ? String(body.constraint_kind) : undefined,
    content_profile: body?.content_profile ? String(body.content_profile) : undefined,
    constraint_source: body?.constraint_source ? String(body.constraint_source) : undefined,
    golden_path_id: body?.golden_path_id ? String(body.golden_path_id) : undefined,
    scope_tags: stringArrayBody(body?.scope_tags),
    tags: body?.tags ? String(body.tags) : undefined,
    content_format: body?.content_format ? String(body.content_format) : undefined,
    repo_path: body?.repo_path ? String(body.repo_path) : undefined,
    module_path: body?.module_path ? String(body.module_path) : undefined,
    symbol_name: body?.symbol_name ? String(body.symbol_name) : undefined,
    has_code: typeof body?.has_code === "boolean" ? body.has_code : undefined,
    code_language: body?.code_language ? String(body.code_language) : undefined,
  };
}

function parseKnowledgeRouteBody(
  request: FastifyRequest,
  reply: FastifyReply,
): KnowledgeRouteBody | null {
  const parsed = KnowledgeRouteBodySchema.safeParse(request.body ?? {});
  if (parsed.success) return parsed.data;
  request.log.warn(
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    },
    "knowledge_route_body_validation_failed",
  );
  void reply.code(400).send({ error: "Request validation failed" });
  return null;
}

function parseWebSearchRouteBody(
  request: FastifyRequest,
  reply: FastifyReply,
): WebSearchRouteBody | null {
  const parsed = WebSearchRouteBodySchema.safeParse(request.body ?? {});
  if (parsed.success) return parsed.data;
  request.log.warn(
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    },
    "web_search_body_validation_failed",
  );
  void reply.code(400).send({ error: "Request validation failed" });
  return null;
}

function inferPlannerModelFamily(modelId: string): string {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  if (!normalized) return "generic";
  if (normalized.includes("/")) return normalized.split("/")[0] || "generic";
  const dash = normalized.split("-")[0];
  return dash || "generic";
}

function normalizeSourceSurface(value: unknown): WebSearchAttribution["source_surface"] {
  const raw = String(value ?? "").trim();
  switch (raw) {
    case "yarn_chat":
    case "yarn_mcp_http":
    case "openwebui_planner":
    case "planner_internal":
    case "external_api":
      return raw;
    default:
      return "planner_internal";
  }
}

function normalizePreferredDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^site:/, "");
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^www\./, "");
  }
}

function webResultMatchesDomain(result: { url?: string }, domain: string): boolean {
  try {
    const hostname = new URL(result.url ?? "").hostname.toLowerCase().replace(/^www\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function applyWebSearchDomainPolicy<T extends { url?: string; relevance?: number; score?: number }>(
  results: T[],
  preferredDomains: string[] | undefined,
  mode: "prefer" | "restrict",
  boost: number,
): T[] {
  const domains = (preferredDomains ?? []).map(normalizePreferredDomain).filter(Boolean);
  if (domains.length === 0 || results.length === 0) return results;

  const matches = (result: T) => domains.some((domain) => webResultMatchesDomain(result, domain));
  if (mode === "restrict") return results.filter(matches);

  return results
    .map((result) => {
      if (!matches(result)) return result;
      return {
        ...result,
        relevance: typeof result.relevance === "number" ? result.relevance * boost : result.relevance,
        score: typeof result.score === "number" ? result.score * boost : result.score,
      };
    })
    .sort((a, b) => (b.relevance ?? b.score ?? 0) - (a.relevance ?? a.score ?? 0));
}

async function isSearchRouteAuthorized(
  authorizationHeader: string | undefined,
  internalServiceToken: string,
  patPepper: string,
): Promise<boolean> {
  const raw = String(authorizationHeader ?? "");
  if (!raw.toLowerCase().startsWith("bearer ")) return false;
  const bearer = extractBearerToken(raw);
  if (!bearer) return false;
  if (constantTimeBearerMatch(raw, internalServiceToken)) return true;
  if (!bearer.startsWith("syn-")) return false;
  try {
    const pat = await resolvePatFromDb(bearer, patPepper);
    return Boolean(pat);
  } catch {
    return false;
  }
}

type ParsedChatRequest = ReturnType<typeof ChatCompletionRequestSchema.parse>;

function requestGenerationParams(body: ParsedChatRequest): GenerationParams {
  const out: GenerationParams = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.trunc(maxTokens);
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature) && body.temperature >= 0) out.temperature = body.temperature;
  if (typeof body.top_p === "number" && Number.isFinite(body.top_p) && body.top_p >= 0 && body.top_p <= 1) out.top_p = body.top_p;
  if (typeof body.top_k === "number" && Number.isFinite(body.top_k) && body.top_k >= 0) out.top_k = Math.trunc(body.top_k);
  if (typeof body.min_p === "number" && Number.isFinite(body.min_p) && body.min_p >= 0 && body.min_p <= 1) out.min_p = body.min_p;
  if (typeof body.presence_penalty === "number" && Number.isFinite(body.presence_penalty)) out.presence_penalty = body.presence_penalty;
  if (typeof body.frequency_penalty === "number" && Number.isFinite(body.frequency_penalty)) out.frequency_penalty = body.frequency_penalty;
  if (typeof body.repetition_penalty === "number" && Number.isFinite(body.repetition_penalty) && body.repetition_penalty >= 0) out.repetition_penalty = body.repetition_penalty;
  if (typeof body.enable_thinking === "boolean") out.enable_thinking = body.enable_thinking;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) out.reasoning_effort = body.reasoning_effort.trim();
  if (typeof body.stop === "string" || Array.isArray(body.stop)) out.stop = body.stop;
  if (typeof body.seed === "number" && Number.isFinite(body.seed)) out.seed = Math.trunc(body.seed);
  if (body.logit_bias && typeof body.logit_bias === "object") out.logit_bias = body.logit_bias;
  if (typeof body.logprobs === "boolean") out.logprobs = body.logprobs;
  if (typeof body.top_logprobs === "number" && Number.isFinite(body.top_logprobs) && body.top_logprobs >= 0) out.top_logprobs = Math.trunc(body.top_logprobs);
  if (typeof body.n === "number" && Number.isFinite(body.n) && body.n > 0) out.n = Math.trunc(body.n);
  if (Array.isArray(body.tools)) out.tools = body.tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.extra_body && typeof body.extra_body === "object") out.extra_body = body.extra_body;
  return out;
}

function hasNativeToolTraffic(body: ParsedChatRequest): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return body.messages.some((message) => {
    const raw = message as unknown as Record<string, unknown>;
    return (
      message.role === "tool"
      || (message.role === "assistant" && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0)
    );
  });
}

function toOpenAICompatMessages(body: ParsedChatRequest): OpenAICompatChatRequest["messages"] {
  return body.messages.map((message) => {
    const raw = message as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? "",
    };
    if (typeof raw.name === "string" && raw.name.trim()) out.name = raw.name;
    if (typeof raw.tool_call_id === "string" && raw.tool_call_id.trim()) out.tool_call_id = raw.tool_call_id;
    if (Array.isArray(raw.tool_calls)) out.tool_calls = raw.tool_calls;
    return out as OpenAICompatChatRequest["messages"][number];
  });
}

function firstChoiceContent(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const raw = part as Record<string, unknown>;
        if (typeof raw.text === "string") return raw.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function pipeOpenAICompatStream(reply: FastifyReply, upstream: Response): Promise<void> {
  const contentType = upstream.headers.get("content-type") || "text/event-stream; charset=utf-8";
  reply.raw.statusCode = upstream.status;
  reply.raw.setHeader("Content-Type", contentType);
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");

  if (!upstream.body) {
    reply.raw.end();
    return;
  }
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    if (reply.raw.writableEnded || reply.raw.destroyed) break;
    reply.raw.write(Buffer.from(chunk));
  }
  if (!reply.raw.writableEnded) reply.raw.end();
}

function resolveIncomingConversationId(
  rawBody: unknown,
  headers: Record<string, unknown>,
  parsedConversationId?: string | null,
): { id: string; source: string } {
  const parsed = (parsedConversationId ?? "").trim();
  if (parsed) return { id: parsed, source: "body.conversation_id" };

  const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody))
    ? (rawBody as Record<string, unknown>)
    : {};

  for (const key of ["conversation_id", "session_id", "chat_id"]) {
    const val = body[key];
    if (typeof val === "string" && val.trim()) {
      return { id: val.trim(), source: `body.${key}` };
    }
  }

  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>;
    for (const key of ["conversation_id", "synesis_conversation_id", "session_id", "chat_id"]) {
      const val = meta[key];
      if (typeof val === "string" && val.trim()) {
        return { id: val.trim(), source: `body.metadata.${key}` };
      }
    }
  }

  for (const key of [
    "x-synesis-conversation-id",
    "x-openwebui-conversation-id",
    "x-openwebui-chat-id",
    "x-chat-id",
    "x-session-id",
  ]) {
    const val = headers[key];
    if (typeof val === "string" && val.trim()) {
      return { id: val.trim(), source: `header.${key}` };
    }
  }

  return { id: "", source: "none" };
}

function resolveOpenWebUIEventMetadata(
  rawBody: unknown,
  headers: Record<string, unknown>,
  parsedConversationId?: string | null,
): { chatId?: string; messageId?: string; sources: Record<string, string> } {
  const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody))
    ? (rawBody as Record<string, unknown>)
    : {};
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? (body.metadata as Record<string, unknown>)
    : {};
  const sources: Record<string, string> = {};

  let chatId = optionalString(parsedConversationId);
  if (chatId) sources.chatId = "body.conversation_id";
  if (!chatId) {
    for (const [source, value] of [
      ["body.chat_id", body.chat_id],
      ["body.metadata.chat_id", metadata.chat_id],
      ["body.metadata.conversation_id", metadata.conversation_id],
      ["body.metadata.synesis_conversation_id", metadata.synesis_conversation_id],
      ["header.x-openwebui-chat-id", headers["x-openwebui-chat-id"]],
      ["header.x-openwebui-conversation-id", headers["x-openwebui-conversation-id"]],
      ["header.x-chat-id", headers["x-chat-id"]],
    ] as Array<[string, unknown]>) {
      const candidate = optionalString(value);
      if (candidate) {
        chatId = candidate;
        sources.chatId = source;
        break;
      }
    }
  }

  let messageId: string | undefined;
  for (const [source, value] of [
    ["body.message_id", body.message_id],
    ["body.metadata.message_id", metadata.message_id],
    ["body.metadata.parent_message_id", metadata.parent_message_id],
    ["body.metadata.user_message_id", metadata.user_message_id],
    ["header.x-openwebui-message-id", headers["x-openwebui-message-id"]],
    ["header.x-message-id", headers["x-message-id"]],
  ] as Array<[string, unknown]>) {
    const candidate = optionalString(value);
    if (candidate) {
      messageId = candidate;
      sources.messageId = source;
      break;
    }
  }

  return { chatId, messageId, sources };
}

function statusPhaseForGraphNode(node: string): PlannerStatusPhase {
  switch (node) {
    case "entry_pipeline":
      return "classifying";
    case "planner":
      return "planning";
    case "plan_gate":
      return "validating";
    case "router":
      return "retrieving";
    case "writer":
      return "synthesizing";
    case "critic":
      return "critic";
    case "final_scrubber":
      return "validating";
    case "respond":
      return "streaming";
    default:
      return "intake";
  }
}

function architectureControlMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const allowedKeys = [
    "synesis",
    "synesis_context_mediation",
    "synesis_architecture_mediation",
    "architecture_mediation",
    "synesis_architecture_profile",
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (metadata[key] !== undefined) out[key] = metadata[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}


function isLikelyQuizOptionAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  return /^([a-d]|[1-4])[).:]?$/i.test(trimmed);
}

function hasMultipleChoiceOptions(text: string): boolean {
  const optionMatches = text.match(/\b([A-D]|[1-4])[).:]\s*/gi) ?? [];
  const unique = new Set(optionMatches.map((m) => m.trim().charAt(0).toUpperCase()));
  return unique.size >= 2;
}

function findLatestUserTurnWithPreviousAssistant(
  messages: Array<{ role: string; content?: string | null }>,
): { latestUserContent?: string; previousAssistantContent?: string } {
  let latestUserIndex = -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (message.role === "user" && typeof message.content === "string") {
      latestUserIndex = idx;
      break;
    }
  }
  if (latestUserIndex < 0) return {};

  for (let idx = latestUserIndex - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (message.role === "assistant" && typeof message.content === "string") {
      return {
        latestUserContent: messages[latestUserIndex]?.content ?? "",
        previousAssistantContent: message.content,
      };
    }
  }

  return {
    latestUserContent: messages[latestUserIndex]?.content ?? "",
  };
}

function buildQuizFollowupTask(
  answer: string,
  previousAssistantTurn: string,
): string {
  return [
    "Quiz context:",
    previousAssistantTurn.trim(),
    "",
    "Learner answer:",
    answer.trim(),
    "",
    "Instruction:",
    "Grade the answer against the quiz options, state whether it is correct, and give a short explanation.",
  ].join("\n");
}

export function buildApp(config: AppConfig): FastifyInstance {
  initFgaClient(config);

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    forceCloseConnections: "idle"
  });
  void app.register(fastifyRateLimit, {
    global: true,
    max: config.SYNESIS_PLANNER_TS_GLOBAL_RATE_LIMIT_MAX,
    timeWindow: config.SYNESIS_PLANNER_TS_GLOBAL_RATE_LIMIT_WINDOW,
  });
  // Keep origin-side throttling in addition to Cloudflare edge controls so
  // internal/private paths remain consistently rate-limited.

  const promRegistry = new Registry();
  const metrics = createServiceMetrics("planner", promRegistry);

  const pricingRegistry = new PricingRegistry({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    cachedMultiplier: config.SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER,
  });

  void pricingRegistry.start().then(() => {
    const defaultRates = pricingRegistry.getRates("router");
    setPricingContext(defaultRates, pricingRegistry.getCachedMultiplier());
  }).catch((err) => {
    app.log.warn({ err }, "pricing registry startup failed (non-fatal)");
  });

  startPublicModelCatalogPolling(config);

  const embedderConfigured = Boolean(config.SYNESIS_EMBEDDER_URL?.trim());
  const webSearchConfigured =
    config.SYNESIS_WEB_SEARCH_ENABLED && Boolean(config.SYNESIS_WEB_SEARCH_URL?.trim());
  if (embedderConfigured || webSearchConfigured) {
    setRetrievalClient(new UnifiedRetrievalClient(config));
    if (!embedderConfigured && webSearchConfigured) {
      app.log.warn(
        { webSearchUrl: "configured", embedder: "not_set" },
        "retrieval: unified client active for web-only path (RAG will return empty until embedder is set)",
      );
    }
  }

  setWebSearchObserver(async (payload) => {
    await persistWebSearchLog(
      {
        adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL,
        logger: app.log,
      },
      {
        query: payload.query,
        profile: payload.profile,
        results: payload.results,
        latencyMs: payload.latencyMs,
        outcome: payload.results.length > 0 ? "success" : "empty",
        policyAction: "allow",
        attribution: payload.attribution ?? {
          source_surface: "planner_internal",
          tool_name: "planner_internal",
        },
      },
    );
  });

  const knowledgeSearchRagConfig: import("./retrieval/rag-client.js").RagClientConfig = {
    nornicUri: config.SYNESIS_NORNIC_URI,
    nornicUser: config.SYNESIS_NORNIC_USER,
    nornicPassword: config.SYNESIS_NORNIC_PASSWORD,
    nornicDatabase: config.SYNESIS_NORNIC_DATABASE,
    nornicVectorIndex: config.SYNESIS_NORNIC_VECTOR_INDEX,
    nornicRuntimeProfile: config.SYNESIS_NORNIC_RUNTIME_PROFILE,
    embedderUrl: config.SYNESIS_EMBEDDER_URL,
    embedderModel: config.SYNESIS_EMBEDDER_MODEL,
    retrievalStrategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
    rrfK: config.SYNESIS_RAG_RRF_K,
    scoreThreshold: config.SYNESIS_RAG_SCORE_THRESHOLD,
    rerankScoreMin: config.SYNESIS_RAG_RERANK_SCORE_MIN,
    graphDepth: config.SYNESIS_NORNIC_GRAPH_DEPTH,
    edgeTypes: config.SYNESIS_NORNIC_EDGE_TYPES.split(",").map((s) => s.trim()).filter(Boolean),
    rerankEnabled: config.SYNESIS_NORNIC_RERANK_ENABLED,
  };

  const retrieveContextFn = retrieveContext;
  const buildMetadataFilterFn = buildMetadataFilter;
  const extractTagMetadataFn = extractTagMetadata;

  const traceEmitterConfig = {
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
  };

  const optimizationCounters = {
    reducedCount: 0,
    reducedCharsTotal: 0,
    rawCharsTotal: 0
  };

  const sessionStore = createSessionStore({
    redisUrl: config.SYNESIS_PLANNER_TS_REDIS_URL,
    redisKeyPrefix: config.SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX,
    memoryMaxSessions: config.SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS,
    redisCasMaxRetries: config.SYNESIS_PLANNER_TS_REDIS_CAS_MAX_RETRIES,
  });
  const sessionManager = new SessionManager({
    enabled: config.SYNESIS_PLANNER_TS_SESSION_ENABLED,
    maxHistory: config.SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY,
    checkpointEveryMessages: config.SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES,
    ttlMs: config.SYNESIS_PLANNER_TS_SESSION_TTL_MS,
    checkpointIncludeRecentExchanges: config.SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_INCLUDE_RECENT,
    store: sessionStore
  });
  const authzPolicyEngine = createAuthorizationPolicyEngine(config);
  const promptRegistry = new PromptRegistry({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    refreshMs: config.SYNESIS_PLANNER_TS_PROMPT_REFRESH_MS,
    logger: app.log,
  });
  promptRegistry.start();
  const capabilityMatrixClient = new CapabilityMatrixClient({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    refreshMs: config.SYNESIS_PLANNER_TS_PROMPT_REFRESH_MS,
    logger: app.log,
  });
  capabilityMatrixClient.start();
  const failureStore = new FailureStore();
  const dependencyHealthMonitor = new DependencyHealthMonitor(config, sessionStore);
  const userRateLimiter = new UserRateLimiter({
    windowMs: config.SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS,
    maxRequests: config.SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS,
  });
  const streamAdmission = new StreamAdmissionController({
    maxConcurrentStreams: config.SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT,
    maxQueueDepth: config.SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX,
    queueWaitTimeoutMs: config.SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS,
  });

  app.addHook("onClose", async () => {
    userRateLimiter.close();
    streamAdmission.close();
    dependencyHealthMonitor.stop();
    promptRegistry.stop();
    capabilityMatrixClient.stop();
    await sessionStore.disconnect();
  });
  dependencyHealthMonitor.start();

  function spawnBackgroundCritic(state: GraphState, requestLog: FastifyInstance["log"]): void {
    const executionPolicy = state.execution_policy ?? {};
    if (!(executionPolicy as Record<string, unknown>).critic_background) return;
    if (!(state.generated_code ?? "").trim()) return;
    const criticStartTime = Date.now() / 1000;
    void evaluateCritic({ ...state, next_node: "critic" })
      .then((result) => {
        const criticEndTime = Date.now() / 1000;
        const criticLatencyMs = Math.round((criticEndTime - criticStartTime) * 1000);
        requestLog.info(
          {
            authzTraceId: state.authz_trace_id,
            approved: result.approved,
            needMoreEvidence: result.need_more_evidence,
          },
          "background critic completed",
        );
        const model = config.SYNESIS_PLANNER_TS_CRITIC_MODEL || "synesis-critic";
        const criticRates = state.pricing_rates_by_role?.critic ?? pricingRegistry.getRates("critic");
        const criticExecutionMode = result.usage?.total_tokens ? "llm" : "deterministic";
        const bgCriticData: Record<string, unknown> = {
          approved: result.approved,
          need_more_evidence: result.need_more_evidence,
          scores: result.scores,
          blocking_issues: result.blocking_issues ?? [],
          nonblocking: result.nonblocking ?? [],
          latency_ms: criticLatencyMs,
          is_background: true,
          execution_mode: criticExecutionMode,
        };
        const syntheticSpan: import("@synesis/telemetry").TraceSpanRecord = {
          node_name: "background_critic",
          intent: "Background Critic (async)",
          start_time: criticStartTime,
          end_time: criticEndTime,
          latency_ms: criticLatencyMs,
          tokens_used: result.usage?.total_tokens ?? 0,
          confidence: typeof result.scores === "object"
            ? Object.values(result.scores as Record<string, number>).reduce((a, b) => a + b, 0) /
              Math.max(Object.keys(result.scores as Record<string, number>).length, 1)
            : 0,
          outcome: result.approved ? "approved" : "rejected",
          llm_calls: result.usage?.total_tokens
            ? [{
                model,
                node: "background_critic",
                role: "critic",
                prompt_tokens: result.usage.prompt_tokens,
                completion_tokens: result.usage.completion_tokens,
                total_tokens: result.usage.total_tokens,
                cached_prompt_tokens: result.usage.cached_prompt_tokens || undefined,
                latency_ms: criticLatencyMs,
                timestamp: criticEndTime,
                actual_cost: result.usage.actual_cost_usd || undefined,
                estimated_cost: result.usage.estimated_cost_usd || undefined,
              }]
            : [],
          metadata: { async: true, ...bgCriticData },
        };
        const criticTrace: TraceRecord = {
          service: "planner",
          trace_id: state.authz_trace_id ?? crypto.randomUUID(),
          request_id: state.authz_trace_id ?? crypto.randomUUID(),
          authz_trace_id: state.authz_trace_id,
          conversation_id: state.conversation_id,
          timestamp: criticEndTime,
          user_id: state.user_id ?? "",
          org_id: state.org_id ?? "",
          tenant_id: state.tenant_ids?.[0] ?? "",
          model,
          tokens: result.usage,
          cost: {
            estimated_usd: result.usage.estimated_cost_usd,
            actual_usd: result.usage.actual_cost_usd,
            rates_snapshot: criticRates,
          },
          latency_ms: criticLatencyMs,
          background_critic: bgCriticData,
          spans: [syntheticSpan],
        };
        emitTrace(criticTrace, traceEmitterConfig, app.log);
      })
      .catch((error: unknown) => {
        requestLog.warn(
          {
            authzTraceId: state.authz_trace_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "background critic failed",
        );
      });
  }

  async function toState(
    requestBody: ParsedChatRequest,
    requestHeaders: Record<string, unknown>,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
    authzTraceId: string,
    policyDecision: PolicyDecision,
    sessionKey: string,
    traceparent?: string,
  ): Promise<GraphState> {
    const promptSnapshot = promptRegistry.getSnapshot();
    const incomingWithSession = await sessionManager.enrichIncomingMessages(
      sessionKey,
      requestBody.messages.map((m) => ({ role: m.role, content: m.content ?? "" }))
    );
    const selectedContext = selectConversationContext(incomingWithSession, {
      enabled: config.SYNESIS_PLANNER_TS_CONTEXT_SELECTION_ENABLED,
      recentTurns: config.SYNESIS_PLANNER_TS_CONTEXT_RECENT_TURNS,
    });
    const tierSettings = resolveTierSettings(requestBody.model);
    const requestGeneration = requestGenerationParams(requestBody);
    const requestedEffortMode = tierSettings.tier;
    const writerPricingRole = tierSettings.registry_writer_role ?? "writer";
    const plannerMatrixModelId = String(tierSettings.responseModel || tierSettings.requestedModel || requestBody.model || "");
    const plannerMatrixModelPath = plannerMatrixModelId;
    const plannerMatrixFamily = inferPlannerModelFamily(plannerMatrixModelId);
    const plannerCapabilityResolution = resolveCapabilityMatrix(capabilityMatrixClient.getMatrix(), {
      model_id: plannerMatrixModelId,
      model_path: plannerMatrixModelPath,
      family: plannerMatrixFamily,
    });
    const plannerContextOptimizerEnabled =
      plannerCapabilityResolution.mode !== "enforced"
      || plannerCapabilityResolution.resolved_capabilities["planner.context_optimizer_enabled"] === true;
    const rawCharsTotal = selectedContext.messages.reduce((sum, message) => sum + (message.content ?? "").length, 0);
    const optimized = plannerContextOptimizerEnabled
      ? optimizeContext(selectedContext.messages, {
          maxCharsPerMessage: config.SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS,
          recentMessageLimit: config.SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT
        })
      : {
          messages: selectedContext.messages,
          stats: {
            reducedCount: 0,
            reducedCharsTotal: rawCharsTotal,
            rawCharsTotal,
          },
        };
    optimizationCounters.reducedCount += optimized.stats.reducedCount;
    optimizationCounters.reducedCharsTotal += optimized.stats.reducedCharsTotal;
    optimizationCounters.rawCharsTotal += optimized.stats.rawCharsTotal;
    const optimizedMessages = optimized.messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
    }));
    const plannerCapabilityHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(plannerCapabilityResolution.resolved_capabilities)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    app.log.info(
      {
        authzTraceId,
        modelId: plannerMatrixModelId,
        family: plannerMatrixFamily,
        modelPath: plannerMatrixModelPath,
        mode: plannerCapabilityResolution.mode,
        globalOptimizationsEnabled: plannerCapabilityResolution.global_optimizations_enabled,
        matchedOverrideIds: plannerCapabilityResolution.matched_override_ids,
        resolvedCapabilities: plannerCapabilityResolution.resolved_capabilities,
        capabilityHash: plannerCapabilityHash,
      },
      "capability_matrix_resolution_v1",
    );

    const userMessage = [...requestBody.messages].reverse().find((m) => m.role === "user");
    let taskText = userMessage?.content ?? "";

    if (config.SYNESIS_INJECTION_SCORER_URL && taskText) {
      void scorePromptInjection(taskText, "user_message", {
        url: config.SYNESIS_INJECTION_SCORER_URL,
        authToken: config.SYNESIS_INJECTION_SCORER_TOKEN,
        model: config.SYNESIS_INJECTION_SCORER_MODEL,
        timeoutMs: config.SYNESIS_INJECTION_SCORER_TIMEOUT_MS,
      }).then((result) => {
        emitSecurityEvent(promptInjectionScoreToPayload(result, {
          service: "planner",
          requestId: authzTraceId,
          sessionId: sessionKey,
          userId: auth.userId,
          orgId: auth.orgId,
          threshold: config.SYNESIS_INJECTION_SCORER_THRESHOLD,
          actionTaken: config.SYNESIS_INJECTION_ACTION,
        }), traceEmitterConfig, { warn: (message) => app.log.warn(message) });
      });
    }

    let injectionDetected = false;
    let injectionScanResult: { detected: boolean; patterns_found: string[]; source: string } = {
      detected: false, patterns_found: [], source: ""
    };
    if (config.SYNESIS_INJECTION_SCAN_ENABLED) {
      const history = requestBody.messages
        .filter((m) => m.role === "user")
        .slice(0, -1)
        .map((m) => m.content ?? "");
      const [detected, details] = scanUserInput(taskText, history);
      injectionDetected = detected;
      injectionScanResult = details;

      const applyMitigation = shouldApplyUserInjectionMitigation(
        injectionScanResult.patterns_found,
        config.SYNESIS_INJECTION_ACTION,
        config.SYNESIS_INJECTION_REQUIRE_DUAL_SIGNAL,
      );
      if (detected && config.SYNESIS_INJECTION_ACTION === "block" && applyMitigation) {
        const err = new Error("Suspicious content detected. If this was unintentional, rephrase your message and try again.");
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (detected && config.SYNESIS_INJECTION_ACTION === "reduce" && applyMitigation && taskText) {
        taskText = redactPatterns(taskText);
      }
    }

    const pendingClarification = await sessionManager.getPendingClarification(sessionKey);
    let mergedTaskText = taskText;
    const { latestUserContent, previousAssistantContent } = findLatestUserTurnWithPreviousAssistant(requestBody.messages);
    const applyQuizFollowupMerge = Boolean(
      latestUserContent
      && isLikelyQuizOptionAnswer(latestUserContent)
      && previousAssistantContent
      && hasMultipleChoiceOptions(previousAssistantContent),
    );
    const applyPendingClarification = Boolean(
      pendingClarification && isLikelyClarificationAnswer(taskText, pendingClarification),
    );
    if (applyQuizFollowupMerge && previousAssistantContent) {
      mergedTaskText = buildQuizFollowupTask(taskText, previousAssistantContent);
    } else if (applyPendingClarification && pendingClarification?.originalTaskDescription) {
      const originalTask = pendingClarification.originalTaskDescription.trim();
      const answer = taskText.trim();
      mergedTaskText = [
        "Original request:",
        originalTask,
        "",
        "Clarification response:",
        answer || "(no answer provided)",
        "",
        "Re-plan instruction:",
        "Use the original request and the clarification response together. The clarification constrains the original request; it does not replace it.",
      ].join("\n");
    }
    const domainProfile = buildDomainProfile(mergedTaskText);
    const resolvedWriterModel =
      tierSettings.resolved_writer_model?.trim()
      || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
      || "synesis-writer";
    const combinedExtraBody = {
      ...(tierSettings.writer_generation_params?.extra_body ?? {}),
      ...(requestGeneration.extra_body ?? {}),
    };
    const architectureMediation = resolvePlannerArchitectureMediation({
      headers: requestHeaders,
      metadata: architectureControlMetadata(requestBody.metadata),
      extraBody: Object.keys(combinedExtraBody).length > 0 ? combinedExtraBody : requestBody.extra_body,
      requestedModel: tierSettings.requestedModel || requestBody.model,
      writerModel: resolvedWriterModel,
      provider: tierSettings.resolved_writer_route?.provider,
      family: plannerMatrixFamily,
      modelCapabilityPreset: tierSettings.model_capability_preset,
      messages: optimizedMessages,
      taskDescription: mergedTaskText,
    });
    const hygiene = applyPlannerContextHygiene(optimizedMessages, architectureMediation.policy);
    const mediatedMessages = hygiene.messages;
    app.log.info(
      {
        authzTraceId,
        sessionKey,
        conversationId: requestBody.conversation_id ?? undefined,
        contextSelection: selectedContext.metadata,
        contextMediation: {
          mode: architectureMediation.policy.mediationMode,
          profile: architectureMediation.profile.modelId,
          chatProfile: architectureMediation.chatProfile,
          hygieneScore: architectureMediation.artifacts.hygieneReport.hygieneScore,
          removedMessages: hygiene.removedCount,
        },
      },
      "planner_context_selection_v1",
    );

    const baseState: GraphState = {
      messages: mediatedMessages.map((m) => ({ role: m.role, content: m.content ?? "" })),
      user_id: auth.userEmail || auth.userId,
      org_id: auth.orgId,
      tenant_ids: auth.tenantIds,
      token_scopes: auth.tokenScopes,
      acl_groups: auth.aclGroups && auth.aclGroups.length > 0 ? auth.aclGroups.slice(0, 100) : undefined,
      auth_method: auth.authMethod,
      conversation_id: requestBody.conversation_id ?? undefined,
      rag_authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
      authz_trace_id: authzTraceId,
      authz_engine: authzPolicyEngine.engineName,
      authz_rules: policyDecision.matchedRules,
      requested_model: tierSettings.requestedModel || requestBody.model,
      response_model: tierSettings.responseModel,
      model_tier: tierSettings.tier,
      registry_writer_role: tierSettings.registry_writer_role,
      resolved_writer_model: tierSettings.resolved_writer_model,
      resolved_writer_route: tierSettings.resolved_writer_route,
      writer_generation_params: { ...(tierSettings.writer_generation_params ?? {}), ...requestGeneration },
      pricing_rates_by_role: {
        router: pricingRegistry.getRates("router"),
        planner: pricingRegistry.getRates("planner"),
        writer: pricingRegistry.getRates(writerPricingRole),
        ambiguity: pricingRegistry.getRates("ambiguity-scorer"),
        critic: pricingRegistry.getRates("critic"),
      },
      requested_effort_mode: requestedEffortMode,
      task_description: mergedTaskText,
      evidence_packets: [],
      decision_ledger: [],
      critique_register: {},
      draft_fingerprints: [],
      patch_ops: [],
      writer_max_tokens: requestGeneration.max_tokens ?? tierSettings.writerMaxTokens,
      critic_max_tokens: tierSettings.criticMaxTokens,
      execution_policy: {
        critique_passes: tierSettings.critiquePasses,
        critic_background: config.SYNESIS_PLANNER_TS_CRITIC_BACKGROUND,
        capability_matrix: {
          mode: plannerCapabilityResolution.mode,
          global_optimizations_enabled: plannerCapabilityResolution.global_optimizations_enabled,
          model_id: plannerMatrixModelId,
          family: plannerMatrixFamily,
          model_path: plannerMatrixModelPath,
          matched_override_ids: plannerCapabilityResolution.matched_override_ids,
          capability_hash: plannerCapabilityHash,
          resolved_capabilities: plannerCapabilityResolution.resolved_capabilities,
          effective_context_optimizer_enabled: plannerContextOptimizerEnabled,
        },
      },
      run_id: requestBody.conversation_id?.trim() || crypto.randomUUID(),
      traceparent,
      requested_response_format: requestBody.response_format,
      stream_include_usage: requestBody.stream_options?.include_usage,
      context_selection: selectedContext.metadata,
      architecture_mediation: architectureMediation,
      planner_chat_profile: architectureMediation.chatProfile,
      planner_active_state_header: architectureMediation.activeStateHeader,
      planner_architecture_trace: {
        ...architectureMediation.trace,
        hygiene_removed_messages: hygiene.removedCount,
      },
      domain_profile: domainProfile,
      injection_detected: injectionDetected,
      injection_scan_result: injectionScanResult,
      _prompt_snapshot: promptSnapshot ?? null,
    };

    if (applyPendingClarification && pendingClarification) {
      baseState.user_answer_to_clarification = taskText;
      baseState.assumptions = pendingClarification.assumptions;
      // The original request was complex enough to trigger clarification.
      // The follow-up answer is typically short ("on prem, 50 users") so the
      // entry classifier would downgrade it to trivial. Force the full
      // pipeline so the planner runs with conversation context + answer.
      baseState.plan_required = true;
      baseState.difficulty = Math.max(baseState.difficulty ?? 0, 0.6);
    }
    if (applyQuizFollowupMerge) {
      // Short quiz answers are context-dependent; avoid downgrading to trivial.
      baseState.plan_required = true;
      baseState.difficulty = Math.max(baseState.difficulty ?? 0, 0.45);
    }

    if (applyPendingClarification && pendingClarification) {
      await sessionManager.clearPendingClarification(sessionKey);
    }

    return baseState;
  }

  async function readinessSnapshot(): Promise<{
    ready: boolean;
    checks: {
      llm: { configured: boolean; ok: boolean; detail?: string };
      redis: { configured: boolean; ok: boolean; detail?: string };
    };
  }> {
    const llmConfigured = Boolean(config.SYNESIS_PLANNER_TS_LLM_ENABLED);
    let llmOk = true;
    let llmDetail = "disabled_or_not_configured";
    if (llmConfigured) {
      llmOk = hasLlmRoutes() || Boolean(config.SYNESIS_PLANNER_TS_LLM_BASE_URL);
      llmDetail = hasLlmRoutes() ? "admin_routes_loaded" : llmOk ? "fallback_base_url_configured" : "no_routes_loaded";
    }

    const redisConfigured = Boolean(config.SYNESIS_PLANNER_TS_REDIS_URL);
    let redisOk = true;
    let redisDetail = "disabled_or_not_configured";
    if (redisConfigured) {
      redisOk = await sessionStore.ping();
      redisDetail = redisOk ? "pong" : "ping_failed";
    }

    return {
      ready: llmOk && redisOk,
      checks: {
        llm: { configured: llmConfigured, ok: llmOk, detail: llmDetail },
        redis: { configured: redisConfigured, ok: redisOk, detail: redisDetail },
      },
    };
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "planner-ts",
  }));

  app.get("/health/detailed", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return {
      status: "ok",
      service: "planner-ts",
      contextOptimization: optimizationCounters,
      session: await sessionManager.telemetry(),
      llm: {
        enabled: config.SYNESIS_PLANNER_TS_LLM_ENABLED,
        baseUrlConfigured: Boolean(config.SYNESIS_PLANNER_TS_LLM_BASE_URL),
        adminRoutesLoaded: hasLlmRoutes(),
        prefixCacheMode: config.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE
      },
      redis: {
        configured: Boolean(config.SYNESIS_PLANNER_TS_REDIS_URL)
      },
      llmResilience: getLlmResilienceStats(),
      promptLibrary: promptRegistry.getStats(),
      capabilityMatrix: capabilityMatrixClient.getStats(),
      admissionControl: {
        userRateLimit: userRateLimiter.getStats(),
        streamAdmission: streamAdmission.getStats(),
      },
      failures: failureStore.stats(),
      deps: dependencyHealthMonitor.snapshot(),
      auth: {
        engine: authzPolicyEngine.engineName,
        policyStats: authzPolicyEngine.getStats(),
        openfga: {
          apiUrlConfigured: Boolean(config.SYNESIS_OPENFGA_API_URL),
          storeConfigured: Boolean(config.SYNESIS_OPENFGA_STORE_ID),
          modelConfigured: Boolean(config.SYNESIS_OPENFGA_MODEL_ID),
          authTokenConfigured: Boolean(config.SYNESIS_OPENFGA_AUTH_TOKEN)
        },
        requireBearerAuth: config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH,
        trustForwardedIdentityHeaders: config.SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS,
        strictForwardedIdentityMode: config.SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE
      }
    };
  });

  app.get("/health/readiness", async (_request, reply) => {
    const readiness = await readinessSnapshot();
    if (!readiness.ready) {
      return reply.code(503).send({
        status: "degraded",
        service: "planner-ts",
        ...readiness,
      });
    }
    return {
      status: "ready",
      service: "planner-ts",
      ...readiness,
    };
  });

  app.get("/health/deps", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const snapshot = dependencyHealthMonitor.snapshot();
    const code = snapshot.status === "ok" ? 200 : 503;
    return reply.code(code).send({
      service: "planner-ts",
      ...snapshot,
    });
  });

  app.get("/metrics", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.header("Content-Type", promRegistry.contentType);
    return promRegistry.metrics();
  });

  app.get("/health/authz-events", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      status: "ok",
      service: "planner-ts",
      auth: {
        engine: authzPolicyEngine.engineName,
        recentEvents: authzPolicyEngine.getStats().recentEvents
      }
    };
  });

  app.get("/health/failures", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      status: "ok",
      service: "planner-ts",
      failures: failureStore.top(50),
    };
  });

  app.get("/debug/retrieval-config", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      embedder_url: config.SYNESIS_EMBEDDER_URL ? "configured" : "not_set",
      nornic_uri: config.SYNESIS_NORNIC_URI ? "configured" : "not_set",
      nornic_database: config.SYNESIS_NORNIC_DATABASE,
      nornic_runtime_profile: config.SYNESIS_NORNIC_RUNTIME_PROFILE,
      web_search_enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
      web_search_url: config.SYNESIS_WEB_SEARCH_URL ? "configured" : "not_set",
      unified_retrieval_client_registered: isRetrievalClientRegistered(),
      cohesion_lock_enabled: config.SYNESIS_COHESION_LOCK_ENABLED,
      gliner_service_url: config.SYNESIS_GLINER_SERVICE_URL ? "configured" : "not_set",
      rag_strategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
      bge_reranker: config.SYNESIS_BGE_RERANKER_URL ? "configured" : "not_set",
    };
  });

  app.get("/debug/session-stats", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || !timingSafeTokenMatch(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      session_enabled: config.SYNESIS_PLANNER_TS_SESSION_ENABLED,
      session_backend: config.SYNESIS_PLANNER_TS_REDIS_URL ? "redis" : "memory",
      session_ttl_s: config.SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S,
    };
  });

  // -----------------------------------------------------------------------
  // Knowledge retrieval — SynPack v2 resolver, bundles, and structured search
  // -----------------------------------------------------------------------
  async function authorizeKnowledgeRoute(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown> | null,
  ): Promise<{ auth: AuthContext; scope: ScopeFilterOptions; authzTraceId: string } | null> {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!await isSearchRouteAuthorized(
      request.headers.authorization,
      token,
      config.SYNESIS_PAT_PEPPER,
    )) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);

    let auth: AuthContext;
    try {
      auth = await resolveAuthContext(request, config);
    } catch (err) {
      const statusCode = (err as ErrorWithMeta).statusCode ?? 401;
      void reply.code(statusCode).send({
        error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        authz_trace_id: authzTraceId,
      });
      return null;
    }

    const bodyScopeHintsIgnored = hasCallerScopeHints(body);
    const scope = deriveKnowledgeSearchScope(auth, body, config, authzTraceId);
    if (bodyScopeHintsIgnored) {
      request.log.warn({
        authz_trace_id: authzTraceId,
        auth_method: auth.authMethod,
        trusted_forwarded_identity: auth.trustedForwardedIdentity,
        ignored_fields: [
          "caller_org_id",
          "caller_tenant_ids",
          "caller_acl_groups",
          "caller_user_id",
        ].filter((key) => body?.[key] !== undefined),
      }, "knowledge_route_body_scope_ignored");
    }

    return { auth, scope, authzTraceId };
  }

  app.post(
    "/v1/knowledge/resolve-pack",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
      const rawBody = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : null;
      const authorized = await authorizeKnowledgeRoute(request, reply, rawBody);
      if (!authorized) return reply;
      const body = parseKnowledgeRouteBody(request, reply);
      if (!body) return reply;
      const query = optionalString(body?.query) ?? "";
      const hasResolverInput = Boolean(query || body?.language || body?.domain || body?.package_name || body?.symbol);
      if (!hasResolverInput) {
        return reply.code(400).send({ error: "query, language, domain, package_name, or symbol is required" });
      }
      const started = performance.now();
      const result = await resolvePacks({
        query,
        domain: optionalString(body?.domain),
        content_type: optionalString(body?.content_type),
        language: optionalString(body?.language),
        package_name: optionalString(body?.package_name),
        symbol: optionalString(body?.symbol ?? body?.symbol_fqn ?? body?.symbol_name),
        version: optionalString(body?.version ?? body?.pack_version),
        top_k: Number(body?.top_k) || 5,
      }, knowledgeSearchRagConfig, authorized.scope);
      return {
        ...result,
        authz_trace_id: authorized.authzTraceId,
        authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
        timings: { total_ms: Math.round((performance.now() - started) * 10) / 10 },
      };
    },
  );

  app.post(
    "/v1/knowledge/bundle",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
      const rawBody = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : null;
      const authorized = await authorizeKnowledgeRoute(request, reply, rawBody);
      if (!authorized) return reply;
      const body = parseKnowledgeRouteBody(request, reply);
      if (!body) return reply;
      const query = String(body?.query ?? "").trim();
      if (!query) {
        return reply.code(400).send({ error: "query is required" });
      }
      const bundle = await retrieveKnowledgeBundle({
        query,
        topK: Math.min(Math.max(Number(body?.top_k) || 8, 1), 30),
        packId: optionalString(body?.pack_id),
        topic: optionalString(body?.topic),
        symbol: optionalString(body?.symbol ?? body?.symbol_fqn ?? body?.symbol_name),
        task: optionalString(body?.task),
        version: optionalString(body?.version ?? body?.version_preference ?? body?.pack_version),
        language: optionalString(body?.language),
        domain: optionalString(body?.domain),
        contentType: optionalString(body?.content_type),
        packageName: optionalString(body?.package_name),
        artifactKind: optionalString(body?.artifact_kind),
        includeExamples: body?.include_examples !== false,
        includeAntipatterns: body?.include_antipatterns !== false,
        includeContextCards: body?.include_context_cards !== false,
        includePackCards: body?.include_pack_cards !== false,
        routingMode: optionalRoutingMode(body?.routing_mode),
        metadata: metadataFromKnowledgeBody(body),
        graphDepth: Number(body?.graph_depth) || undefined,
        edgeTypes: stringArrayBody(body?.edge_types),
      }, knowledgeSearchRagConfig, authorized.scope);
      return {
        ...bundle,
        authz_trace_id: authorized.authzTraceId,
        authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
      };
    },
  );

  app.post(
    "/v1/knowledge/search",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    // codeql[js/missing-rate-limiting]
    async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!await isSearchRouteAuthorized(
      request.headers.authorization,
      token,
      config.SYNESIS_PAT_PEPPER,
    )) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);

    let auth: AuthContext;
    try {
      auth = await resolveAuthContext(request, config);
    } catch (err) {
      const statusCode = (err as ErrorWithMeta).statusCode ?? 401;
      return reply.code(statusCode).send({
        error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        authz_trace_id: authzTraceId,
      });
    }

    const rawBody = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : null;
    const body = parseKnowledgeRouteBody(request, reply);
    if (!body) return reply;
    const query = String(body?.query ?? "").trim();
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }

    const topK = Math.min(Math.max(Number(body?.top_k) || 5, 1), 50);

    const metaParams = metadataFromKnowledgeBody(body);

    const bodyScopeHintsIgnored = hasCallerScopeHints(rawBody);
    const scopeOpts = deriveKnowledgeSearchScope(auth, body, config, authzTraceId);
    if (bodyScopeHintsIgnored) {
      request.log.warn({
        authz_trace_id: authzTraceId,
        auth_method: auth.authMethod,
        trusted_forwarded_identity: auth.trustedForwardedIdentity,
        ignored_fields: [
          "caller_org_id",
          "caller_tenant_ids",
          "caller_acl_groups",
          "caller_user_id",
        ].filter((key) => rawBody?.[key] !== undefined),
      }, "knowledge_search_body_scope_ignored");
    }

    const mode = String(body?.mode ?? "").trim();
    if (mode === "bundle" || mode === "cards") {
      const bundle = await retrieveKnowledgeBundle({
        query,
        topK,
        packId: optionalString(body?.pack_id),
        topic: optionalString(body?.topic),
        symbol: optionalString(body?.symbol ?? body?.symbol_fqn ?? body?.symbol_name),
        task: optionalString(body?.task),
        version: optionalString(body?.version ?? body?.version_preference ?? body?.pack_version),
        language: optionalString(body?.language),
        domain: optionalString(body?.domain),
        contentType: optionalString(body?.content_type),
        packageName: optionalString(body?.package_name),
        artifactKind: optionalString(body?.artifact_kind),
        includeExamples: body?.include_examples !== false,
        includeAntipatterns: body?.include_antipatterns !== false,
        includeContextCards: body?.include_context_cards !== false,
        includePackCards: body?.include_pack_cards !== false,
        routingMode: optionalRoutingMode(body?.routing_mode),
        metadata: metaParams,
        graphDepth: Number(body?.graph_depth) || undefined,
        edgeTypes: stringArrayBody(body?.edge_types),
      }, knowledgeSearchRagConfig, scopeOpts);
      return {
        ...bundle,
        results: mode === "cards" ? bundle.context_cards : bundle.source_chunks,
        total: mode === "cards" ? bundle.context_cards.length : bundle.source_chunks.length,
        authz_trace_id: authzTraceId,
        authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
      };
    }

    const metaFilter = buildMetadataFilterFn(metaParams);

    const t0 = performance.now();
    try {
      const results = await retrieveContextFn(query, knowledgeSearchRagConfig, {
        topK,
        scopeFilter: scopeOpts,
        metadata: metaParams,
        graphDepth: Number(body?.graph_depth) || undefined,
        edgeTypes: Array.isArray(body?.edge_types) ? (body.edge_types as string[]) : undefined,
        version: body?.version ? String(body.version) : undefined,
        commit: body?.commit ? String(body.commit) : undefined,
        branch: body?.branch ? String(body.branch) : undefined,
        temporalAt: body?.temporal_at ? String(body.temporal_at) : undefined,
      });
      const totalMs = performance.now() - t0;

      const mapped: import("./retrieval/types.js").KnowledgeResult[] = results.map((r) => {
        const tagMeta = extractTagMetadataFn(r.tags ?? "");
        const scopeTagsStr = r.scope_tags ?? "";
        const scopeFromCol = scopeTagsStr ? scopeTagsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];
        return {
          text: r.text,
          source_url: r.source_url,
          search_backend: r.retrieval_source,
          chunk_id: r.chunk_id ?? "",
          doc_id: r.doc_id ?? "",
          document_name: r.document_name,
          authority: r.authority,
          pack_id: r.pack_id ?? "global",
          pack_version: r.pack_version ?? "",
          pack_source_version: r.pack_source_version ?? "",
          pack_partition: r.pack_partition ?? "",
          symbol_kind: r.symbol_kind ?? "",
          symbol_fqn: r.symbol_fqn ?? "",
          symbol_name: r.symbol_name ?? "",
          package_name: r.package_name ?? "",
          doc_relation_ids: r.doc_relation_ids ? r.doc_relation_ids.split(",").map((s) => s.trim()).filter(Boolean) : [],
          agent_hook: r.agent_hook ?? "",
          perf_tier: r.perf_tier ?? "",
          safety_contract: r.safety_contract ?? "",
          lifecycle_model: r.lifecycle_model ?? "",
          agent_enrichment_json: r.agent_enrichment_json ?? "",
          origin_type: r.origin_type,
          source_type: r.source_type ?? "",
          handler: r.handler ?? "",
          domain: r.domain,
          language: r.language ?? "",
          artifact_kind: r.artifact_kind ?? "",
          content_format: r.content_format ?? "",
          repo_path: r.repo_path ?? "",
          module_path: r.module_path ?? "",
          tags: r.tags ?? "",
          context_prefix: r.context_prefix,
          chunk_summary: r.chunk_summary,
          heading_path: r.heading_path,
          score: r.rerank_score > 0 ? r.rerank_score : r.rrf_score,
          constraint_kind: r.constraint_kind || tagMeta.constraint_kind,
          corpus_class: r.corpus_class || tagMeta.corpus_class,
          scope_tags: scopeFromCol.length > 0 ? scopeFromCol : tagMeta.scope_tags,
          content_profile: r.content_profile || tagMeta.content_profile,
          constraint_source: r.constraint_source ?? "",
          constraint_confidence: r.constraint_confidence ?? -1,
          golden_path_id: r.golden_path_id ?? "",
          novel_pattern: r.novel_pattern ?? false,
          has_code: r.has_code ?? false,
          code_signal_count: r.code_signal_count ?? 0,
          code_density: r.code_density ?? 0,
          code_language: r.code_language ?? "",
          scan_status: r.scan_status ?? "unscanned",
          approval_status: r.approval_status ?? "auto_approved",
        };
      });

      request.log.info({
        knowledge_search: true,
        query_len: query.length,
        results_count: mapped.length,
        filter_applied: metaFilter || null,
        total_ms: Math.round(totalMs * 10) / 10,
        authz_trace_id: authzTraceId,
        authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
        auth_scope_source: scopeOpts.trustedScopeSource,
      }, "knowledge_search_complete");

      return {
        results: mapped,
        query,
        total: mapped.length,
        authz_trace_id: authzTraceId,
        authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
        timings: {
          embed_ms: 0,
          search_ms: Math.round(totalMs * 10) / 10,
          rerank_ms: 0,
          total_ms: Math.round(totalMs * 10) / 10,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err: msg }, "knowledge_search_failed");
      return reply.code(500).send({ error: "Knowledge search failed", detail: "Internal error" });
    }
    },
  );

  // -----------------------------------------------------------------------
  // Web search — planner-owned route for MCP/Yarn/OpenWebUI attribution
  // -----------------------------------------------------------------------
  app.post(
    "/v1/web/search",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    // codeql[js/missing-rate-limiting]
    async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!await isSearchRouteAuthorized(
      request.headers.authorization,
      token,
      config.SYNESIS_PAT_PEPPER,
    )) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = parseWebSearchRouteBody(request, reply);
    if (!body) return reply;
    if (!config.SYNESIS_WEB_SEARCH_ENABLED || !config.SYNESIS_WEB_SEARCH_URL) {
      const attribution: WebSearchAttribution = {
        source_surface: "planner_internal",
        tool_name: "synesis_web_search",
      };
      await persistWebSearchLog(
        { adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL, logger: app.log },
        {
          query: "",
          profile: "web",
          results: [],
          latencyMs: 0,
          outcome: "error",
          policyAction: "deny",
          blockedReason: "web_search_disabled",
          attribution,
          errorMessage: "web search disabled",
        },
      );
      return reply.code(503).send({
        error: "web_search_disabled",
        policy: { action: "deny", reason: "web_search_disabled" },
      });
    }

    const query = String(body.query ?? "").trim();
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }

    const topK = Math.min(Math.max(Number(body.top_k ?? 8) || 8, 1), 20);
    const profile = body.profile === "code" ? "code" : "web";
    const attribution: WebSearchAttribution = {
      source_surface: normalizeSourceSurface(body.source_surface),
      tool_name: optionalString(body.tool_name) ?? "synesis_web_search",
      request_id: optionalString(body.request_id),
      session_key: optionalString(body.session_key),
      conversation_id: optionalString(body.conversation_id),
      trace_id: optionalString(body.trace_id),
      caller_org_id: optionalString(body.caller_org_id),
      caller_user_id: optionalString(body.caller_user_id),
      caller_tenant_ids: Array.isArray(body.caller_tenant_ids) ? body.caller_tenant_ids.map(String) : undefined,
    };

    const started = performance.now();
    try {
      const searchResults = await searchAndProcess(
        query,
        {
          url: config.SYNESIS_WEB_SEARCH_URL,
          enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
          timeoutMs: config.SYNESIS_WEB_SEARCH_TIMEOUT_MS,
          maxResults: topK,
          engineAuthorityMap: (() => {
            try {
              return JSON.parse(config.SYNESIS_ENGINE_AUTHORITY_MAP || "{}");
            } catch {
              return {};
            }
          })(),
        },
        {
          profile,
          fetchPages: body.fetch_pages ?? true,
          maxFetchPages: Number(body.max_fetch_pages ?? 2) || 2,
          minRelevance: Number(body.min_relevance ?? 0.5) || 0.5,
          attribution,
        },
      );
      const results = applyWebSearchDomainPolicy(
        searchResults,
        body.preferred_domains,
        config.SYNESIS_DOMAIN_POLICY_MODE,
        config.SYNESIS_DOMAIN_POLICY_BOOST,
      );

      const totalMs = Math.round((performance.now() - started) * 10) / 10;
      const response: WebSearchResponse = {
        query,
        total: results.length,
        results: results.slice(0, topK),
        timings: { total_ms: totalMs },
        attribution_echo: attribution,
        policy: {
          action: "allow",
        },
      };
      request.log.info(
        {
          web_search: true,
          query_len: query.length,
          total: response.total,
          latency_ms: totalMs,
          source_surface: attribution.source_surface,
          tool_name: attribution.tool_name,
          request_id: attribution.request_id,
          trace_id: attribution.trace_id,
        },
        "web_search_complete",
      );
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const totalMs = Math.round((performance.now() - started) * 10) / 10;
      await persistWebSearchLog(
        { adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL, logger: app.log },
        {
          query,
          profile,
          results: [],
          latencyMs: totalMs,
          outcome: "error",
          policyAction: "degraded",
          blockedReason: "planner_web_search_error",
          attribution,
          errorMessage: message,
        },
      );
      request.log.error({ err: message }, "web_search_failed");
      return reply.code(500).send({
        error: "Web search failed",
        detail: message,
        attribution_echo: attribution,
        policy: { action: "degraded", reason: "planner_web_search_error" },
      });
    }
    },
  );

  app.get(
    "/v1/models",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 300, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
      try {
        await resolveAuthContext(request, config);
      } catch {
        return reply.code(401).send({ error: { message: "Authentication required", type: "auth_error" } });
      }
      return {
        object: "list",
        data: listModelIds(config).map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "synesis"
        }))
      };
    },
  );

  app.delete(
    "/v1/memory/:conversationId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 60, timeWindow: "1 minute" }),
    },
    // codeql[js/missing-rate-limiting]
    async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    try {
      const preAuthSubject = `preauth:${(request.ip || "unknown").trim() || "unknown"}:memory-purge`;
      const preAuthRateLimit = userRateLimiter.check(preAuthSubject);
      if (!preAuthRateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = preAuthRateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const auth = await resolveAuthContext(request, config);
      const rateSubject = (auth.userId || auth.userEmail || "anonymous").trim() || "anonymous";
      const rateLimit = userRateLimiter.check(rateSubject);
      if (!rateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = rateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const policyDecision = await authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
        traceId: authzTraceId
      });
      reply.header("x-synesis-authz-rules", policyDecision.matchedRules.join(","));
      const { conversationId } = request.params as { conversationId: string };
      if (!conversationId?.trim()) {
        return reply.code(400).send({
          error: { message: "conversation_id is required", type: "invalid_request_error", code: "400" }
        });
      }
      const normalizedConversationId = conversationId.trim();
      const scopedSession = resolvePlannerSessionKey(
        { conversation_id: normalizedConversationId },
        authzTraceId,
        auth,
      );
      const deletedScoped = await sessionManager.purge(scopedSession.sessionKey);
      const mayPurgeLegacyGlobal =
        auth.authMethod === "internal_service" ||
        auth.role === "platform_admin" ||
        auth.role === "org_admin";
      let deletedLegacy = false;
      if (mayPurgeLegacyGlobal) {
        for (const legacyKey of legacyPlannerConversationSessionKeys(normalizedConversationId)) {
          deletedLegacy = (await sessionManager.purge(legacyKey)) || deletedLegacy;
        }
      }
      const deleted = deletedScoped || deletedLegacy;
      request.log.info(
        {
          authzTraceId,
          conversationId: normalizedConversationId,
          userId: auth.userId,
          sessionKey: scopedSession.sessionKey,
          legacyGlobalPurge: mayPurgeLegacyGlobal,
          deleted
        },
        "memory purge"
      );
      return { deleted, conversation_id: normalizedConversationId, authz_trace_id: authzTraceId };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown server error";
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn({ authzTraceId, errorMessage: rawMessage }, "memory purge rejected");
      const statusCode = err.statusCode ?? (rawMessage === "Missing Bearer token" ? 401 : 400);
      const clientMessage = sanitizeErrorMessage(rawMessage);
      return reply.code(statusCode).send({
        error: {
          message: clientMessage,
          type: statusCode === 401
            ? "authentication_error"
            : statusCode === 403
              ? "permission_error"
              : "invalid_request_error",
          code: String(statusCode)
        }
      });
    }
    },
  );

  function countAssumptionTags(text: string): TraceSensemaking["assumption_tags_applied"] {
    return {
      assumption: (text.match(/\[Assumption[:\]]/g) ?? []).length,
      estimate: (text.match(/\[Estimate[:\]]/g) ?? []).length,
      clarified: (text.match(/\[Clarified[\]]/g) ?? []).length,
    };
  }

  function buildSensemakingTrace(state: GraphState): TraceSensemaking {
    return {
      domain_profile: state.domain_profile,
      task_frame: state.task_frame,
      planner_confidence: state.planner_confidence ?? 0,
      clarification_triggered: Boolean(state.clarification_question),
      clarification_question: state.clarification_question,
      clarification_options: state.clarification_options,
      assumptions: state.assumptions ?? [],
      frame_coherence: state.domain_profile?.frameCoherence ?? "unknown",
      assumption_tags_applied: countAssumptionTags(state.generated_code ?? ""),
    };
  }

  function buildClassificationTrace(state: GraphState): TraceClassification {
    const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
    const riskScoreRaw = state.risk_score ?? 0;
    return {
      difficulty: state.difficulty ?? 0,
      task_size: state.task_size ?? "unknown",
      risk_score: Math.max(0, Math.min(1, riskScoreRaw / 100)),
      effort_mode: state.selected_effort_mode ?? state.recommended_effort_mode ?? "auto",
      model_tier: state.model_tier ?? "auto",
      rag_mode: state.rag_mode ?? "disabled",
      plan_required: state.plan_required ?? false,
      show_assumptions: state.show_assumptions ?? false,
      taxonomy_key: String(taxonomy.taxonomy_key ?? "unknown"),
      cynefin_domain: state.cynefin_domain,
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
    };
  }

  function buildInlineCriticTrace(state: GraphState): TraceCriticResult | undefined {
    if (!state.critic_scores) return undefined;
    return {
      approved: state.critic_approved ?? false,
      need_more_evidence: state.need_more_evidence ?? false,
      scores: state.critic_scores ?? {},
      blocking_issues: state.blocking_issues ?? [],
      nonblocking: state.critic_nonblocking ?? [],
      is_background: false,
    };
  }

  function buildEvidenceSummary(state: GraphState): Record<string, unknown> {
    const packets = state.evidence_packets ?? [];
    if (packets.length === 0) return {};
    const sourceUris = packets.flatMap((p) => p.sources.map((s) => s.uri)).filter(Boolean);
    const avgConfidence = packets.reduce((sum, p) => sum + p.confidence, 0) / packets.length;
    return {
      packets_count: packets.length,
      avg_confidence: Math.round(avgConfidence * 100) / 100,
      source_urls: [...new Set(sourceUris)].slice(0, 10),
    };
  }

  function buildTaxonomy(state: GraphState): Record<string, unknown> {
    const classification = buildClassificationTrace(state);
    const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;

    // Discovery: how the taxonomy key was resolved
    const discovery: Record<string, unknown> = {
      taxonomy_key: String(taxonomy.taxonomy_key ?? "unknown"),
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
      active_domains: taxonomy.active_domains,
      domain_ref_counts: taxonomy.domain_ref_counts,
    };
    if (taxonomy.taxonomy_semantic) {
      discovery.semantic_validation = taxonomy.taxonomy_semantic;
    }

    // Prompt steering: which taxonomy/vertical blocks were injected
    const steeringApplied: string[] = [];
    const difficulty = state.difficulty ?? 0;
    const complexity = Number(taxonomy.complexity_score ?? 0);
    if (complexity > 0.55 && String(taxonomy.depth_instructions ?? "").trim()) steeringApplied.push("depth_instructions");
    if (String(taxonomy.output_style_guidance ?? "").trim()) steeringApplied.push("output_style_guidance");
    if (difficulty >= 0.5 && String(taxonomy.calibration_guidance ?? "").trim()) steeringApplied.push("calibration_guidance");
    if (difficulty >= 0.4 && String(taxonomy.discovery_prompt ?? "").trim()) steeringApplied.push("discovery_prompt");
    if (difficulty >= 0.5 && Array.isArray(taxonomy.required_elements) && taxonomy.required_elements.length > 0) steeringApplied.push("required_elements");
    if (String(taxonomy.writer_regulated_block ?? "").trim()) steeringApplied.push("writer_regulated_block");
    if (String(taxonomy.critic_regulated_block ?? "").trim()) steeringApplied.push("critic_regulated_block");

    const activeVertical = String(taxonomy.active_vertical ?? "generic");
    if (activeVertical !== "generic") {
      steeringApplied.push(`vertical:${activeVertical}`);
      // critic_mode from vertical
      const criticMode = taxonomy._critic_mode ?? undefined;
      if (criticMode) {
        discovery.critic_mode = criticMode;
      }
    }

    return {
      difficulty: classification.difficulty,
      task_size: classification.task_size,
      risk_score: classification.risk_score,
      effort_mode: classification.effort_mode,
      model_tier: classification.model_tier,
      rag_mode: classification.rag_mode,
      plan_required: classification.plan_required,
      taxonomy_key: String(taxonomy.taxonomy_key ?? classification.taxonomy_key),
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
      discovery,
      steering_applied: steeringApplied,
    };
  }

  function extractCitedSourceUrls(draft: string): Set<string> {
    const cited = new Set<string>();
    for (const line of draft.split("\n")) {
      const sourceIndex = line.indexOf("[Source:");
      if (sourceIndex === -1) continue;
      const bracketUrlIndex = line.indexOf("[http", sourceIndex);
      const bareUrlIndex = line.indexOf("http", sourceIndex);
      const urlStart = bracketUrlIndex >= 0 ? bracketUrlIndex + 1 : bareUrlIndex;
      if (urlStart < 0) continue;
      const tail = line.slice(urlStart, urlStart + 2048);
      const spaceIndex = tail.search(/\s/);
      const closeIndex = tail.indexOf("]");
      const endCandidates = [spaceIndex, closeIndex].filter((idx) => idx >= 0);
      const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : tail.length;
      const url = tail.slice(0, endIndex).trim().toLowerCase();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        cited.add(url);
      }
    }
    return cited;
  }

  function countHallucinatedUrls(state: GraphState): number {
    const draft = state.generated_code ?? "";
    if (!draft) return 0;
    const packets = state.evidence_packets ?? [];
    const validUris = new Set<string>();
    for (const packet of packets) {
      for (const source of packet.sources) {
        if (source.uri) validUris.add(source.uri.trim().toLowerCase());
      }
    }
    if (validUris.size === 0) return 0;
    const cited = extractCitedSourceUrls(draft);
    if (cited.size === 0) return 0;
    let count = 0;
    for (const url of cited) {
      if (!validUris.has(url)) count++;
    }
    return count;
  }

  function buildContextCuration(state: GraphState): Record<string, unknown> | undefined {
    const packets = state.evidence_packets ?? [];
    const effective = state.writer_max_tokens ?? 0;
    const target = state.writer_budget_target ?? effective;
    if (packets.length === 0 && !effective && !target) return undefined;
    const cfg = loadConfig();
    const totalSnippets = packets.reduce((s, p) => s + (p.snippets?.length ?? 0), 0);
    const totalChars = packets.reduce((s, p) =>
      s + (p.snippets ?? []).reduce((c, sn) => c + (sn.text?.length ?? 0), 0), 0);
    const completionTokens = state.llm_usage?.completion_tokens ?? 0;
    const utilizationVsEffective = effective > 0 ? completionTokens / effective : 0;
    const utilizationVsTarget = target > 0 ? completionTokens / target : 0;
    const lowUtilization = effective > 0 && utilizationVsEffective < 0.15;
    const budgetAlert =
      effective > 0 && utilizationVsEffective > 0.95
        ? `Writer used ${Math.round(utilizationVsEffective * 100)}% of ${effective} effective token cap — potential truncation`
        : undefined;
    const budgetNote =
      cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE === "audit" &&
      target > 0 &&
      effective > target &&
      utilizationVsTarget > 0.95 &&
      utilizationVsEffective <= 0.95
        ? `Policy target ${target} tokens fully used; audit floor (${effective}) prevented output truncation`
        : undefined;
    return {
      packets_in: packets.length,
      packets_kept: packets.length,
      excluded_count: 0,
      budget_mode: cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE,
      token_budget_target: target,
      token_budget_effective: effective,
      token_budget: effective,
      tokens_used: completionTokens,
      utilization: Number(utilizationVsEffective.toFixed(4)),
      utilization_vs_target: target > 0 ? Number(utilizationVsTarget.toFixed(4)) : undefined,
      utilization_vs_effective: effective > 0 ? Number(utilizationVsEffective.toFixed(4)) : undefined,
      chars_used: totalChars,
      snippets_total: totalSnippets,
      low_utilization: lowUtilization,
      ...(budgetAlert ? { budget_alert: budgetAlert } : {}),
      ...(budgetNote ? { budget_note: budgetNote } : {}),
    };
  }

  function buildTraceContext(state: GraphState): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    if (state.writer_max_tokens) ctx.token_budget_total = state.writer_max_tokens;
    if (state.writer_budget_target !== undefined) ctx.token_budget_target = state.writer_budget_target;
    if (state.risk_score !== undefined) ctx.risk_score_raw = state.risk_score;
    if (state.iteration_count !== undefined) ctx.iteration_count = state.iteration_count;
    if (state.max_iterations !== undefined) ctx.max_iterations = state.max_iterations;
    if (state.error) {
      ctx.failure_stage = state.next_node ?? "unknown";
      ctx.failure_reason = state.error;
    }
    const capabilityMatrix = (state.execution_policy as Record<string, unknown> | undefined)?.capability_matrix;
    if (capabilityMatrix && typeof capabilityMatrix === "object" && !Array.isArray(capabilityMatrix)) {
      const matrix = capabilityMatrix as Record<string, unknown>;
      ctx.capability_matrix_mode = matrix.mode;
      ctx.capability_matrix_global_optimizations_enabled = matrix.global_optimizations_enabled;
      ctx.capability_matrix_hash = matrix.capability_hash;
      ctx.capability_matrix_model_id = matrix.model_id;
      ctx.capability_matrix_family = matrix.family;
      ctx.capability_matrix_matched_override_ids = matrix.matched_override_ids;
    }
    if (state.registry_writer_role) ctx.registry_writer_role = state.registry_writer_role;
    if (state.resolved_writer_model) {
      ctx.resolved_backend_model = state.resolved_writer_model;
      ctx.client_requested_model = state.requested_model;
    }
    if (state.planner_architecture_trace) {
      ctx.architecture_mediation = state.planner_architecture_trace;
    }
    return ctx;
  }

  function emitPlannerTrace(
    state: GraphState,
    usage: LlmUsage,
    latencyMs: number,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
    streamingCtx?: { mode: "streaming" | "non-streaming"; timeToFirstTokenMs?: number },
  ): void {
    const model = state.requested_model ?? state.response_model ?? "unknown";
    const writerRole = state.registry_writer_role ?? "writer";
    const rates = state.pricing_rates_by_role?.writer ?? pricingRegistry.getRates(writerRole);
    const collector = state._span_collector;
    const spans = collector?.getSpans() ?? [];
    const phaseTimings = collector?.getPhaseTimings() ?? {};

    const classification = buildClassificationTrace(state);
    const domainProfile = state.domain_profile;
    const domainTags = domainProfile?.domains?.map((d) => d.key) ?? [];
    const taxonomyKey = classification.taxonomy_key ?? "";
    const isCode = taxonomyKey.startsWith("code") || taxonomyKey.includes("programming");

    const inlineCritic = buildInlineCriticTrace(state);
    const hallucinatedUrlsCount = countHallucinatedUrls(state);
    const criticScores: Record<string, unknown> = inlineCritic
      ? { ...inlineCritic.scores, approved: inlineCritic.approved, hallucinated_urls_count: hallucinatedUrlsCount }
      : (hallucinatedUrlsCount > 0 ? { hallucinated_urls_count: hallucinatedUrlsCount } : {});

    const contextCuration = buildContextCuration(state);
    const trace: TraceRecord = {
      service: "planner",
      trace_id: state.authz_trace_id ?? crypto.randomUUID(),
      request_id: state.authz_trace_id ?? crypto.randomUUID(),
      authz_trace_id: state.authz_trace_id,
      conversation_id: state.conversation_id,
      timestamp: Date.now() / 1000,
      user_id: auth.userEmail || auth.userId,
      org_id: auth.orgId,
      tenant_id: auth.tenantIds?.[0] ?? "",
      model,
      query_snippet: state.task_description?.slice(0, 200) ?? "",
      tokens: usage,
      cost: {
        estimated_usd: usage.estimated_cost_usd,
        actual_usd: usage.actual_cost_usd,
        rates_snapshot: rates,
      },
      latency_ms: latencyMs,
      spans,
      phase_timings: phaseTimings,
      decision_ledger: state.decision_ledger,
      sensemaking: buildSensemakingTrace(state),
      task_frame: state.task_frame,
      classification,
      critic_result: inlineCritic,
      critic_scores: Object.keys(criticScores).length > 0 ? criticScores : undefined,
      evidence_summary: buildEvidenceSummary(state),
      taxonomy: buildTaxonomy(state),
      trace_context: buildTraceContext(state),
      difficulty: classification.difficulty,
      task_type: taxonomyKey || undefined,
      domain_tags: domainTags.length > 0 ? domainTags : undefined,
      is_code_task: isCode,
      has_error: Boolean(state.error),
      iteration_count: state.iteration_count,
      max_iterations: state.max_iterations,
      streaming: streamingCtx
        ? { mode: streamingCtx.mode, time_to_first_token_ms: streamingCtx.timeToFirstTokenMs }
        : undefined,
      ...(contextCuration ? { context_curation: contextCuration } : {}),
    };
    emitTrace(trace, traceEmitterConfig, app.log);
  }

  function emitPlannerUsageMeteringRow(
    state: GraphState,
    usage: LlmUsage,
    latencyMs: number,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
  ): void {
    const model = state.requested_model ?? state.response_model ?? "unknown";
    const requestId = state.authz_trace_id ?? "";
    if (!requestId) return;
    const writerRole = state.registry_writer_role ?? "writer";
    const rates = state.pricing_rates_by_role?.writer ?? pricingRegistry.getRates(writerRole);
    emitPlannerUsageMetering(
      {
        request_id: requestId,
        user_id: auth.userEmail || auth.userId,
        org_id: auth.orgId,
        tenant_id: auth.tenantIds?.[0] ?? "",
        conversation_id: state.conversation_id,
        model,
        tokens: usage,
        estimated_cost_usd: usage.estimated_cost_usd,
        actual_cost_usd: usage.actual_cost_usd,
        pricing_source: "registry",
        auth_method: auth.authMethod,
        auth_key_id: auth.authKeyId ?? "",
        auth_key_name: auth.authKeyName ?? "",
        auth_key_prefix: auth.authKeyPrefix ?? "",
        rates_snapshot: rates,
        latency_ms: latencyMs,
        has_error: Boolean(state.error),
      },
      traceEmitterConfig,
      app.log,
    );
  }

  app.post(
    "/v1/chat/completions",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" as const } },
      preHandler: createRouteRateLimit({ max: 300, timeWindow: "1 minute" }),
    },
    // codeql[js/missing-rate-limiting]
    async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    const inboundTraceparentHeader = request.headers["traceparent"];
    const inboundTraceparent = typeof inboundTraceparentHeader === "string" && inboundTraceparentHeader.trim().length > 0
      ? inboundTraceparentHeader.trim()
      : undefined;
    const requestSpan = getTracer().startSpan("planner.chat.completions", {
      "http.method": request.method,
      "http.route": "/v1/chat/completions",
    });
    requestSpan.setAttribute("planner.authz_trace_id", authzTraceId);
    if (inboundTraceparent) {
      requestSpan.setAttribute("planner.inbound_traceparent", inboundTraceparent);
    }
    const outboundTraceparent = inboundTraceparent ?? requestSpan.traceparent();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    let streamRelease: (() => void) | undefined;
    try {
      const preAuthSubject = `preauth:${(request.ip || "unknown").trim() || "unknown"}:chat-completions`;
      const preAuthRateLimit = userRateLimiter.check(preAuthSubject);
      if (!preAuthRateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = preAuthRateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      assertCapabilityLock();
      const auth = await resolveAuthContext(request, config);
      const rateSubject = (auth.userId || auth.userEmail || "anonymous").trim() || "anonymous";
      const rateLimit = userRateLimiter.check(rateSubject);
      if (!rateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = rateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const policyDecision = await authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
        traceId: authzTraceId
      });
      reply.header("x-synesis-authz-rules", policyDecision.matchedRules.join(","));
      request.log.info(
        {
          authzTraceId,
          authzEngine: authzPolicyEngine.engineName,
          authzRules: policyDecision.matchedRules,
          userId: auth.userId
        },
        "authz allow"
      );
      const rawBody = request.body;
      const body = ChatCompletionRequestSchema.parse(rawBody);
      const resolvedConversation = resolveIncomingConversationId(
        rawBody,
        request.headers as Record<string, unknown>,
        body.conversation_id,
      );
      const openWebUIEventMetadata = resolveOpenWebUIEventMetadata(
        rawBody,
        request.headers as Record<string, unknown>,
        resolvedConversation.id || body.conversation_id,
      );
      const effectiveBody: ParsedChatRequest = resolvedConversation.id
        ? { ...body, conversation_id: resolvedConversation.id }
        : body;
      if (resolvedConversation.id && !body.conversation_id) {
        request.log.info(
          { authzTraceId, userId: auth.userId, conversationSource: resolvedConversation.source },
          "resolved conversation_id from fallback source",
        );
      }
      requestSpan.setAttribute("planner.request.stream", Boolean(body.stream));
      requestSpan.setAttribute("planner.request.model", body.model);
      const resolvedSession = resolvePlannerSessionKey(effectiveBody, authzTraceId, auth);
      if (resolvedSession.source === "ephemeral_request") {
        request.log.warn(
          {
            authzTraceId,
            userId: auth.userId,
            model: body.model,
          },
          "conversation_id missing; using ephemeral planner session key (cross-turn memory/clarification continuity disabled)",
        );
      }
      const created = Math.floor(Date.now() / 1000);
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      if (body.stream) {
        const admission = await streamAdmission.acquire();
        if (!admission.admitted || !admission.release) {
          const err = new Error(`Stream admission denied: ${admission.reason ?? "capacity"}`) as ErrorWithMeta;
          err.statusCode = 503;
          err.retryAfterSeconds = admission.retryAfterSeconds ?? 5;
          throw err;
        }
        streamRelease = admission.release;
      }

      if (hasNativeToolTraffic(effectiveBody)) {
        const nativeReqStart = Date.now();
        const tierSettings = resolveTierSettings(effectiveBody.model);
        const generation = {
          ...(tierSettings.writer_generation_params ?? {}),
          ...requestGenerationParams(effectiveBody),
        };
        const responseModel = tierSettings.responseModel || effectiveBody.model;
        const writerModel =
          tierSettings.resolved_writer_model?.trim()
          || process.env.SYNESIS_PLANNER_TS_WRITER_MODEL
          || "synesis-writer";
        const nativeMessages = toOpenAICompatMessages(effectiveBody);
        const latestUser = [...effectiveBody.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const nativeRequest: OpenAICompatChatRequest = {
          model: writerModel,
          route: tierSettings.resolved_writer_route,
          messages: nativeMessages,
          stream: effectiveBody.stream,
          stream_options: effectiveBody.stream_options,
          ...generation,
          max_tokens: generation.max_tokens ?? tierSettings.writerMaxTokens,
          pricingRates: pricingRegistry.getRates(tierSettings.registry_writer_role ?? "writer"),
          request_id: completionId,
          authz_trace_id: authzTraceId,
          traceparent: outboundTraceparent,
          response_format: effectiveBody.response_format,
        };
        request.log.info(
          {
            authzTraceId,
            model: effectiveBody.model,
            responseModel,
            writerModel,
            stream: Boolean(effectiveBody.stream),
          },
          "native tool chat passthrough",
        );

        if (effectiveBody.stream) {
          const upstream = await chatCompletionOpenAICompatStream(nativeRequest);
          reply.raw.setHeader("x-synesis-authz-trace-id", authzTraceId);
          reply.raw.setHeader("x-synesis-run-id", completionId);
          await pipeOpenAICompatStream(reply, upstream);
          streamRelease?.();
          requestSpan.setStatus("ok");
          return reply;
        }

        const result = await chatCompletionOpenAICompat(nativeRequest);
        const usage = result.usage;
        const content = firstChoiceContent(result.body);
        const nativeState: GraphState = {
          messages: nativeMessages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : "",
          })),
          user_id: auth.userEmail || auth.userId,
          org_id: auth.orgId,
          tenant_ids: auth.tenantIds,
          token_scopes: auth.tokenScopes,
          acl_groups: auth.aclGroups,
          auth_method: auth.authMethod,
          conversation_id: effectiveBody.conversation_id ?? undefined,
          rag_authz_mode: config.SYNESIS_RAG_AUTHZ_MODE,
          authz_trace_id: authzTraceId,
          authz_engine: authzPolicyEngine.engineName,
          authz_rules: policyDecision.matchedRules,
          requested_model: tierSettings.requestedModel || effectiveBody.model,
          response_model: responseModel,
          registry_writer_role: tierSettings.registry_writer_role,
          resolved_writer_model: writerModel,
          resolved_writer_route: tierSettings.resolved_writer_route,
          model_tier: tierSettings.tier,
          task_description: latestUser,
          generated_code: content,
          llm_usage: usage,
          run_id: completionId,
          traceparent: outboundTraceparent,
        };
        const latencyMs = Date.now() - nativeReqStart;
        recordUsageMetrics(metrics, responseModel, tierSettings.tier, usage, latencyMs / 1000);
        emitPlannerTrace(nativeState, usage, latencyMs, auth, { mode: "non-streaming" });
        emitPlannerUsageMeteringRow(nativeState, usage, latencyMs, auth);
        requestSpan.setStatus("ok");
        return {
          ...result.body,
          model: typeof result.body.model === "string" ? result.body.model : responseModel,
          run_id: (result.body.run_id as string | undefined) ?? completionId,
          authz_trace_id: (result.body.authz_trace_id as string | undefined) ?? authzTraceId,
        };
      }

      const initialState = await toState(
        effectiveBody,
        request.headers as Record<string, unknown>,
        auth,
        authzTraceId,
        policyDecision,
        resolvedSession.sessionKey,
        outboundTraceparent,
      );
      const responseModel = initialState.response_model ?? body.model;

      const sessionKey = resolvedSession.sessionKey;

      if (!body.stream) {
        const reqStart = Date.now();
        const state = await invokeGraph(initialState);
        let content = state.generated_code ?? "";
        if (!content.trim()) {
          const fallback = state.error?.trim()
            ? `Something went wrong: ${state.error}`
            : EMPTY_ASSISTANT_FALLBACK;
          content = withSupportHandleHint(fallback, {
            authzTraceId: state.authz_trace_id,
            runId: state.run_id,
          });
        }

        if (config.SYNESIS_INJECTION_SCAN_ENABLED && content) {
          const outputScan = scanModelOutput(content);
          if (outputScan.detected) {
            request.log.warn(
              { authzTraceId, patterns: outputScan.patterns_found.slice(0, 5) },
              "output guardrail: possible injection compliance detected in model response"
            );
          }
        }

        const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        await sessionManager.recordTurn(sessionKey, latestUser ?? "", content);

        if (state.clarification_question) {
          await sessionManager.setPendingClarification(sessionKey, {
            question: state.clarification_question,
            options: state.clarification_options ?? [],
            assumptions: state.assumptions ?? [],
            originalTaskDescription: initialState.task_description,
          });
          if (!(effectiveBody.conversation_id ?? "").trim()) {
            request.log.warn(
              { authzTraceId, sessionSource: resolvedSession.source },
              "clarification_pending_stored_without_conversation_id",
            );
          }
        }

        spawnBackgroundCritic(state, request.log);
        const usage = state.llm_usage ?? ZERO_USAGE;
        const latencyS = (Date.now() - reqStart) / 1000;
        recordUsageMetrics(metrics, responseModel, initialState.model_tier ?? "auto", usage, latencyS);
        emitPlannerTrace(state, usage, Date.now() - reqStart, auth, { mode: "non-streaming" });
        emitPlannerUsageMeteringRow(state, usage, Date.now() - reqStart, auth);
        requestSpan.setStatus("ok");
        return {
          id: completionId,
          object: "chat.completion",
          created,
          model: state.response_model ?? body.model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              logprobs: null,
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_prompt_tokens: usage.cached_prompt_tokens,
            estimated_cost_usd: usage.estimated_cost_usd,
            actual_cost_usd: usage.actual_cost_usd
          },
          run_id: state.run_id,
          authz_trace_id: state.authz_trace_id
        };
      }

      const streamReqStart = Date.now();
      let firstTokenAt: number | undefined;
      const emitLegacyStreamStatus = config.SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS === "openwebui-data";
      reply.header("x-synesis-run-id", initialState.run_id ?? completionId);
      reply.raw.setHeader("x-synesis-authz-trace-id", authzTraceId);
      reply.raw.setHeader("x-synesis-run-id", initialState.run_id ?? completionId);
      initSse(reply.raw);
      reply.raw.once("close", () => {
        streamRelease?.();
      });
      writeAssistantRoleDelta(reply.raw, {
        id: completionId,
        created,
        model: responseModel,
        system_fingerprint: SYSTEM_FINGERPRINT,
      });
      const openWebUIContext = openWebUIContextFromConfig({
        config,
        chatId: openWebUIEventMetadata.chatId,
        messageId: openWebUIEventMetadata.messageId,
      });
      const hasOpenWebUIBaseUrl = Boolean(config.SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL.trim());
      const hasOpenWebUIEventToken = Boolean(config.SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN.trim());
      const hasOpenWebUIChatId = Boolean(openWebUIEventMetadata.chatId?.trim());
      const hasOpenWebUIMessageId = Boolean(openWebUIEventMetadata.messageId?.trim());
      const shouldDiagnoseOpenWebUIStatus =
        hasOpenWebUIBaseUrl ||
        hasOpenWebUIEventToken ||
        hasOpenWebUIChatId ||
        hasOpenWebUIMessageId ||
        emitLegacyStreamStatus;
      if (
        config.SYNESIS_PLANNER_TS_OPENWEBUI_EVENTS_ENABLED &&
        !openWebUIContext &&
        shouldDiagnoseOpenWebUIStatus
      ) {
        request.log.warn(
          {
            authzTraceId,
            hasBaseUrl: hasOpenWebUIBaseUrl,
            hasEventToken: hasOpenWebUIEventToken,
            hasChatId: hasOpenWebUIChatId,
            hasMessageId: hasOpenWebUIMessageId,
            metadataSources: openWebUIEventMetadata.sources,
            legacyStreamStatusEnabled: emitLegacyStreamStatus,
          },
          "openwebui status side-channel unavailable",
        );
      }
      const statusContext = {
        logger: request.log,
        authzTraceId,
        openWebUI: openWebUIContext,
        legacySse: {
          enabled: emitLegacyStreamStatus,
          response: reply.raw,
        },
      };
      const statusReporter: PlannerStatusReporter = (phase, status, detail, error) => {
        if (status === "done") {
          if (phase === "complete") {
            void emitPhaseDone(statusContext, phase, detail);
          }
        } else if (status === "error") {
          void emitPhaseError(statusContext, phase, error ?? detail ?? "unknown error");
        } else {
          void emitPhaseStarted(statusContext, phase, detail);
        }
      };
      const emitVisibleMilestone = (description: string, detail?: string) => {
        void emitStatus(statusContext, description, { detail, done: false });
      };
      void emitPhaseStarted(statusContext, "intake");
      if (emitLegacyStreamStatus) {
        writeReasoningDelta(reply.raw, {
          id: completionId,
          created,
          model: responseModel,
          reasoning_content: "[Synthesizing request]\n",
          system_fingerprint: SYSTEM_FINGERPRINT,
        });
      }

      const streamInitialState: GraphState = { ...initialState, _status_reporter: statusReporter };
      let finalState: GraphState = streamInitialState;
      let streamingError: Error | undefined;

      try {
        let writerStreamed = false;
        const writerDeltaHandler = (delta: import("./llm/client.js").StreamDelta) => {
          if (!isSseWritable(reply.raw)) return;
          if (!firstTokenAt && (delta.content || delta.reasoning_content)) {
            firstTokenAt = Date.now();
          }
          if (delta.content) {
            writerStreamed = true;
            writeContentDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              content: delta.content,
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
          if (emitLegacyStreamStatus && delta.reasoning_content) {
            writeReasoningDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              reasoning_content: delta.reasoning_content,
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
        };

        const directState = await directStreamPipeline(streamInitialState, writerDeltaHandler);
        const usedDirectPath = directState.next_node === "respond";

        if (usedDirectPath) {
          finalState = directState;
        } else {
          emitVisibleMilestone("Planning and gathering evidence...");
          if (emitLegacyStreamStatus && isSseWritable(reply.raw)) {
            writeReasoningDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              reasoning_content: "[Planning and gathering evidence — this may take a little while]\n",
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
          for await (const event of streamGraph(streamInitialState, writerDeltaHandler, {
            onNodeStart: (node) => {
              statusReporter(statusPhaseForGraphNode(node), "started");
            },
            onNodeDone: (node, state) => {
              const detail = state.error ? "Completed with fallback handling" : undefined;
              statusReporter(statusPhaseForGraphNode(node), "done", detail);
            },
          })) {
            if (!isSseWritable(reply.raw)) break;
            finalState = event.state;

            const nextNode = event.state.next_node;
            if (emitLegacyStreamStatus && event.node !== "respond") {
              writeReasoningDelta(reply.raw, {
                id: completionId,
                created,
                model: responseModel,
                reasoning_content: `[${describePhase(event.node)}]\n`,
                system_fingerprint: SYSTEM_FINGERPRINT,
              });

              if (nextNode && nextNode !== "respond") {
                const previewPhases: Record<string, string> = {
                  planner: "Thinking through the approach…",
                  router: "Searching sources…",
                  writer: "Writing response…",
                };
                const preview = previewPhases[nextNode];
                if (preview) {
                  emitVisibleMilestone(preview);
                  writeReasoningDelta(reply.raw, {
                    id: completionId,
                    created,
                    model: responseModel,
                    reasoning_content: `[${preview}]\n`,
                    system_fingerprint: SYSTEM_FINGERPRINT,
                  });
                }
              }
            }
          }
        }

        let content = finalState.generated_code ?? "";
        if (!content.trim() && !streamingError) {
          const fallback = finalState.error?.trim()
            ? `Something went wrong: ${finalState.error}`
            : EMPTY_ASSISTANT_FALLBACK;
          const filled = withSupportHandleHint(fallback, {
            authzTraceId: finalState.authz_trace_id,
            runId: finalState.run_id,
          });
          content = filled;
          finalState = { ...finalState, generated_code: filled };
        }

        // When the graph bypasses the writer (e.g. clarification → respond),
        // content is set in generated_code but never streamed. Emit it now.
        if (content && !writerStreamed && isSseWritable(reply.raw)) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          writeContentDelta(reply.raw, {
            id: completionId,
            created,
            model: responseModel,
            content,
            system_fingerprint: SYSTEM_FINGERPRINT,
          });
        }

        if (config.SYNESIS_INJECTION_SCAN_ENABLED && content) {
          const outputScan = scanModelOutput(content);
          if (outputScan.detected) {
            request.log.warn(
              { authzTraceId, patterns: outputScan.patterns_found.slice(0, 5) },
              "output guardrail: possible injection compliance detected in streamed response"
            );
          }
        }

        const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        await sessionManager.recordTurn(sessionKey, latestUser ?? "", content);

        if (finalState.clarification_question) {
          await sessionManager.setPendingClarification(sessionKey, {
            question: finalState.clarification_question,
            options: finalState.clarification_options ?? [],
            assumptions: finalState.assumptions ?? [],
            originalTaskDescription: initialState.task_description,
          });
          if (!(effectiveBody.conversation_id ?? "").trim()) {
            request.log.warn(
              { authzTraceId, sessionSource: resolvedSession.source },
              "clarification_pending_stored_without_conversation_id",
            );
          }
        }

        spawnBackgroundCritic(finalState, request.log);
        statusReporter("complete", "done");
      } catch (err) {
        streamingError = err instanceof Error ? err : new Error(String(err));
        failureStore.record("streaming_graph", "execution_error", streamingError.message);
        request.log.error(
          { authzTraceId, error: streamingError.message },
          "streaming graph execution failed",
        );
        statusReporter("error", "error", undefined, streamingError);
        if (isSseWritable(reply.raw)) {
          writeContentDelta(reply.raw, {
            id: completionId,
            created,
            model: responseModel,
            content: `\n\n${withSupportHandleHint(
              "An error occurred while processing your request. Please try again.",
              {
                authzTraceId,
                runId: finalState.run_id,
              },
            )}`,
            system_fingerprint: SYSTEM_FINGERPRINT,
          });
        }
      }

      const streamUsage = finalState.llm_usage ?? ZERO_USAGE;
      const streamLatencyS = (Date.now() - streamReqStart) / 1000;
      recordUsageMetrics(metrics, responseModel, initialState.model_tier ?? "auto", streamUsage, streamLatencyS);
      emitPlannerTrace(finalState, streamUsage, Date.now() - streamReqStart, auth, {
        mode: "streaming",
        timeToFirstTokenMs: firstTokenAt ? firstTokenAt - streamReqStart : undefined,
      });
      emitPlannerUsageMeteringRow(finalState, streamUsage, Date.now() - streamReqStart, auth);
      if (isSseWritable(reply.raw)) {
        writeFinalChunk(reply.raw, {
          id: completionId,
          created,
          model: responseModel,
          usage: {
            prompt_tokens: streamUsage.prompt_tokens,
            completion_tokens: streamUsage.completion_tokens,
            total_tokens: streamUsage.total_tokens,
            cached_prompt_tokens: streamUsage.cached_prompt_tokens,
            estimated_cost_usd: streamUsage.estimated_cost_usd,
            actual_cost_usd: streamUsage.actual_cost_usd,
          },
          run_id: emitLegacyStreamStatus ? finalState.run_id : undefined,
          authz_trace_id: emitLegacyStreamStatus ? finalState.authz_trace_id : undefined,
          include_usage: finalState.stream_include_usage ?? true,
          system_fingerprint: SYSTEM_FINGERPRINT,
        });
        endSse(reply.raw);
      }
      streamRelease?.();
      requestSpan.setStatus("ok");
      return reply;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown server error";
      failureStore.record("request", error instanceof Error ? error.name : "UnknownError", rawMessage);
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn(
        {
          authzTraceId,
          authzEngine: authzPolicyEngine.engineName,
          authzRules: err.policyDecision?.matchedRules ?? [],
          errorMessage: rawMessage
        },
        "authz reject or request validation failure"
      );
      const statusCode = err.statusCode
        ?? (rawMessage === "Missing Bearer token" ? 401 : 400);
      if (err.retryAfterSeconds) {
        reply.header("Retry-After", String(err.retryAfterSeconds));
      }
      const errorTrace: TraceRecord = {
        service: "planner",
        trace_id: authzTraceId,
        request_id: authzTraceId,
        authz_trace_id: authzTraceId,
        timestamp: Date.now() / 1000,
        user_id: "",
        org_id: "",
        tenant_id: "",
        model: "unknown",
        tokens: ZERO_USAGE,
        cost: { estimated_usd: 0, actual_usd: 0, rates_snapshot: { input_per_million: 0, output_per_million: 0, cached_input_per_million: null } },
        latency_ms: 0,
        error: rawMessage,
      };
      emitTrace(errorTrace, traceEmitterConfig, app.log);
      if (reply.raw.headersSent) {
        streamRelease?.();
        endSse(reply.raw);
        requestSpan.setStatus("error", rawMessage);
        return reply;
      }
      streamRelease?.();
      const clientMessage = sanitizeErrorMessage(rawMessage);
      requestSpan.setStatus("error", clientMessage);
      return reply.code(statusCode).send({
        error: {
          message: clientMessage,
          type: statusCode === 401
            ? "authentication_error"
            : statusCode === 403
              ? "permission_error"
            : statusCode === 429
              ? "rate_limit_error"
              : statusCode >= 500
                ? "server_error"
                : "invalid_request_error",
          code: String(statusCode)
        }
      });
    } finally {
      requestSpan.end();
    }
    },
  );

  return app;
}
