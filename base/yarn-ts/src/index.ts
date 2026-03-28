import crypto from "node:crypto";
import Fastify from "fastify";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  PricingRegistry,
  createServiceMetrics,
  recordUsageMetrics,
  computeCost,
  emitTrace,
  type LlmUsage as TelemetryLlmUsage,
  type TraceRecord,
} from "@synesis/telemetry";
import { loadConfig } from "./config.js";
import {
  ClaudeMessagesRequestSchema,
  OpenAIChatCompletionRequestSchema,
  type ClaudeMessagesRequest,
  type OpenAIChatCompletionRequest
} from "./schemas.js";
import { fetchTierConfigs } from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry } from "./providers/synesis-provider.js";
import { SawtoothContextManager } from "./context/sawtooth-manager.js";
import { SessionStore, type SessionRecord } from "./state/session-store.js";
import { UsageWriter } from "./state/usage-writer.js";
import { AuthResolver } from "./auth.js";
import { ValidationNormalizationService } from "./validation/service.js";
import { ArtifactStore } from "./state/artifact-store.js";
import { ArtifactRetrievalService, ARTIFACT_TOOL_NAME } from "./state/artifact-retrieval.js";
import { ToolResultReductionService } from "./reduction/tool-result-reducer.js";
import { WorkingFrameService } from "./frame/working-frame-service.js";
import { ProjectManifestService } from "./project/project-manifest-service.js";
import { DeterministicPolicyEngine, type PolicyDecision } from "./policy/deterministic-policy-engine.js";
import { PhaseModelOrchestrator } from "./orchestration/phase-model-orchestrator.js";
import { ClientAdapterPacks } from "./adapters/client-adapter-packs.js";
import { StablePrefixService } from "./context/stable-prefix.js";
import { AttentionPositioningService } from "./context/attention-positioning.js";
import { SessionContinuityService } from "./context/session-continuity.js";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  mapToolChoice,
  sdkToolCallsToOpenAI,
  sdkToolCallsToClaude,
  claudeMessagesToOpenAI,
  openAIMessagesToModelMessages,
  sanitizeToolCalls
} from "./tool-mapping.js";
import { applyToolSearchPolicy } from "./compat/tool-search-policy.js";
import { splitJitter, applyJitter } from "./compat/jitter-buffer.js";
import { sortToolSchemas } from "./compat/sorted-tools.js";
import { applyTrustPackets } from "./security/transcript-trust.js";

type SessionState = {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  toolCallsSinceCheckpoint: number;
  consecutiveToolCalls: number;
  record: SessionRecord;
};

interface RequestDiagnostic {
  timestamp: number;
  sessionKey: string;
  path: string;
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
  toolDefinitionCount: number;
  artifactToolInjected: boolean;
  reducedToolResults: number;
  finishReason: string;
  tokensIn: number;
  tokensOut: number;
  policyDecision: string;
  latencyMs: number;
}

const diagnosticRing: RequestDiagnostic[] = [];
const DIAGNOSTIC_RING_MAX = 20;

function pushDiagnostic(d: RequestDiagnostic): void {
  diagnosticRing.push(d);
  if (diagnosticRing.length > DIAGNOSTIC_RING_MAX) diagnosticRing.shift();
}

import { initFgaClient, fgaCheck } from "./openfga-client.js";

const config = loadConfig();
initFgaClient(config);
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  forceCloseConnections: "idle"
});
const promRegistry = new Registry();
const svcMetrics = createServiceMetrics("yarn", promRegistry);
const pricingRegistry = new PricingRegistry({
  adminUrl: config.SYNESIS_YARN_ADMIN_API_URL,
  adminToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "",
});
const traceEmitterConfig = {
  adminUrl: config.SYNESIS_YARN_ADMIN_API_URL,
  adminToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "",
};
const securityIngestConfig = {
  adminUrl: config.SYNESIS_YARN_ADMIN_API_URL,
  adminToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "",
};
const tierRegistry = new SynesisProviderRegistry();
const sawtooth = new SawtoothContextManager(config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS);
const sessions = new Map<string, SessionState>();
const sessionStore = new SessionStore(config);
const usageWriter = new UsageWriter(config);
const authResolver = new AuthResolver(config);
const artifactStore = new ArtifactStore();
const artifactRetrieval = new ArtifactRetrievalService(artifactStore);
const validationNormalization = new ValidationNormalizationService(config, artifactStore);
const toolResultReduction = new ToolResultReductionService(config, artifactStore);
const workingFrameService = new WorkingFrameService(config.SYNESIS_YARN_FRAME_MAX_FILES);
const projectManifestService = new ProjectManifestService();
const policyEngine = new DeterministicPolicyEngine();
const phaseOrchestrator = new PhaseModelOrchestrator();
const clientAdapterPacks = new ClientAdapterPacks();
const stablePrefixService = new StablePrefixService();
const attentionPositioning = new AttentionPositioningService();
const sessionContinuity = new SessionContinuityService();

function enrichWithFrameAndManifest(
  messages: Array<{ role: string; content: unknown }>,
  sessionKey: string,
  adapterBlock?: string
): Array<{ role: string; content: unknown }> {
  const out = [...messages];

  const systemPrefix = config.SYNESIS_YARN_STABLE_PREFIX_ENABLED
    ? stablePrefixService.partition(sessionKey, adapterBlock).stablePrefix
    : "You are an AI coding assistant provided by Synesis.";

  const volatileBlocks: Array<{ role: string; content: string }> = [];
  if (config.SYNESIS_YARN_WORKING_FRAME_ENABLED) {
    const frame = workingFrameService.build(out);
    volatileBlocks.push({ role: "system", content: workingFrameService.toSystemBlock(frame) });
  }
  if (config.SYNESIS_YARN_PROJECT_MANIFEST_ENABLED) {
    const manifest = projectManifestService.build(out);
    volatileBlocks.push({ role: "system", content: projectManifestService.toSystemBlock(manifest) });
  }

  const enriched: Array<{ role: string; content: unknown }> = [
    { role: "system", content: systemPrefix },
    ...volatileBlocks,
    ...out
  ];

  return config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED
    ? attentionPositioning.position(enriched).messages
    : enriched;
}

interface SessionIdentity {
  userId: string;
  orgId: string;
  conversationId: string;
  clientKind: string;
  displayName?: string;
}

function buildSessionKey(userId: string, clientKind: string, conversationId: string): string {
  const user = userId || "anon";
  const client = clientKind || "unknown";
  const convo = conversationId || "_";
  return `synesis:${user}:${client}:${convo}`;
}

/**
 * Resolve the effective session key, applying inactivity rotation when no
 * explicit conversation_id was provided by the client. Without rotation,
 * clients like Claude Code (which never sends a conversation_id) accumulate
 * all token spend into a single immortal session that eventually hits the
 * budget ceiling.
 *
 * When the existing session has been idle longer than
 * SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS, a new key with a
 * timestamp-based rotation suffix is used so the user gets a fresh budget.
 */
async function getSessionKey(identity: SessionIdentity): Promise<string> {
  const baseKey = buildSessionKey(identity.userId, identity.clientKind, identity.conversationId);
  const hasExplicitConvo = !!(identity.conversationId && identity.conversationId.trim());

  if (hasExplicitConvo) return baseKey;

  const inMemory = sessions.get(baseKey);
  if (inMemory) {
    const idle = Date.now() - inMemory.record.lastActiveAt;
    if (idle > config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS) {
      app.log.info(
        { oldKey: baseKey, idleMs: idle, tokens: inMemory.record.totalTokensIn },
        "session_inactivity_rotation"
      );
      sessions.delete(baseKey);
      const rotated = `${baseKey}:r${Date.now()}`;
      return rotated;
    }
    return baseKey;
  }

  const loaded = await sessionStore.load(baseKey);
  if (loaded) {
    const idle = Date.now() - loaded.lastActiveAt;
    if (idle > config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS) {
      app.log.info(
        { oldKey: baseKey, idleMs: idle, tokens: loaded.totalTokensIn },
        "session_inactivity_rotation_redis"
      );
      const rotated = `${baseKey}:r${Date.now()}`;
      return rotated;
    }
  }

  return baseKey;
}

async function getSessionState(key: string, identity: SessionIdentity): Promise<SessionState> {
  const existing = sessions.get(key);
  if (existing) {
    existing.record.lastActiveAt = Date.now();
    if (existing.record.userId === "anon" && identity.userId !== "anon") {
      existing.record.userId = identity.userId;
      existing.record.orgId = identity.orgId;
    }
    return existing;
  }
  const loaded = await sessionStore.load(key);
  const record: SessionRecord = loaded ?? {
    sessionKey: key,
    userId: identity.userId,
    orgId: identity.orgId,
    conversationId: identity.conversationId,
    clientKind: identity.clientKind,
    displayName: identity.displayName,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalTokensCached: 0,
    totalTokensSaved: 0,
    requestCount: 0,
    escalationCount: 0,
    metadata: {},
    version: 0
  };
  if (identity.displayName && !record.displayName) {
    record.displayName = identity.displayName;
  }
  const history: SessionState["history"] = [];

  if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED) {
    const prevContinuity = await sessionStore.loadContinuity(identity.userId);
    if (prevContinuity) {
      const block = sessionContinuity.toSystemBlock(prevContinuity);
      if (block) {
        history.push({ role: "system", content: block });
      }
    }
  }

  const state: SessionState = { history, toolCallsSinceCheckpoint: 0, consecutiveToolCalls: 0, record };
  sessions.set(key, state);
  return state;
}


async function casSessionSave(state: SessionState): Promise<void> {
  try {
    if (state.history.length > 2 && state.record.userId !== "anon") {
      const continuity = sessionContinuity.extract(state.history);
      state.record.continuity = continuity;
      void sessionStore.saveContinuity(state.record.userId, continuity).catch(() => {});
    }
    const ok = await sessionStore.save(state.record);
    if (!ok) {
      const reloaded = await sessionStore.load(state.record.sessionKey);
      if (reloaded) {
        reloaded.totalTokensIn = Math.max(reloaded.totalTokensIn, state.record.totalTokensIn);
        reloaded.totalTokensOut = Math.max(reloaded.totalTokensOut, state.record.totalTokensOut);
        reloaded.totalTokensCached = Math.max(reloaded.totalTokensCached, state.record.totalTokensCached);
        reloaded.totalTokensSaved = Math.max(reloaded.totalTokensSaved ?? 0, state.record.totalTokensSaved ?? 0);
        reloaded.requestCount = Math.max(reloaded.requestCount, state.record.requestCount);
        reloaded.lastActiveAt = Math.max(reloaded.lastActiveAt, state.record.lastActiveAt);
        const remoteCost = Number(reloaded.metadata.total_cost_usd ?? 0);
        const localCost = Number(state.record.metadata.total_cost_usd ?? 0);
        reloaded.metadata.total_cost_usd = Math.max(remoteCost, localCost);
        state.record = reloaded;
        await sessionStore.save(state.record);
      }
    }
  } catch (err) {
    app.log.warn({ err }, "Session persistence failed (non-fatal)");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "persistence_error", "casSessionSave", String(err instanceof Error ? err.message : err).slice(0, 500));
  }
}

function maybeCheckpoint(state: SessionState): void {
  if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint)) {
    return;
  }
  const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
  void sawtooth.compressTrajectory(state.history).then((consolidated) => {
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
    svcMetrics.compactionTotal.inc({ type: "sawtooth" });
    svcMetrics.sessionCheckpointTotal.inc();
    const charsAfter = consolidated.summary.length;
    const charsSaved = Math.max(0, charsBefore - charsAfter);
    svcMetrics.compactionCharsSaved.inc(charsSaved);
  }).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, sessionKey: state.record.sessionKey }, "compaction_failed");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "compaction_error", "sawtooth", detail.slice(0, 500));
  });
}

function injectSessionContext(
  messages: Array<{ role: string; content: unknown }>,
  state: SessionState
): Array<{ role: string; content: unknown }> {
  const compacted = state.history.find(
    (m) => m.role === "system" && m.content.includes("<ARCHITECTURAL_STATE>")
  );
  if (!compacted) return messages;
  return [{ role: "system", content: compacted.content }, ...messages];
}

async function refreshTierRegistry(): Promise<void> {
  try {
    const tiers = await fetchTierConfigs(config);
    if (tiers.length > 0) {
      tierRegistry.updateTiers(tiers);
      app.log.info({ tiers: tiers.map((t) => t.id) }, "tier_registry_refreshed");
    }
    const compactionTier = tierRegistry.getTierConfig("synesis-compaction");
    if (compactionTier) {
      sawtooth.setCompactFn(async (system: string, userPrompt: string) => {
        const { model } = tierRegistry.resolve("synesis-compaction", config.SYNESIS_YARN_DEFAULT_TIER);
        const result = await generateText({
          model: model as never,
          system,
          messages: [{ role: "user" as const, content: userPrompt }],
          maxOutputTokens: 2048
        });
        return result.text;
      });
    } else {
      sawtooth.setCompactFn(null);
    }
  } catch (error) {
    app.log.warn({ error }, "tier_registry_refresh_failed");
  }
}

import type { ModelAdapter } from "./providers/model-adapter.js";
import { repairWriteToolCall } from "./providers/model-adapter.js";

type ResolveResult =
  | { ok: true; resolved: { model: unknown; resolvedModelId: string; adapter: ModelAdapter }; messages: ReturnType<typeof openAIMessagesToModelMessages> }
  | { ok: false; error: string };

function runOpenAIRequest(request: OpenAIChatCompletionRequest): ResolveResult {
  try {
    const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER);
    const sanitized = sanitizeToolCalls(request.messages as never);
    const messages = openAIMessagesToModelMessages(sanitized);
    return { ok: true, resolved, messages };
  } catch {
    return { ok: false, error: "No model configuration available — the service may still be initializing" };
  }
}

function persistSessionAndUsage(
  state: SessionState,
  requestId: string,
  resolvedModelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number },
  latencyMs: number,
  finishReason: string,
  tokensSavedByReduction = 0
): void {
  const tier = tierRegistry.getTierConfig(resolvedModelId);
  const computedCostUsd =
    usage.costUsd > 0
      ? usage.costUsd
      : ((usage.inputTokens - usage.cachedTokens) / 1_000_000) * Number(tier?.inputPerM ?? 0) +
        (usage.cachedTokens / 1_000_000) * Number(tier?.cachedPerM ?? 0) +
        (usage.outputTokens / 1_000_000) * Number(tier?.outputPerM ?? 0);
  const normalizedCostUsd = Number.isFinite(computedCostUsd) ? Math.max(0, computedCostUsd) : 0;
  if (normalizedCostUsd === 0 && (usage.inputTokens + usage.outputTokens) > 0) {
    app.log.debug({
      model: resolvedModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sdkCost: usage.costUsd,
      tierInputPerM: tier?.inputPerM ?? null,
      tierOutputPerM: tier?.outputPerM ?? null,
      tierCachedPerM: tier?.cachedPerM ?? null,
    }, "zero_cost_with_tokens: check admin rates or tier assignment");
  }
  state.record.totalTokensIn += usage.inputTokens;
  state.record.totalTokensOut += usage.outputTokens;
  state.record.totalTokensCached += usage.cachedTokens;
  state.record.totalTokensSaved = (state.record.totalTokensSaved ?? 0) + tokensSavedByReduction;
  const prevCost = Number(state.record.metadata.total_cost_usd ?? 0);
  state.record.metadata.total_cost_usd = prevCost + normalizedCostUsd;
  state.record.requestCount += 1;
  state.record.lastActiveAt = Date.now();

  if (finishReason === "tool_calls" || finishReason === "tool_use") {
    state.consecutiveToolCalls += 1;
  } else {
    state.consecutiveToolCalls = 0;
  }

  void casSessionSave(state);
  usageWriter.enqueueSessionUpsert(state.record);
  usageWriter.enqueueUsageInsert({
    sessionKey: state.record.sessionKey,
    requestId,
    userId: state.record.userId,
    orgId: state.record.orgId,
    provider: resolvedModelId,
    model: resolvedModelId,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    tokensCached: usage.cachedTokens,
    tokensSavedByReduction,
    latencyMs,
    costUsd: normalizedCostUsd,
    escalated: false,
    toolCallsCount: state.toolCallsSinceCheckpoint,
    finishReason
  });

  const telemetryUsage: TelemetryLlmUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    cached_prompt_tokens: usage.cachedTokens,
    estimated_cost_usd: normalizedCostUsd,
    actual_cost_usd: usage.costUsd > 0 ? usage.costUsd : 0,
  };
  recordUsageMetrics(svcMetrics, resolvedModelId, resolvedModelId, telemetryUsage, latencyMs / 1000);

  const trace: TraceRecord = {
    service: "yarn",
    trace_id: requestId,
    request_id: requestId,
    timestamp: Date.now() / 1000,
    user_id: state.record.userId,
    org_id: state.record.orgId,
    tenant_id: "",
    model: resolvedModelId,
    tokens: telemetryUsage,
    cost: {
      estimated_usd: normalizedCostUsd,
      actual_usd: usage.costUsd > 0 ? usage.costUsd : 0,
      rates_snapshot: {
        input_per_million: Number(tier?.inputPerM ?? 0),
        output_per_million: Number(tier?.outputPerM ?? 0),
        cached_input_per_million: tier?.cachedPerM ?? null,
      },
    },
    latency_ms: latencyMs,
  };
  emitTrace(trace, traceEmitterConfig, app.log);
}

function readUsage(input: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number } {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ rawUsage: obj }, "raw_usage_from_sdk");
  }

  const prompt = Number(obj.inputTokens ?? obj.promptTokens ?? obj.input_tokens ?? 0);
  const completion = Number(obj.outputTokens ?? obj.completionTokens ?? obj.output_tokens ?? 0);

  let cached = Number(obj.cachedInputTokens ?? obj.cached_tokens ?? 0);
  if (!cached) {
    const details = obj.prompt_tokens_details as Record<string, unknown> | undefined;
    if (details) {
      cached = Number(details.cached_tokens ?? 0);
    }
  }
  if (!cached) {
    const cacheRead = obj.cache_read_input_tokens as number | undefined;
    if (cacheRead) cached = Number(cacheRead);
  }
  if (!cached) {
    const inputTokenDetails = obj.inputTokenDetails as Record<string, unknown> | undefined;
    if (inputTokenDetails) {
      cached = Number(inputTokenDetails.cacheReadTokens ?? inputTokenDetails.cachedTokens ?? 0);
    }
  }

  const cost = Number(obj.costUsd ?? obj.cost_usd ?? obj.estimated_cost ?? 0);
  return {
    inputTokens: Number.isFinite(prompt) ? prompt : 0,
    outputTokens: Number.isFinite(completion) ? completion : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
    costUsd: Number.isFinite(cost) ? cost : 0
  };
}

function resolveClaudeConversationId(
  metadata: Record<string, unknown> | undefined,
  headers: Record<string, unknown>,
): string {
  if (metadata) {
    for (const key of ["synesis_conversation_id", "conversation_id", "session_id"]) {
      const val = metadata[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    // Claude Code nests session_id inside metadata.user_id as a JSON string:
    // {"device_id":"...","account_uuid":"","session_id":"<uuid>"}
    const rawUserId = metadata.user_id;
    if (typeof rawUserId === "string" && rawUserId.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawUserId) as Record<string, unknown>;
        const nested = parsed.session_id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      } catch { /* not JSON, ignore */ }
    }
  }
  for (const hdr of ["x-synesis-conversation-id", "x-claude-session-id"]) {
    const val = headers[hdr];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ metadata, knownHeaders: {
      "x-synesis-conversation-id": headers["x-synesis-conversation-id"],
      "x-claude-session-id": headers["x-claude-session-id"],
      "x-request-id": headers["x-request-id"],
    }}, "claude_conversation_id_resolution_miss");
  }
  return "";
}

function countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
} {
  let systemMessageCount = 0;
  let userMessageCount = 0;
  let toolMessageCount = 0;
  let totalInputChars = 0;
  for (const m of messages) {
    const chars = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    totalInputChars += chars;
    if (m.role === "system") systemMessageCount++;
    else if (m.role === "user") userMessageCount++;
    else if (m.role === "tool") toolMessageCount++;
  }
  return { systemMessageCount, userMessageCount, toolMessageCount, totalInputChars };
}

function logAndPersistSafetyEvent(
  decision: PolicyDecision,
  sessionKey: string,
  sessionTokensIn: number
): void {
  for (const event of policyEngine.getRecentEvents().slice(-1)) {
    app.log.warn({
      safetyEvent: event.kind,
      sessionKey,
      detail: event.detail,
      repeatCount: event.repeatCount,
      tokensBurned: event.tokensBurned ?? sessionTokensIn,
      consecutiveToolCalls: event.consecutiveToolCalls
    }, `policy_safety_event: ${event.kind}`);
    usageWriter.enqueueSafetyEventInsert({
      sessionKey,
      userId: "",
      orgId: "",
      eventKind: event.kind,
      detail: event.detail,
      repeatCount: event.repeatCount,
      tokensBurned: event.tokensBurned ?? sessionTokensIn,
      consecutiveToolCalls: event.consecutiveToolCalls
    });
  }
}

function recordSessionEvent(
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId?: string,
  meta?: Record<string, unknown>,
): void {
  app.log.warn({ sessionKey, requestId, component, eventKind, detail: detail.slice(0, 200) }, `session_event: ${eventKind}`);
  usageWriter.enqueueSessionEvent({
    sessionKey,
    requestId,
    userId,
    orgId,
    eventKind,
    component,
    detail,
    metadataJson: meta,
  });
}

function getBearerToken(authHeader: string | undefined): string {
  const raw = authHeader ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

async function proxyMcpGet(path: string, bearer: string): Promise<unknown> {
  const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${bearer}` }
  });
  if (!response.ok) {
    throw new Error(`MCP upstream error ${response.status}`);
  }
  return response.json();
}

async function proxyMcpPost(path: string, bearer: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`MCP upstream error ${response.status}`);
  }
  return response.json();
}

function sse(reply: { raw: { write(data: string): boolean } }, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(raw: NodeJS.WritableStream & { destroyed?: boolean }, data: string): boolean {
  try {
    if (raw.destroyed) return false;
    raw.write(data);
    return true;
  } catch { return false; }
}

function safeSse(reply: { raw: NodeJS.WritableStream & { destroyed?: boolean } }, event: string, data: unknown): boolean {
  return safeWrite(reply.raw, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeEnd(raw: NodeJS.WritableStream & { destroyed?: boolean }): void {
  try { if (!raw.destroyed) raw.end(); } catch { /* already closed */ }
}

function sanitizeUpstreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out/i.test(raw)) return "Upstream model request timed out";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(raw)) return "Upstream model service unavailable";
  if (/\b[45]\d{2}\b/.test(raw)) return "Upstream model service error";
  if (/rate.?limit/i.test(raw)) return "Upstream rate limit exceeded";
  if (/context.?length|too.?long|too.?large/i.test(raw)) return "Request too large for model context window";
  return "Model request failed";
}

function requireInternalToken(req: { headers: Record<string, unknown> }): boolean {
  const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN;
  if (!token) return false;
  const bearer = getBearerToken(req.headers.authorization as string | undefined);
  return bearer === token;
}

/**
 * Convert Claude's top-level `system` field (string or content-block array)
 * into a system-role message that can be prepended to the OpenAI message list.
 */
function claudeSystemToMessage(system: unknown): { role: "system"; content: string } | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const textParts = system
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""));
    const joined = textParts.join("\n");
    return joined.length > 0 ? { role: "system", content: joined } : null;
  }
  return null;
}

function resolveRequestId(headers: Record<string, unknown>): string {
  const explicit = headers["x-request-id"] ?? headers["anthropic-request-id"];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return `req-${crypto.randomUUID()}`;
}

function debugProtocolLog(
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  reqId: string,
  path: string,
  extra: Record<string, unknown>
): void {
  if (!config.SYNESIS_YARN_DEBUG_PROTOCOL) return;
  logger.info({ reqId, path, ...extra }, "debug_protocol");
}

// --- Session TTL eviction ---
const SESSION_TTL_MS = config.SYNESIS_YARN_SESSION_TTL_MS;
const sessionEvictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of sessions) {
    if (now - state.record.lastActiveAt > SESSION_TTL_MS) {
      void casSessionSave(state);
      sessions.delete(key);
      stablePrefixService.evictSession(key);
    }
  }
}, 60_000);

// --- Graceful shutdown ---
async function shutdown(): Promise<void> {
  clearInterval(sessionEvictionTimer);
  clearInterval(tierPollTimer);
  pricingRegistry.stop();
  await app.close();
  await Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function computeEfficiencyIndex(): {
  score: number;
  reducerHitRate: number;
  artifactOffloadRate: number;
  tokenSavingsRate: number;
  jsonCompactionRate: number;
} {
  const stats = toolResultReduction.getStats();
  const total = stats.reducedCount + stats.fallbackToArtifactCount;
  const reducerHitRate = total > 0 ? (total - stats.fallbackToArtifactCount) / total : 0;
  const artifactOffloadRate = total > 0 ? stats.artifactHandleCount / total : 0;
  const tokenSavingsRate = stats.rawCharsTotal > 0
    ? (stats.rawCharsTotal - stats.reducedCharsTotal) / stats.rawCharsTotal
    : 0;
  const jsonCompactionRate = total > 0 ? stats.jsonCompactionCount / total : 0;
  const score = reducerHitRate * 0.3 + artifactOffloadRate * 0.15 + tokenSavingsRate * 0.45 + jsonCompactionRate * 0.1;
  return {
    score: Math.round(score * 1000) / 1000,
    reducerHitRate: Math.round(reducerHitRate * 1000) / 1000,
    artifactOffloadRate: Math.round(artifactOffloadRate * 1000) / 1000,
    tokenSavingsRate: Math.round(tokenSavingsRate * 1000) / 1000,
    jsonCompactionRate: Math.round(jsonCompactionRate * 1000) / 1000
  };
}

// --- Health endpoints ---
app.get("/health", async () => ({ status: "ok" }));
app.get("/health/readiness", async () => ({ status: "ready" }));
app.get("/health/telemetry", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
  }
  let activeSessionCount = 0;
  let totalHistoryEntries = 0;
  let checkpointedSessions = 0;
  for (const [, state] of sessions) {
    activeSessionCount++;
    totalHistoryEntries += state.history.length;
    if (state.history.some((m) => m.content.includes("<ARCHITECTURAL_STATE>"))) {
      checkpointedSessions++;
    }
  }
  return {
    timestamp: Date.now(),
    writeQueue: usageWriter.getStats(),
    validationNormalization: validationNormalization.getStats(),
    toolResultReduction: toolResultReduction.getStats(),
    workingFrame: workingFrameService.getStats(),
    projectManifest: projectManifestService.getStats(),
    deterministicPolicy: policyEngine.getStats(),
    phaseOrchestrator: phaseOrchestrator.getStats(),
    clientAdapterPacks: clientAdapterPacks.getStats(),
    sawtoothContext: {
      activeSessionCount,
      totalHistoryEntries,
      checkpointedSessions,
      checkpointThreshold: config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS
    },
    stablePrefix: stablePrefixService.getStats(),
    artifactRetrieval: artifactRetrieval.getStats(),
    attentionPositioning: attentionPositioning.getStats(),
    compressionEfficiencyIndex: computeEfficiencyIndex(),
    sessionContinuity: sessionContinuity.getStats(),
    featureFlags: {
      stablePrefix: config.SYNESIS_YARN_STABLE_PREFIX_ENABLED,
      jsonCompaction: config.SYNESIS_YARN_JSON_COMPACTION_ENABLED,
      attentionPositioning: config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED,
      artifactRetrieval: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      sessionContinuity: config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED,
      contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED,
      claudeToolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
      jitterBuffer: config.SYNESIS_YARN_JITTER_BUFFER_ENABLED,
      sortedTools: config.SYNESIS_YARN_SORTED_TOOLS_ENABLED,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
    },
    safetyLimits: {
      hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
      sessionMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
      consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
      consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT
    }
  };
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", promRegistry.contentType);
  return promRegistry.metrics();
});

app.get("/v1/diagnostics/recent", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
  }
  return { diagnostics: [...diagnosticRing], count: diagnosticRing.length };
});

app.get("/v1", async () => ({
  status: "ok",
  service: "synesis-yarn-ts",
  version: "0.2.0",
  endpoints: ["/v1/models", "/v1/chat/completions", "/v1/messages"]
}));

app.get("/v1/models", async () => ({
  object: "list",
  data: tierRegistry.getAvailableModels()
}));

app.get("/v1/adapter-packs", async () => ({
  catalog: clientAdapterPacks.getCatalog()
}));

app.get("/v1/artifacts/:id", async (req, reply) => {
  try {
    await authResolver.resolve(req.headers.authorization);
  } catch {
    return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
  }
  const id = (req.params as { id: string }).id;
  const artifact = artifactStore.get(id);
  if (!artifact) {
    return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
  }
  return reply.send(artifact);
});

// --- MCP proxy ---
app.get("/v1/mcp/tools", async (req, reply) => {
  let user;
  try {
    user = await authResolver.resolve(req.headers.authorization);
    authResolver.requireCoderScope(user);
  } catch {
    return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
  }
  try {
    const bearer = getBearerToken(req.headers.authorization);
    const data = await proxyMcpGet("/api/v1/mcp/tools", bearer);
    return reply.send(data);
  } catch (err) {
    app.log.error({ err }, "MCP tools proxy failed");
    return reply.code(502).send({ error: { type: "upstream_error", message: "MCP service unavailable" } });
  }
});

app.post("/v1/mcp/tools/call", async (req, reply) => {
  let user;
  try {
    user = await authResolver.resolve(req.headers.authorization);
    authResolver.requireCoderScope(user);
  } catch {
    return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
  }
  try {
    const bearer = getBearerToken(req.headers.authorization);
    const data = await proxyMcpPost("/api/v1/mcp/tools/call", bearer, req.body);
    if (config.SYNESIS_YARN_TRUST_PACKET_ENABLED) {
      reply.header("X-Synesis-Trust-Metadata", JSON.stringify({
        schema_version: 1,
        trust_level: "untrusted",
        source_type: "mcp_response",
        instruction_execution_allowed: false,
        content_purpose: "data",
      }));
    }
    return reply.send(data);
  } catch (err) {
    app.log.error({ err }, "MCP tools/call proxy failed");
    return reply.code(502).send({ error: { type: "upstream_error", message: "MCP service unavailable" } });
  }
});

// --- OpenAI chat completions ---
app.post("/v1/chat/completions", async (req, reply) => {
  const parsed = OpenAIChatCompletionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsed.error.message } });
  }
  let authUser: import("./auth.js").AuthUser;
  try {
    authUser = await authResolver.resolve(req.headers.authorization);
  } catch {
    return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
  }

  try {
    authResolver.requireCoderScope(authUser);
  } catch {
    return reply.code(403).send({ error: { type: "authz_error", message: "Insufficient scope for coder access" } });
  }

  const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "completions");
  if (!fgaResult.allowed) {
    return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
  }

  const request = parsed.data;
  const oaiTraceReqId = resolveRequestId(req.headers as Record<string, unknown>);

  // Sorted tools for cache stability
  if (config.SYNESIS_YARN_SORTED_TOOLS_ENABLED && request.tools) {
    request.tools = sortToolSchemas(request.tools) as never;
  }

  const reducedOpenAI = toolResultReduction.reduceMessages(request.messages as never);
  const toolResultCount = (request.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  const normalizedOpenAI = validationNormalization.normalizeMessages(reducedOpenAI.messages as never);
  const adapterProfile = clientAdapterPacks.resolve(
    String((req.headers["x-synesis-client"] as string | undefined) ?? "unknown"),
    String((req.headers["x-synesis-mode"] as string | undefined) ?? "")
  );
  const adapterBlock = clientAdapterPacks.toSystemBlock(adapterProfile);
  const latestUserText = [...(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
  const preManifest = projectManifestService.build(normalizedOpenAI.messages as never);

  debugProtocolLog(app.log as never, oaiTraceReqId, "/v1/chat/completions", {
    model: request.model,
    messageCount: (request.messages as unknown[]).length,
    hasTools: !!(request.tools as unknown[])?.length,
    stream: request.stream,
    client: adapterProfile.client,
  });
  const orchestration = phaseOrchestrator.decide({
    requestedModel: request.model,
    latestUserText: String(latestUserText?.content ?? ""),
    riskProfile: preManifest.riskProfile
  });
  const oaiClientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "unknown");
  const identity: SessionIdentity = {
    userId: request.user || authUser.userId,
    orgId: authUser.orgId,
    conversationId: request.conversation_id || "",
    clientKind: oaiClientKind,
    displayName: authUser.displayName,
  };
  const sessionKey = await getSessionKey(identity);
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ sessionKey, source: "conversation_id_body", conversationId: identity.conversationId, clientKind: oaiClientKind }, "session_resolution");
  }
  const session = await getSessionState(sessionKey, identity);

  const oaiMsgCount = (request.messages as unknown[]).length;
  const oaiLastToolId = [...(request.messages as Array<{ role: string; tool_call_id?: string }>)]
    .reverse().find((m) => m.role === "tool")?.tool_call_id ?? "";
  const policyPrecheck = policyEngine.evaluate({
    tools: request.tools as unknown[],
    repeatAttempt: {
      action: "chat_completion",
      args: { model: request.model, msgCount: oaiMsgCount, lastToolId: oaiLastToolId },
      fsFingerprint: String(oaiMsgCount)
    },
    sessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER
  });
  if (!policyPrecheck.allow) {
    logAndPersistSafetyEvent(policyPrecheck, sessionKey, session.record.totalTokensIn);
    return reply.code(400).send({ error: { type: "invalid_request_error", message: policyPrecheck.rejectReason ?? "Policy rejected request." } });
  }
  let oaiEnrichedMsgs = enrichWithFrameAndManifest(normalizedOpenAI.messages as never, sessionKey, adapterBlock) as Array<{ role: string; content: unknown }>;

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED) {
    const { stableMessages, jitterBlock } = splitJitter(oaiEnrichedMsgs);
    oaiEnrichedMsgs = applyJitter(stableMessages, jitterBlock) as typeof oaiEnrichedMsgs;
  }

  const trustResult = applyTrustPackets(oaiEnrichedMsgs, config, {
    requestId: oaiTraceReqId,
    sessionKey,
    userId: identity.userId,
    orgId: identity.orgId,
  }, securityIngestConfig, app.log as never);
  if (trustResult.blocked) {
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "trust_block", "transcript-trust", trustResult.blockReason ?? "Content blocked", oaiTraceReqId);
    return reply.code(400).send({ error: { type: "invalid_request_error", message: trustResult.blockReason ?? "Content blocked by trust scanner." } });
  }
  oaiEnrichedMsgs = trustResult.messages as typeof oaiEnrichedMsgs;

  const normalizedRequest: OpenAIChatCompletionRequest = {
    ...request,
    model: orchestration.selectedModel,
    messages: oaiEnrichedMsgs as never
  };

  session.toolCallsSinceCheckpoint += toolResultCount;
  const reqId = oaiTraceReqId;
  if (policyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: policyPrecheck.pivotPrompt });
  }

  if (latestUserText?.content) {
    session.history.push({ role: "user", content: String(latestUserText.content) });
  }

  normalizedRequest.messages = injectSessionContext(
    normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    session
  ) as never;

  if (config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED) {
    normalizedRequest.tools = artifactRetrieval.injectToolOpenAI(normalizedRequest.tools as unknown[]) as never;
  }

  const resolveResult = runOpenAIRequest(normalizedRequest);
  if (!resolveResult.ok) {
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "resolve_failure", "tier-registry", resolveResult.error, reqId);
    return reply.code(503).send({ error: { type: "service_unavailable", message: resolveResult.error } });
  }
  const { resolved, messages } = resolveResult;
  const { adapter } = resolved;
  const sdkTools = openAIToolsToSDK(normalizedRequest.tools);
  const sdkToolChoice = mapToolChoice(normalizedRequest.tool_choice);

  const modelToolPrompt = adapter.toolSystemPrompt?.(((normalizedRequest.tools as unknown[]) ?? []).length);
  if (modelToolPrompt) {
    oaiEnrichedMsgs = [{ role: "system", content: modelToolPrompt }, ...oaiEnrichedMsgs];
  }
  const adapterProviderOptions = adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined;

  if (!normalizedRequest.stream) {
    const started = Date.now();
    let finalResult;
    try {
      let currentMessages = messages;
      finalResult = await generateText({
        model: resolved.model as never,
        messages: currentMessages,
        maxOutputTokens: orchestration.maxOutputTokens,
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
        ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
      });

      for (let round = 0; round < 3; round++) {
        const allCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
        const artifactCalls = allCalls.filter((tc) => tc.toolName === ARTIFACT_TOOL_NAME);
        if (artifactCalls.length === 0) break;
        const clientCalls = allCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);

        const toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }> = [];
        for (const ac of artifactCalls) {
          const inp = ac.input as { artifact_handle?: string; query?: string };
          const result = artifactRetrieval.retrieve(inp.artifact_handle ?? "", inp.query);
          toolResults.push({
            type: "tool-result",
            toolCallId: ac.toolCallId,
            toolName: ARTIFACT_TOOL_NAME,
            output: { type: "text", value: result.content }
          });
        }

        if (clientCalls.length > 0) break;

        const assistantParts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
        if (finalResult.text) assistantParts.push({ type: "text", text: finalResult.text });
        for (const ac of artifactCalls) {
          assistantParts.push({ type: "tool-call", toolCallId: ac.toolCallId, toolName: ac.toolName, input: ac.input });
        }
        if (assistantParts.length === 0) assistantParts.push({ type: "text", text: "" });

        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: assistantParts } as never,
          { role: "tool", content: toolResults } as never
        ];

        finalResult = await generateText({
          model: resolved.model as never,
          messages: currentMessages,
          maxOutputTokens: orchestration.maxOutputTokens,
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {})
        });
      }
    } catch (err) {
      app.log.error({ err, reqId, model: resolved.resolvedModelId }, "OpenAI non-stream generateText failed");
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "upstream_error", "generateText", sanitizeUpstreamError(err), reqId, { model: resolved.resolvedModelId });
      return reply.code(502).send({ error: { type: "upstream_error", message: sanitizeUpstreamError(err) } });
    }

    const toolCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
    const externalToolCalls = toolCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);
    const finishReason = externalToolCalls.length > 0 ? "tool_calls" : "stop";
    session.history.push({ role: "assistant", content: finalResult.text });
    const usage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
    const oaiLatency = Date.now() - started;
    const oaiSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, oaiLatency, finishReason, oaiSaved);
    maybeCheckpoint(session);

    const msgCounts = countMessageRoles(normalizedRequest.messages as Array<{ role: string; content: unknown }>);
    pushDiagnostic({
      timestamp: Date.now(), sessionKey, path: "/v1/chat/completions",
      ...msgCounts,
      toolDefinitionCount: (normalizedRequest.tools as unknown[] ?? []).length,
      artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      reducedToolResults: reducedOpenAI.reducedCount,
      finishReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
      policyDecision: policyPrecheck.matchedRules.join(","), latencyMs: oaiLatency
    });

    const message: Record<string, unknown> = { role: "assistant", content: finalResult.text };
    if (externalToolCalls.length > 0) {
      message.tool_calls = sdkToolCallsToOpenAI(externalToolCalls);
    }
    return reply.send({
      id: reqId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: resolved.resolvedModelId,
      choices: [{ index: 0, message, finish_reason: finishReason }]
    });
  }

  const started = Date.now();
  const streamed = streamText({
    model: resolved.model as never,
    messages,
    maxOutputTokens: orchestration.maxOutputTokens,
    ...(sdkTools ? { tools: sdkTools } : {}),
    ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
    ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
  });
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  let finishReason = "stop";
  const pendingToolCalls: Array<{ index: number; id: string; name: string; args: string }> = [];

  try {
    for await (const part of streamed.fullStream) {
      const ts = Math.floor(Date.now() / 1000);
      if (part.type === "text-delta") {
        safeWrite(reply.raw, `data: ${JSON.stringify({
          id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
          choices: [{ index: 0, delta: { content: (part as unknown as { text: string }).text ?? "" }, finish_reason: null }]
        })}\n\n`);
      } else if (part.type === "tool-call" || part.type === "tool-input-start") {
        const tc = part as unknown as { toolCallId?: string; toolName?: string; input?: unknown };
        if (part.type === "tool-input-start") {
          pendingToolCalls.push({ index: pendingToolCalls.length, id: tc.toolCallId ?? "", name: tc.toolName ?? "", args: "" });
          safeWrite(reply.raw, `data: ${JSON.stringify({
            id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length - 1, id: tc.toolCallId, type: "function", function: { name: tc.toolName, arguments: "" } }] }, finish_reason: null }]
          })}\n\n`);
        } else if (part.type === "tool-call") {
          finishReason = "tool_calls";
          let argsStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {});
          const rawArgsLen = argsStr.length;
          if (adapter.normalizeToolCallArgs) argsStr = adapter.normalizeToolCallArgs(argsStr);
          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({
              reqId, toolName: tc.toolName, toolCallId: tc.toolCallId,
              argsLen: rawArgsLen, normalized: argsStr.length !== rawArgsLen,
              adapterFamily: adapter.family,
            }, "tool_call_streamed");
          }
          const existing = pendingToolCalls.find((p) => p.id === tc.toolCallId);
          if (existing) {
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: existing.index, function: { arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
          } else {
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length, id: tc.toolCallId, type: "function", function: { name: tc.toolName, arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
          }
        }
      } else if (part.type === "tool-input-delta") {
        const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
        const idx = pendingToolCalls.findIndex((p) => p.id === td.toolCallId);
        if (idx >= 0) {
          safeWrite(reply.raw, `data: ${JSON.stringify({
            id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: td.inputTextDelta ?? "" } }] }, finish_reason: null }]
          })}\n\n`);
        }
      }
    }
  } catch (streamErr) {
    const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
    app.log.error({ err: streamErr, reqId, model: resolved.resolvedModelId }, `OpenAI stream error: ${detail}`);
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "stream_error", "streamText", detail.slice(0, 500), reqId, { model: resolved.resolvedModelId });
    finishReason = "error";
    safeWrite(reply.raw, `data: ${JSON.stringify({
      id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
      choices: [{ index: 0, delta: { content: "\n\n[Upstream provider error — retrying may help]" }, finish_reason: null }]
    })}\n\n`);
  }

  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);

  let oaiStreamUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  let streamedText = "";
  try { oaiStreamUsage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
  try { streamedText = await streamed.text; } catch { /* stream aborted */ }
  if (streamedText) {
    session.history.push({ role: "assistant", content: streamedText });
  }
  const oaiStreamLatency = Date.now() - started;
  const oaiStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, oaiStreamUsage, oaiStreamLatency, finishReason, oaiStreamSaved);
  maybeCheckpoint(session);
  const oaiStreamMsgCounts = countMessageRoles(normalizedRequest.messages as Array<{ role: string; content: unknown }>);
  pushDiagnostic({
    timestamp: Date.now(), sessionKey, path: "/v1/chat/completions (stream)",
    ...oaiStreamMsgCounts,
    toolDefinitionCount: (normalizedRequest.tools as unknown[] ?? []).length,
    artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
    reducedToolResults: reducedOpenAI.reducedCount,
    finishReason, tokensIn: oaiStreamUsage.inputTokens, tokensOut: oaiStreamUsage.outputTokens,
    policyDecision: policyPrecheck.matchedRules.join(","), latencyMs: oaiStreamLatency
  });
  return reply;
});

// --- Claude Messages API ---
app.post("/v1/messages", async (req, reply) => {
  let claudeAuthUser: import("./auth.js").AuthUser;
  try {
    claudeAuthUser = await authResolver.resolve(req.headers.authorization);
  } catch {
    return reply.code(401).send({
      type: "error",
      error: { type: "authentication_error", message: "Authentication required" }
    });
  }
  try {
    authResolver.requireCoderScope(claudeAuthUser);
  } catch {
    return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Insufficient scope" } });
  }
  const claudeFgaResult = await fgaCheck(`user:${claudeAuthUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!claudeFgaResult.allowed) {
    return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Authorization denied by policy" } });
  }
  const anthropicVersion = req.headers["anthropic-version"];
  if (!anthropicVersion || typeof anthropicVersion !== "string") {
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: "Missing required header: anthropic-version" }
    });
  }
  const parsed = ClaudeMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: parsed.error.message }
    });
  }
  const body: ClaudeMessagesRequest = parsed.data;
  const traceReqId = resolveRequestId(req.headers as Record<string, unknown>);

  // Merge top-level `system` into the message list (parity with Anthropic SDK)
  const claudeSystemMsg = claudeSystemToMessage(body.system);
  const rawOpenAIMessages = claudeMessagesToOpenAI(
    body.messages as never,
    (content, toolName) => toolResultReduction.reduceStandaloneToolResult(content, toolName)
  );
  const openAIMessages = claudeSystemMsg ? [claudeSystemMsg, ...rawOpenAIMessages] : rawOpenAIMessages;

  // Tool-search policy: strip defer_loading / tool_reference in disable mode
  const toolSearchResult = applyToolSearchPolicy(
    body.tools as Array<Record<string, unknown>> | undefined,
    config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE
  );
  const processedTools = config.SYNESIS_YARN_SORTED_TOOLS_ENABLED
    ? sortToolSchemas(toolSearchResult.tools)
    : toolSearchResult.tools;

  const claudeToolResultCount = (body.messages as Array<{ role: string }>).filter((m) => m.role === "tool_result" || m.role === "tool").length;
  const normalizedFromClaude = validationNormalization.normalizeMessages(openAIMessages as never);

  debugProtocolLog(app.log as never, traceReqId, "/v1/messages", {
    model: body.model,
    anthropicVersion: anthropicVersion,
    anthropicBeta: req.headers["anthropic-beta"] ?? null,
    messageCount: body.messages.length,
    hasSystem: !!body.system,
    hasTools: !!(body.tools as unknown[])?.length,
    hasThinking: !!body.thinking,
    stream: body.stream,
    toolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
    toolSearchStripped: toolSearchResult.strippedDeferredCount,
  });

  const claudeAdapterProfile = clientAdapterPacks.resolve(
    String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code"),
    String((req.headers["x-synesis-mode"] as string | undefined) ?? "")
  );
  const claudeAdapterBlock = clientAdapterPacks.toSystemBlock(claudeAdapterProfile);
  const latestClaudeUser = [...(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
  const claudeManifest = projectManifestService.build(normalizedFromClaude.messages as never);
  const claudeOrchestration = phaseOrchestrator.decide({
    requestedModel: body.model,
    latestUserText: String(latestClaudeUser?.content ?? ""),
    riskProfile: claudeManifest.riskProfile
  });
  const claudeClientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
  const claudeConversationId = resolveClaudeConversationId(body.metadata, req.headers as Record<string, unknown>);
  const claudeIdentity: SessionIdentity = {
    userId: claudeAuthUser.userId,
    orgId: claudeAuthUser.orgId,
    conversationId: claudeConversationId,
    clientKind: claudeClientKind,
    displayName: claudeAuthUser.displayName,
  };
  const claudeSessionKey = await getSessionKey(claudeIdentity);
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ sessionKey: claudeSessionKey, source: claudeConversationId ? "metadata" : "fallback", conversationId: claudeConversationId, clientKind: claudeClientKind }, "session_resolution");
  }
  const session = await getSessionState(claudeSessionKey, claudeIdentity);

  const claudeMsgCount = (body.messages as unknown[]).length;
  const claudeLastToolUseId = [...(body.messages as Array<{ role: string; content: unknown }>)]
    .reverse()
    .flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .find((b: Record<string, unknown>) => b.type === "tool_result")
    ?.tool_use_id as string ?? "";
  const claudePolicyPrecheck = policyEngine.evaluate({
    tools: (body.tools as unknown[]) ?? [],
    repeatAttempt: {
      action: "claude_messages",
      args: { model: body.model, msgCount: claudeMsgCount, lastToolUseId: claudeLastToolUseId },
      fsFingerprint: String(claudeMsgCount)
    },
    sessionKey: claudeSessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER
  });
  if (!claudePolicyPrecheck.allow) {
    logAndPersistSafetyEvent(claudePolicyPrecheck, claudeSessionKey, session.record.totalTokensIn);
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: claudePolicyPrecheck.rejectReason ?? "Policy rejected request." }
    });
  }

  let enrichedClaudeMsgs = enrichWithFrameAndManifest(normalizedFromClaude.messages as never, claudeSessionKey, claudeAdapterBlock) as Array<{ role: string; content: unknown }>;

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED) {
    const { stableMessages, jitterBlock } = splitJitter(enrichedClaudeMsgs);
    enrichedClaudeMsgs = applyJitter(stableMessages, jitterBlock) as typeof enrichedClaudeMsgs;
  }

  const claudeTrustResult = applyTrustPackets(enrichedClaudeMsgs, config, {
    requestId: traceReqId,
    sessionKey: claudeSessionKey,
    userId: claudeIdentity.userId,
    orgId: claudeIdentity.orgId,
  }, securityIngestConfig, app.log as never);
  if (claudeTrustResult.blocked) {
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "trust_block", "transcript-trust", claudeTrustResult.blockReason ?? "Content blocked", traceReqId);
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: claudeTrustResult.blockReason ?? "Content blocked by trust scanner." }
    });
  }
  enrichedClaudeMsgs = claudeTrustResult.messages as typeof enrichedClaudeMsgs;

  const openAIShape: OpenAIChatCompletionRequest = {
    model: claudeOrchestration.selectedModel,
    messages: enrichedClaudeMsgs as never,
    stream: body.stream,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };
  session.toolCallsSinceCheckpoint += claudeToolResultCount;
  const reqId = traceReqId;
  if (claudePolicyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: claudePolicyPrecheck.pivotPrompt });
  }

  if (latestClaudeUser?.content) {
    session.history.push({ role: "user", content: String(latestClaudeUser.content) });
  }

  openAIShape.messages = injectSessionContext(
    openAIShape.messages as Array<{ role: string; content: unknown }>,
    session
  ) as never;

  // P0 FIX: Do NOT inject artifact tool into Claude path — no auto-resolve exists for streaming.
  // Artifact retrieval stays OpenAI-only until streaming interception is implemented.

  const claudeResolveResult = runOpenAIRequest(openAIShape);
  if (!claudeResolveResult.ok) {
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "resolve_failure", "tier-registry", claudeResolveResult.error, traceReqId);
    return reply.code(503).send({
      type: "error",
      error: { type: "service_unavailable", message: claudeResolveResult.error }
    });
  }
  const { resolved, messages } = claudeResolveResult;
  const { adapter: claudeAdapter } = resolved;
  const sdkTools = claudeToolsToSDK(processedTools as never);
  const sdkToolChoice = mapToolChoice(body.tool_choice);
  const sdkStop = body.stop_sequences && body.stop_sequences.length > 0 ? body.stop_sequences : undefined;

  const claudeModelToolPrompt = claudeAdapter.toolSystemPrompt?.(((body.tools as unknown[]) ?? []).length);
  if (claudeModelToolPrompt) {
    enrichedClaudeMsgs = [{ role: "system", content: claudeModelToolPrompt }, ...enrichedClaudeMsgs];
  }

  const adapterClaudeProviderOptions = claudeAdapter.providerOptions?.();
  const providerOptions = body.thinking
    ? { openai: { thinking: body.thinking, ...(adapterClaudeProviderOptions?.openai ?? {}) }, ...(adapterClaudeProviderOptions ? Object.fromEntries(Object.entries(adapterClaudeProviderOptions).filter(([k]) => k !== "openai")) : {}) }
    : adapterClaudeProviderOptions;

  if (body.stream) {
    const started = Date.now();
    const streamed = streamText({
      model: resolved.model as never,
      messages,
      maxOutputTokens: claudeOrchestration.maxOutputTokens,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {})
    });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const msgId = `msg_${crypto.randomUUID()}`;
    safeSse(reply, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: resolved.resolvedModelId, content: [] } });

    let blockIdx = 0;
    let inTextBlock = false;
    let stopReason = "end_turn";
    const pendingClaudeToolIds = new Set<string>();
    const claudeToolBuffer = new Map<string, { toolName: string; toolCallId: string; chunks: string[] }>();

    try {
      for await (const part of streamed.fullStream) {
        if (part.type === "text-delta") {
          const delta = (part as unknown as { text?: string }).text ?? "";
          if (!inTextBlock) {
            safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
            inTextBlock = true;
          }
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: delta } });
        } else if (part.type === "reasoning-start") {
          if (inTextBlock) {
            safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
            blockIdx++;
            inTextBlock = false;
          }
          const text = (part as unknown as { text?: string }).text ?? "";
          safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "thinking", thinking: "" } });
          if (text) {
            safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
          }
        } else if (part.type === "reasoning-delta") {
          const text = (part as unknown as { textDelta?: string }).textDelta ?? "";
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
        } else if (part.type === "reasoning-end") {
          safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
        } else if (part.type === "tool-input-start") {
          const tc = part as unknown as { toolCallId?: string; toolName?: string };
          if (tc.toolName === ARTIFACT_TOOL_NAME) {
            pendingClaudeToolIds.add(tc.toolCallId ?? "");
            continue;
          }
          if (inTextBlock) {
            safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
            blockIdx++;
            inTextBlock = false;
          }
          // Buffer tool input for normalization instead of streaming immediately.
          // We emit the start + deltas + stop together in tool-call handler after remapping.
          claudeToolBuffer.set(tc.toolCallId ?? "", { toolName: tc.toolName ?? "", toolCallId: tc.toolCallId ?? "", chunks: [] });
          stopReason = "tool_use";
        } else if (part.type === "tool-input-delta") {
          const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
          const tdId = td.toolCallId ?? "";
          if (pendingClaudeToolIds.has(tdId)) continue;
          const buf = claudeToolBuffer.get(tdId);
          if (buf) {
            buf.chunks.push(td.inputTextDelta ?? "");
          } else {
            safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: td.inputTextDelta ?? "" } });
          }
        } else if (part.type === "tool-call") {
          const tcFull = part as unknown as { toolCallId?: string; toolName?: string; input?: unknown };
          if (tcFull.toolName === ARTIFACT_TOOL_NAME) continue;
          const buf = claudeToolBuffer.get(tcFull.toolCallId ?? "");
          let finalInput = (tcFull.input ?? {}) as Record<string, unknown>;
          let wasRemapped = false;

          if (claudeAdapter.remapToolArgs) {
            const remap = claudeAdapter.remapToolArgs(tcFull.toolName ?? "", finalInput);
            finalInput = remap.input;
            wasRemapped = remap.remapped;
          }

          // Adapter-neutral: detect malformed Write content and rewrite as Bash heredoc
          let emitToolName = buf?.toolName ?? tcFull.toolName ?? "";
          const repair = repairWriteToolCall(emitToolName, finalInput);
          if (repair) {
            emitToolName = repair.rewrittenToolName;
            finalInput = repair.rewrittenInput;
            app.log.warn({
              reqId: traceReqId, originalTool: tcFull.toolName,
              rewrittenTo: repair.rewrittenToolName,
              filePath: (tcFull.input as Record<string, unknown>)?.file_path ?? (tcFull.input as Record<string, unknown>)?.path,
            }, "write_tool_repaired_to_bash_heredoc");
          }

          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({
              reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId,
              argsLen: JSON.stringify(finalInput).length,
              argsPreview: JSON.stringify(finalInput).slice(0, 300),
              remapped: wasRemapped, repaired: !!repair,
              adapterFamily: claudeAdapter.family,
            }, "claude_tool_call_streamed");
          }

          // Emit buffered tool call: start + single delta with normalized JSON + stop
          const toolCallId = tcFull.toolCallId ?? "";
          safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: toolCallId, name: emitToolName } });
          const normalizedJson = JSON.stringify(finalInput);
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: normalizedJson } });
          safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
          claudeToolBuffer.delete(toolCallId);
          stopReason = "tool_use";
        }
      }
    } catch (streamErr) {
      const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
      app.log.error({ err: streamErr, reqId: traceReqId, model: resolved.resolvedModelId }, `Claude stream error: ${detail}`);
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "stream_error", "streamText", detail.slice(0, 500), traceReqId, { model: resolved.resolvedModelId });
      if (!inTextBlock) {
        safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
        inTextBlock = true;
      }
      safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: `\n\n[Upstream provider error — retrying may help]` } });
      stopReason = "end_turn";
    }

    if (inTextBlock) {
      safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
    }

    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
    try { usage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
    safeSse(reply, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
    });
    safeSse(reply, "message_stop", { type: "message_stop" });
    safeEnd(reply.raw);

    let claudeStreamedText = "";
    try { claudeStreamedText = await streamed.text; } catch { /* stream aborted */ }
    if (claudeStreamedText) {
      session.history.push({ role: "assistant", content: claudeStreamedText });
    }
    const claudeStreamLatency = Date.now() - started;
    const claudeStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, claudeStreamLatency, stopReason, claudeStreamSaved);
    maybeCheckpoint(session);
    const claudeStreamMsgCounts = countMessageRoles(openAIShape.messages as Array<{ role: string; content: unknown }>);
    pushDiagnostic({
      timestamp: Date.now(), sessionKey: claudeSessionKey, path: "/v1/messages (stream)",
      ...claudeStreamMsgCounts,
      toolDefinitionCount: (body.tools as unknown[] ?? []).length,
      artifactToolInjected: false,
      reducedToolResults: claudeToolResultCount,
      finishReason: stopReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
      policyDecision: claudePolicyPrecheck.matchedRules.join(","), latencyMs: claudeStreamLatency
    });
    return reply;
  }

  // Non-streaming
  const started = Date.now();
  let result;
  try {
    result = await generateText({
      model: resolved.model as never,
      messages,
      maxOutputTokens: claudeOrchestration.maxOutputTokens,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {})
    });
  } catch (err) {
    app.log.error({ err, reqId, model: resolved.resolvedModelId }, "Claude non-stream generateText failed");
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "upstream_error", "generateText", sanitizeUpstreamError(err), reqId, { model: resolved.resolvedModelId });
    return reply.code(502).send({
      type: "error",
      error: { type: "upstream_error", message: sanitizeUpstreamError(err) }
    });
  }
  const allToolCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
  const externalClaudeToolCalls = allToolCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);
  const reasoning = (result as unknown as { reasoning?: string }).reasoning;
  const usage = readUsage((result as unknown as { usage?: unknown }).usage);
  const stopReason = externalClaudeToolCalls.length > 0 ? "tool_use" : "end_turn";
  if (result.text) {
    session.history.push({ role: "assistant", content: result.text });
  }
  const claudeNonStreamLatency = Date.now() - started;
  const claudeNonStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, claudeNonStreamLatency, stopReason, claudeNonStreamSaved);
  maybeCheckpoint(session);
  const claudeNonStreamMsgCounts = countMessageRoles(openAIShape.messages as Array<{ role: string; content: unknown }>);
  pushDiagnostic({
    timestamp: Date.now(), sessionKey: claudeSessionKey, path: "/v1/messages",
    ...claudeNonStreamMsgCounts,
    toolDefinitionCount: (body.tools as unknown[] ?? []).length,
    artifactToolInjected: false,
    reducedToolResults: claudeToolResultCount,
    finishReason: stopReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
    policyDecision: claudePolicyPrecheck.matchedRules.join(","), latencyMs: claudeNonStreamLatency
  });

  const content: Array<Record<string, unknown>> = [];
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (result.text) {
    content.push({ type: "text", text: result.text });
  }
  if (externalClaudeToolCalls.length > 0) {
    for (const tc of sdkToolCallsToClaude(externalClaudeToolCalls)) {
      content.push({ ...tc });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return reply.send({
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: resolved.resolvedModelId,
    content,
    stop_reason: stopReason,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
  });
});

await refreshTierRegistry();
void pricingRegistry.start();
const tierPollTimer = setInterval(() => {
  void refreshTierRegistry();
}, config.SYNESIS_YARN_TIER_POLL_INTERVAL * 1000);

await app.listen({ port: config.PORT, host: config.HOST });
