import crypto from "node:crypto";
import Fastify from "fastify";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  createServiceMetrics,
  recordUsageMetrics,
  computeCost,
  emitTrace,
  type LlmUsage as TelemetryLlmUsage,
  type PricingSource,
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
import { KnowledgeSearchService, KNOWLEDGE_TOOL_NAME } from "./state/knowledge-search.js";
import { runEvidencePrefetch, formatEvidenceBlock } from "./evidence/fast-path.js";
import { ToolResultReductionService } from "./reduction/tool-result-reducer.js";
import { WorkingFrameService, type ManifestContext } from "./frame/working-frame-service.js";
import { ProjectManifestService } from "./project/project-manifest-service.js";
import { getTemplate as manifestGetTemplate } from "@synesis/manifest";
import { classify as manifestClassify } from "./manifest/classifier.js";
import { scanForManifest as manifestScan } from "./manifest/repo-scanner.js";
import { compareManifests as manifestCompare } from "./manifest/comparator.js";
import { critiquStructure as manifestCritique } from "./manifest/structural-critic.js";
import { registerMcpRoutes } from "./mcp/index.js";
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
import { CircuitBreakerRegistry } from "./providers/circuit-breaker.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { initOtel, getTracer } from "./telemetry/otel.js";
import { DistributedCounterService } from "./state/distributed-counters.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";

type SessionState = {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  toolCallsSinceCheckpoint: number;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
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
let DIAGNOSTIC_RING_MAX = 20;

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
const usagePersistenceEnabled =
  config.SYNESIS_YARN_PERSIST_USAGE_TO_DB && Boolean(String(config.SYNESIS_YARN_ADMIN_DB_URL ?? "").trim());
if (!usagePersistenceEnabled) {
  app.log.warn(
    {
      persistFlag: config.SYNESIS_YARN_PERSIST_USAGE_TO_DB,
      hasAdminDbUrl: Boolean(String(config.SYNESIS_YARN_ADMIN_DB_URL ?? "").trim()),
    },
    "yarn_usage_persistence_disabled: set SYNESIS_YARN_ADMIN_DB_URL to the same Postgres URL admin uses, or admin Yarn pages stay stale/empty",
  );
} else {
  app.log.info("yarn_usage_persistence_enabled");
}
const authResolver = new AuthResolver(config);
const artifactStore = new ArtifactStore({
  maxCount: config.SYNESIS_YARN_ARTIFACT_MAX_COUNT,
  ttlMs: config.SYNESIS_YARN_ARTIFACT_TTL_MS,
  maxPayloadBytes: config.SYNESIS_YARN_ARTIFACT_MAX_PAYLOAD_BYTES,
});
const artifactRetrieval = new ArtifactRetrievalService(artifactStore);
const knowledgeSearch = new KnowledgeSearchService(config.SYNESIS_YARN_MCP_SERVICE_URL);
const validationNormalization = new ValidationNormalizationService(config, artifactStore);
const toolResultReduction = new ToolResultReductionService(config, artifactStore);
const workingFrameService = new WorkingFrameService(config.SYNESIS_YARN_FRAME_MAX_FILES);
const projectManifestService = new ProjectManifestService();
const policyEngine = new DeterministicPolicyEngine({
  maxRepeatEntries: config.SYNESIS_YARN_POLICY_REPEAT_MAP_MAX,
  repeatEntryTtlMs: config.SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS,
});

import { GovernanceClient } from "./policy/governance-client.js";
const governanceClient = config.SYNESIS_YARN_GOVERNANCE_ENABLED
  ? new GovernanceClient(config)
  : null;
if (governanceClient) governanceClient.start();
const circuitBreakers = new CircuitBreakerRegistry({
  failureThreshold: config.SYNESIS_YARN_BREAKER_FAILURE_THRESHOLD,
  recoveryTimeoutMs: config.SYNESIS_YARN_BREAKER_RECOVERY_TIMEOUT_MS,
  halfOpenMax: config.SYNESIS_YARN_BREAKER_HALF_OPEN_MAX,
});
const userRateLimiter = new UserRateLimiter({
  windowMs: config.SYNESIS_YARN_RATE_LIMIT_WINDOW_MS,
  maxRequests: config.SYNESIS_YARN_RATE_LIMIT_MAX_REQUESTS,
});
const distributedCounters = new DistributedCounterService(config);
const streamAdmission = new StreamAdmissionController({
  maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
  maxQueueDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
  queueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
});
DIAGNOSTIC_RING_MAX = config.SYNESIS_YARN_DIAGNOSTIC_RING_MAX;
await initOtel(config);
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
    if (config.SYNESIS_YARN_MANIFEST_TEMPLATES_ENABLED) {
      const latestUser = [...out].reverse().find((m) => m.role === "user");
      const userText = typeof latestUser?.content === "string" ? latestUser.content : "";
      const allText = out.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
      const { classification, complexity: complexityResult } = manifestClassify(userText);

      if (complexityResult.complexity === "tiny" || complexityResult.complexity === "small") {
        const frame = workingFrameService.build(out);
        volatileBlocks.push({ role: "system", content: workingFrameService.toSystemBlock(frame) });
      } else {
        const template = manifestGetTemplate(classification.projectKind);
        const filePaths = (allText.match(FILE_RE_GLOBAL) ?? []).map((f: string) => f.trim());
        const observed = manifestScan({ filePaths, conversationText: allText });
        const manifestCtx: ManifestContext = { complexity: complexityResult.complexity };

        if (template) {
          const comparison = manifestCompare(template.manifest, observed);
          manifestCtx.manifest = template.manifest;
          manifestCtx.comparison = comparison;

          if (config.SYNESIS_YARN_STRUCTURAL_CRITIC_ENABLED) {
            const critique = manifestCritique(comparison);
            if (!critique.passed && critique.requiredMissing > 0) {
              volatileBlocks.push({
                role: "system",
                content: `<STRUCTURAL_CRITIC>\n${critique.summary}\n</STRUCTURAL_CRITIC>`,
              });
            }
          }
        } else {
          manifestCtx.manifest = observed;
        }

        const richFrame = workingFrameService.buildRich(out, manifestCtx);
        volatileBlocks.push({ role: "system", content: workingFrameService.toRichSystemBlock(richFrame) });
      }
    } else {
      const frame = workingFrameService.build(out);
      volatileBlocks.push({ role: "system", content: workingFrameService.toSystemBlock(frame) });
    }
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

const FILE_RE_GLOBAL = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;

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
  const metaConsecutive = Number(record.metadata?.consecutive_tool_calls ?? 0);
  const metaStagnant = Number(record.metadata?.stagnant_tool_cycles ?? 0);
  const metaToolSignalHash = String(record.metadata?.last_tool_signal_hash ?? "");
  const metaAwaitingAck = record.metadata?.awaiting_tool_loop_user_ack === true;
  const metaAckAnchorHash = String(record.metadata?.tool_loop_ack_anchor_user_hash ?? "");
  const metaNoAckCount = Number(record.metadata?.tool_loop_no_user_ack_count ?? 0);
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

  const state: SessionState = {
    history,
    toolCallsSinceCheckpoint: 0,
    consecutiveToolCalls: Number.isFinite(metaConsecutive) ? metaConsecutive : 0,
    stagnantToolCycles: Number.isFinite(metaStagnant) ? metaStagnant : 0,
    lastToolSignalHash: metaToolSignalHash,
    awaitingToolLoopUserAck: metaAwaitingAck,
    toolLoopAckAnchorUserHash: metaAckAnchorHash,
    toolLoopNoUserAckCount: Number.isFinite(metaNoAckCount) ? metaNoAckCount : 0,
    record
  };
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
    tierRegistry.updateTiers(tiers);
    if (tiers.length > 0) {
      app.log.info({ tiers: tiers.map((t) => t.id) }, "tier_registry_refreshed");
      for (const t of tiers) {
        if (!t.apiKey?.trim()) {
          app.log.warn(
            { tier: t.id, baseUrl: t.baseUrl, backendModel: t.backendModel },
            "tier_missing_api_key_env — set the key in provider-api-keys secret (same namespace as yarn) or SYNESIS_YARN_OPENAI_COMPAT_API_KEY",
          );
        }
      }
    } else {
      app.log.warn(
        {},
        "tier_registry_empty — no assigned coder-pulse / coder-core / coder-horizon / coder-compaction roles in admin, or role fetch returned none",
      );
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
import {
  normalizeHallucinatedLinuxWritePath,
  repairBashToolCall,
  repairWriteToolCall,
} from "./providers/model-adapter.js";

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
  const tierRates = {
    input_per_million: Number(tier?.inputPerM ?? 0),
    output_per_million: Number(tier?.outputPerM ?? 0),
    cached_input_per_million: tier?.cachedPerM ?? null,
  };
  let pricingSource: PricingSource = tier?.pricingSource ?? "unknown";
  let computedCostUsd: number;
  if (usage.costUsd > 0) {
    computedCostUsd = usage.costUsd;
    pricingSource = "provider";
  } else {
    const result = computeCost(
      {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        cached_prompt_tokens: usage.cachedTokens,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
      tierRates,
    );
    computedCostUsd = result.estimated_cost_usd;
    pricingSource = result.pricing_source;
  }
  const normalizedCostUsd = Number.isFinite(computedCostUsd) ? Math.max(0, computedCostUsd) : 0;
  if (pricingSource === "fallback_base" && (usage.inputTokens + usage.outputTokens) > 0) {
    app.log.info({
      model: resolvedModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricingSource,
      tierInputPerM: tier?.inputPerM ?? null,
      tierOutputPerM: tier?.outputPerM ?? null,
    }, "fallback_pricing_in_effect: set rates in admin Model Registry for accurate costs");
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
    state.stagnantToolCycles = 0;
    state.lastToolSignalHash = "";
  }
  state.record.metadata.consecutive_tool_calls = state.consecutiveToolCalls;
  state.record.metadata.stagnant_tool_cycles = state.stagnantToolCycles;
  state.record.metadata.last_tool_signal_hash = state.lastToolSignalHash;
  state.record.metadata.awaiting_tool_loop_user_ack = state.awaitingToolLoopUserAck;
  state.record.metadata.tool_loop_ack_anchor_user_hash = state.toolLoopAckAnchorUserHash;
  state.record.metadata.tool_loop_no_user_ack_count = state.toolLoopNoUserAckCount;

  void distributedCounters.setConsecutiveToolCalls(
    state.record.sessionKey,
    state.consecutiveToolCalls
  );

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
    pricingSource,
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
    conversation_id: state.record.sessionKey,
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

type ToolProgressState = "stagnant" | "progress" | "unknown";

function normalizeForSignal(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? "";
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeForSignal(v));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) out[key] = normalizeForSignal((value as Record<string, unknown>)[key]);
  return out;
}

function stableSignalString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  return JSON.stringify(normalizeForSignal(value));
}

function hashTextSignal(value: unknown): string {
  const text = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : stableSignalString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text.slice(0, 4000)).digest("hex");
}

function detectToolProgress(
  session: SessionState,
  messages: Array<{ role: string; content: unknown }>
): { state: ToolProgressState; signalHash: string | null } {
  const toolMessages = [...messages].reverse().filter((m) => m.role === "tool");
  if (toolMessages.length === 0) {
    return { state: "unknown", signalHash: null };
  }
  const latest = toolMessages[0];
  const signal = stableSignalString(latest.content).slice(0, 4000);
  const hash = crypto.createHash("sha256").update(signal).digest("hex");
  if (!session.lastToolSignalHash) {
    session.lastToolSignalHash = hash;
    session.stagnantToolCycles = 0;
    return { state: "progress", signalHash: hash };
  }
  if (session.lastToolSignalHash === hash) {
    session.stagnantToolCycles += 1;
    return { state: "stagnant", signalHash: hash };
  }
  session.lastToolSignalHash = hash;
  session.stagnantToolCycles = 0;
  return { state: "progress", signalHash: hash };
}

function toolLoopSoftFailMessage(decision: PolicyDecision): string {
  const reason = decision.rejectReason ?? "Tool loop policy triggered before another automated action.";
  return [
    "I paused automated tool execution to avoid getting stuck in a repair loop.",
    reason,
    "If you want me to continue, share one adjustment (for example: install missing local tools, choose a different command, or confirm a narrower fix strategy) and I will resume from here."
  ].join(" ");
}

function sendOpenAISoftFail(
  reply: import("fastify").FastifyReply,
  requestId: string,
  model: string,
  content: string,
  stream: boolean
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
    });
  }

  const ts = Math.floor(Date.now() / 1000);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })}\n\n`);
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  return reply;
}

function sendClaudeSoftFail(
  reply: import("fastify").FastifyReply,
  model: string,
  content: string,
  stream: boolean
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 }
    });
  }

  const msgId = `msg_${crypto.randomUUID()}`;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  safeSse(reply, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [] }
  });
  safeSse(reply, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });
  safeSse(reply, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: content }
  });
  safeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  safeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 0, output_tokens: 0 }
  });
  safeSse(reply, "message_stop", { type: "message_stop" });
  safeEnd(reply.raw);
  return reply;
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

async function proxyMcpGet(
  path: string,
  bearer: string,
  headers?: { requestId?: string; traceparent?: string },
): Promise<unknown> {
  const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(headers?.requestId ? { "x-request-id": headers.requestId } : {}),
      ...(headers?.traceparent ? { traceparent: headers.traceparent } : {}),
    }
  });
  if (!response.ok) {
    throw new Error(`MCP upstream error ${response.status}`);
  }
  return response.json();
}

async function proxyMcpPost(
  path: string,
  bearer: string,
  body: unknown,
  headers?: { requestId?: string; traceparent?: string },
): Promise<unknown> {
  const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...(headers?.requestId ? { "x-request-id": headers.requestId } : {}),
      ...(headers?.traceparent ? { traceparent: headers.traceparent } : {}),
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
  streamAdmission.close();
  userRateLimiter.close();
  policyEngine.close();
  governanceClient?.close();
  artifactStore.close();
  await app.close();
  await Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close(), distributedCounters.close()]);
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
app.get("/health", async () => ({
  status: "ok",
  usage_persistence_enabled: usagePersistenceEnabled,
  usage_write_queue: usageWriter.getStats(),
}));
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
    governance: governanceClient ? governanceClient.getStats() : { enabled: false },
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
    knowledgeSearch: knowledgeSearch.getStats(),
    artifactStore: artifactStore.getStats(),
    circuitBreakers: circuitBreakers.getStats(),
    userRateLimiter: userRateLimiter.getStats(),
    distributedCounters: distributedCounters.getStats(),
    streamAdmission: streamAdmission.getStats(),
    attentionPositioning: attentionPositioning.getStats(),
    compressionEfficiencyIndex: computeEfficiencyIndex(),
    sessionContinuity: sessionContinuity.getStats(),
    diagnosticRingMax: DIAGNOSTIC_RING_MAX,
    diagnosticRingCurrent: diagnosticRing.length,
    featureFlags: {
      stablePrefix: config.SYNESIS_YARN_STABLE_PREFIX_ENABLED,
      jsonCompaction: config.SYNESIS_YARN_JSON_COMPACTION_ENABLED,
      attentionPositioning: config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED,
      artifactRetrieval: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeSearch: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      evidencePrefetch: config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED,
      governance: config.SYNESIS_YARN_GOVERNANCE_ENABLED,
      sessionContinuity: config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED,
      contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED,
      claudeToolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
      jitterBuffer: config.SYNESIS_YARN_JITTER_BUFFER_ENABLED,
      sortedTools: config.SYNESIS_YARN_SORTED_TOOLS_ENABLED,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      otelEnabled: config.SYNESIS_YARN_OTEL_ENABLED,
    },
    safetyLimits: {
      hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
      sessionMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
      consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
      consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
      stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
      toolLoopNoUserAckLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
      toolLoopSoftFailEnabled: config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
      maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
      streamQueueMaxDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
      streamQueueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
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

// --- Native MCP tools (replaces Python MCP proxy) ---
await registerMcpRoutes(app, {
  authResolver,
  enabled: config.SYNESIS_YARN_MCP_TOOLS_ENABLED,
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

  const oaiRateResult = userRateLimiter.check(authUser.userId);
  if (!oaiRateResult.allowed) {
    app.log.warn({ userId: authUser.userId, count: oaiRateResult.currentCount, limit: oaiRateResult.limit }, "rate_limit_rejected");
    recordSessionEvent("", authUser.userId, authUser.orgId, "rate_limit_reject", "user-rate-limiter",
      `${oaiRateResult.currentCount}/${oaiRateResult.limit} in window — retry after ${oaiRateResult.retryAfterSeconds}s`);
    reply.header("Retry-After", String(oaiRateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${oaiRateResult.retryAfterSeconds} seconds.` } });
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

  const oaiLastToolId = [...(request.messages as Array<{ role: string; tool_call_id?: string }>)]
    .reverse().find((m) => m.role === "tool")?.tool_call_id ?? "";
  const latestOpenAIUserHash = hashTextSignal(latestUserText?.content ?? "");
  if (session.awaitingToolLoopUserAck) {
    if (latestOpenAIUserHash && latestOpenAIUserHash !== session.toolLoopAckAnchorUserHash) {
      session.awaitingToolLoopUserAck = false;
      session.toolLoopNoUserAckCount = 0;
      session.toolLoopAckAnchorUserHash = "";
    } else {
      session.toolLoopNoUserAckCount += 1;
    }
  }
  const oaiToolProgress = detectToolProgress(
    session,
    normalizedOpenAI.messages as Array<{ role: string; content: unknown }>
  );
  const distToolCalls = await distributedCounters.getConsecutiveToolCalls(sessionKey);
  if (distToolCalls !== null && distToolCalls !== session.consecutiveToolCalls) {
    session.consecutiveToolCalls = distToolCalls;
  }
  const policyPrecheck = policyEngine.evaluate({
    tools: request.tools as unknown[],
    repeatAttempt: {
      action: "chat_completion",
      args: { model: request.model, lastToolId: oaiLastToolId },
      fsFingerprint: oaiLastToolId || "none"
    },
    sessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    toolProgressState: oaiToolProgress.state,
    stagnantToolCycles: session.stagnantToolCycles,
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
    governanceRules: governanceClient?.getRules(),
  });
  if (!policyPrecheck.allow) {
    logAndPersistSafetyEvent(policyPrecheck, sessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && policyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(policyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      session.awaitingToolLoopUserAck = true;
      session.toolLoopAckAnchorUserHash = latestOpenAIUserHash;
      session.toolLoopNoUserAckCount = 0;
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        oaiTraceReqId,
        orchestration.selectedModel,
        usage,
        Date.now() - started,
        "stop",
        0
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "tool_loop_soft_fail",
        "deterministic-policy",
        policyPrecheck.rejectReason ?? "Tool loop soft fail",
        oaiTraceReqId
      );
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, content, !!request.stream);
    }
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
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "trust_block", "transcript-trust", trustResult.blockDetail ?? "Content blocked", oaiTraceReqId);
    return reply.code(400).send({ error: { type: "invalid_request_error", message: "Request could not be processed." } });
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
  if (config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED) {
    normalizedRequest.tools = knowledgeSearch.injectToolOpenAI(normalizedRequest.tools as unknown[]) as never;
  }

  if (config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED && latestUserText) {
    const userText = typeof latestUserText.content === "string" ? latestUserText.content : "";
    if (userText.length > 0) {
      const prefetchResult = await runEvidencePrefetch(
        userText,
        knowledgeSearch,
        config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
      );
      if (prefetchResult.matched) {
        app.log.info({
          pattern: prefetchResult.pattern,
          hasEvidence: Boolean(prefetchResult.evidence),
          timedOut: prefetchResult.timedOut,
          latencyMs: Math.round(prefetchResult.latencyMs),
        }, "evidence_prefetch_result");
      }
      const evidenceBlock = formatEvidenceBlock(prefetchResult);
      if (evidenceBlock) {
        const msgs = normalizedRequest.messages as Array<{ role: string; content: unknown }>;
        const sysIdx = msgs.findIndex((m) => m.role === "system");
        if (sysIdx >= 0 && typeof msgs[sysIdx].content === "string") {
          msgs[sysIdx] = { ...msgs[sysIdx], content: `${msgs[sysIdx].content}\n\n${evidenceBlock}` };
        } else {
          msgs.unshift({ role: "system", content: evidenceBlock });
        }
        normalizedRequest.messages = msgs as never;
      }
    }
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
  const modelMessages = modelToolPrompt
    ? ([{ role: "system" as const, content: modelToolPrompt }, ...messages] as typeof messages)
    : messages;
  const adapterProviderOptions = adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined;

  if (!normalizedRequest.stream) {
    if (!circuitBreakers.allowRequest(resolved.resolvedModelId, identity.orgId)) {
      app.log.warn({ model: resolved.resolvedModelId, orgId: identity.orgId }, "circuit_breaker_open");
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "breaker_open_reject", "circuit-breaker",
        `Circuit breaker open for ${resolved.resolvedModelId}`, reqId, { model: resolved.resolvedModelId });
      reply.header("Retry-After", "30");
      return reply.code(503).send({ error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } });
    }
    const otelSpan = getTracer().startSpan("yarn.openai.generate", { model: resolved.resolvedModelId, sessionKey });
    const started = Date.now();
    let finalResult;
    try {
      let currentMessages = modelMessages;
      finalResult = await generateText({
        model: resolved.model as never,
        messages: currentMessages,
        maxOutputTokens: orchestration.maxOutputTokens,
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
        ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
      });

      const SERVER_SIDE_TOOLS = new Set([ARTIFACT_TOOL_NAME, KNOWLEDGE_TOOL_NAME]);
      for (let round = 0; round < 3; round++) {
        const allCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
        const serverCalls = allCalls.filter((tc) => SERVER_SIDE_TOOLS.has(tc.toolName));
        if (serverCalls.length === 0) break;
        const clientCalls = allCalls.filter((tc) => !SERVER_SIDE_TOOLS.has(tc.toolName));

        const toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }> = [];
        for (const ac of serverCalls) {
          if (ac.toolName === ARTIFACT_TOOL_NAME) {
            const inp = ac.input as { artifact_handle?: string; query?: string };
            const result = artifactRetrieval.retrieve(inp.artifact_handle ?? "", inp.query);
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: ARTIFACT_TOOL_NAME,
              output: { type: "text", value: result.content }
            });
          } else if (ac.toolName === KNOWLEDGE_TOOL_NAME) {
            const inp = ac.input as Record<string, unknown>;
            const result = await knowledgeSearch.resolve(inp, {
              orgId: identity.orgId,
              userId: identity.userId,
            });
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: KNOWLEDGE_TOOL_NAME,
              output: { type: "text", value: JSON.stringify(result) }
            });
          }
        }

        if (clientCalls.length > 0) break;

        const assistantParts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
        if (finalResult.text) assistantParts.push({ type: "text", text: finalResult.text });
        for (const ac of serverCalls) {
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
      circuitBreakers.recordFailure(resolved.resolvedModelId, identity.orgId);
      otelSpan.setStatus("error", sanitizeUpstreamError(err));
      otelSpan.end();
      app.log.error({ err, reqId, model: resolved.resolvedModelId }, "OpenAI non-stream generateText failed");
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "upstream_error", "generateText", sanitizeUpstreamError(err), reqId, { model: resolved.resolvedModelId });
      return reply.code(502).send({ error: { type: "upstream_error", message: sanitizeUpstreamError(err) } });
    }
    circuitBreakers.recordSuccess(resolved.resolvedModelId, identity.orgId);
    otelSpan.setStatus("ok");
    otelSpan.end();

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

  const oaiAdmission = await streamAdmission.acquire();
  if (!oaiAdmission.admitted) {
    app.log.warn({ reason: oaiAdmission.reason, queueStats: streamAdmission.getStats() }, "stream_admission_rejected");
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "stream_admission_reject", "stream-admission",
      oaiAdmission.reason ?? "stream admission rejected", reqId);
    reply.header("Retry-After", String(oaiAdmission.retryAfterSeconds ?? 5));
    return reply.code(503).send({ error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } });
  }

  if (!circuitBreakers.allowRequest(resolved.resolvedModelId, identity.orgId)) {
    oaiAdmission.release!();
    app.log.warn({ model: resolved.resolvedModelId, orgId: identity.orgId }, "circuit_breaker_open_stream");
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "breaker_open_reject", "circuit-breaker",
      `Circuit breaker open for ${resolved.resolvedModelId} (stream)`, reqId, { model: resolved.resolvedModelId });
    reply.header("Retry-After", "30");
    return reply.code(503).send({ error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } });
  }
  const otelStreamSpan = getTracer().startSpan("yarn.openai.stream", { model: resolved.resolvedModelId, sessionKey });
  const started = Date.now();
  const streamed = streamText({
    model: resolved.model as never,
    messages: modelMessages,
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
    circuitBreakers.recordFailure(resolved.resolvedModelId, identity.orgId);
    otelStreamSpan.setStatus("error", sanitizeUpstreamError(streamErr));
    const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
    app.log.error({ err: streamErr, reqId, model: resolved.resolvedModelId }, `OpenAI stream error: ${detail}`);
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "stream_error", "streamText", detail.slice(0, 500), reqId, { model: resolved.resolvedModelId });
    finishReason = "error";
    safeWrite(reply.raw, `data: ${JSON.stringify({
      id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
      choices: [{ index: 0, delta: { content: "\n\n[Upstream provider error — retrying may help]" }, finish_reason: null }]
    })}\n\n`);
  }

  oaiAdmission.release!();

  if (finishReason !== "error") {
    circuitBreakers.recordSuccess(resolved.resolvedModelId, identity.orgId);
    otelStreamSpan.setStatus("ok");
  }
  otelStreamSpan.end();

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

  const claudeRateResult = userRateLimiter.check(claudeAuthUser.userId);
  if (!claudeRateResult.allowed) {
    app.log.warn({ userId: claudeAuthUser.userId, count: claudeRateResult.currentCount, limit: claudeRateResult.limit }, "rate_limit_rejected_claude");
    recordSessionEvent("", claudeAuthUser.userId, claudeAuthUser.orgId, "rate_limit_reject", "user-rate-limiter",
      `${claudeRateResult.currentCount}/${claudeRateResult.limit} in window — retry after ${claudeRateResult.retryAfterSeconds}s`);
    reply.header("Retry-After", String(claudeRateResult.retryAfterSeconds));
    return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${claudeRateResult.retryAfterSeconds} seconds.` } });
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

  const claudeLastToolUseId = [...(body.messages as Array<{ role: string; content: unknown }>)]
    .reverse()
    .flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .find((b: Record<string, unknown>) => b.type === "tool_result")
    ?.tool_use_id as string ?? "";
  const latestClaudeUserHash = hashTextSignal(latestClaudeUser?.content ?? "");
  if (session.awaitingToolLoopUserAck) {
    if (latestClaudeUserHash && latestClaudeUserHash !== session.toolLoopAckAnchorUserHash) {
      session.awaitingToolLoopUserAck = false;
      session.toolLoopNoUserAckCount = 0;
      session.toolLoopAckAnchorUserHash = "";
    } else {
      session.toolLoopNoUserAckCount += 1;
    }
  }
  const claudeToolProgress = detectToolProgress(
    session,
    normalizedFromClaude.messages as Array<{ role: string; content: unknown }>
  );
  const claudeDistToolCalls = await distributedCounters.getConsecutiveToolCalls(claudeSessionKey);
  if (claudeDistToolCalls !== null && claudeDistToolCalls !== session.consecutiveToolCalls) {
    session.consecutiveToolCalls = claudeDistToolCalls;
  }
  const claudePolicyPrecheck = policyEngine.evaluate({
    tools: (body.tools as unknown[]) ?? [],
    repeatAttempt: {
      action: "claude_messages",
      args: { model: body.model, lastToolUseId: claudeLastToolUseId },
      fsFingerprint: claudeLastToolUseId || "none"
    },
    sessionKey: claudeSessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    toolProgressState: claudeToolProgress.state,
    stagnantToolCycles: session.stagnantToolCycles,
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
    governanceRules: governanceClient?.getRules(),
  });
  if (!claudePolicyPrecheck.allow) {
    logAndPersistSafetyEvent(claudePolicyPrecheck, claudeSessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && claudePolicyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(claudePolicyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      session.awaitingToolLoopUserAck = true;
      session.toolLoopAckAnchorUserHash = latestClaudeUserHash;
      session.toolLoopNoUserAckCount = 0;
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        traceReqId,
        claudeOrchestration.selectedModel,
        usage,
        Date.now() - started,
        "end_turn",
        0
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "tool_loop_soft_fail",
        "deterministic-policy",
        claudePolicyPrecheck.rejectReason ?? "Tool loop soft fail",
        traceReqId
      );
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, content, !!body.stream);
    }
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
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "trust_block", "transcript-trust", claudeTrustResult.blockDetail ?? "Content blocked", traceReqId);
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: "Request could not be processed." }
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
  const claudeModelMessages = claudeModelToolPrompt
    ? ([{ role: "system" as const, content: claudeModelToolPrompt }, ...messages] as typeof messages)
    : messages;

  const adapterClaudeProviderOptions = claudeAdapter.providerOptions?.();
  const providerOptions = body.thinking
    ? { openai: { thinking: body.thinking, ...(adapterClaudeProviderOptions?.openai ?? {}) }, ...(adapterClaudeProviderOptions ? Object.fromEntries(Object.entries(adapterClaudeProviderOptions).filter(([k]) => k !== "openai")) : {}) }
    : adapterClaudeProviderOptions;

  if (body.stream) {
    const claudeAdmission = await streamAdmission.acquire();
    if (!claudeAdmission.admitted) {
      app.log.warn({ reason: claudeAdmission.reason, queueStats: streamAdmission.getStats() }, "stream_admission_rejected_claude");
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "stream_admission_reject", "stream-admission",
        claudeAdmission.reason ?? "stream admission rejected", traceReqId);
      reply.header("Retry-After", String(claudeAdmission.retryAfterSeconds ?? 5));
      return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." } });
    }

    if (!circuitBreakers.allowRequest(resolved.resolvedModelId, claudeIdentity.orgId)) {
      claudeAdmission.release!();
      app.log.warn({ model: resolved.resolvedModelId, orgId: claudeIdentity.orgId }, "circuit_breaker_open_claude_stream");
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "breaker_open_reject", "circuit-breaker",
        `Circuit breaker open for ${resolved.resolvedModelId} (claude stream)`, traceReqId, { model: resolved.resolvedModelId });
      reply.header("Retry-After", "30");
      return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." } });
    }
    const claudeStreamSpan = getTracer().startSpan("yarn.claude.stream", { model: resolved.resolvedModelId, sessionKey: claudeSessionKey });
    const started = Date.now();
    const streamed = streamText({
      model: resolved.model as never,
      messages: claudeModelMessages,
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

          let emitToolName = buf?.toolName ?? tcFull.toolName ?? "";
          if (emitToolName === "Write") {
            const fp = finalInput.file_path;
            if (typeof fp === "string" && fp.trim()) {
              const n = normalizeHallucinatedLinuxWritePath(fp);
              if (n !== fp) {
                finalInput = { ...finalInput, file_path: n };
              }
            }
          }

          // Adapter-neutral: detect malformed Write content and rewrite as Bash heredoc
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

          const bashRepair = repairBashToolCall(emitToolName, finalInput);
          if (bashRepair) {
            finalInput = bashRepair.input;
            app.log.warn(
              { reqId: traceReqId, toolName: emitToolName, bashRepaired: bashRepair.repaired },
              "bash_tool_args_repaired",
            );
          }

          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({
              reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId,
              argsLen: JSON.stringify(finalInput).length,
              argsPreview: JSON.stringify(finalInput).slice(0, 300),
              remapped: wasRemapped, repaired: !!repair || !!bashRepair,
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
      circuitBreakers.recordFailure(resolved.resolvedModelId, claudeIdentity.orgId);
      claudeStreamSpan.setStatus("error", sanitizeUpstreamError(streamErr));
      app.log.error({ err: streamErr, reqId: traceReqId, model: resolved.resolvedModelId }, `Claude stream error: ${detail}`);
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "stream_error", "streamText", detail.slice(0, 500), traceReqId, { model: resolved.resolvedModelId });
      if (!inTextBlock) {
        safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
        inTextBlock = true;
      }
      safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: `\n\n[Upstream provider error — retrying may help]` } });
      stopReason = "end_turn";
    }

    claudeAdmission.release!();

    if (stopReason !== "end_turn" || !inTextBlock) {
      circuitBreakers.recordSuccess(resolved.resolvedModelId, claudeIdentity.orgId);
      claudeStreamSpan.setStatus("ok");
    }
    claudeStreamSpan.end();

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
  if (!circuitBreakers.allowRequest(resolved.resolvedModelId, claudeIdentity.orgId)) {
    app.log.warn({ model: resolved.resolvedModelId, orgId: claudeIdentity.orgId }, "circuit_breaker_open_claude");
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "breaker_open_reject", "circuit-breaker",
      `Circuit breaker open for ${resolved.resolvedModelId} (claude)`, reqId, { model: resolved.resolvedModelId });
    reply.header("Retry-After", "30");
    return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." } });
  }
  const claudeNonStreamSpan = getTracer().startSpan("yarn.claude.generate", { model: resolved.resolvedModelId, sessionKey: claudeSessionKey });
  const started = Date.now();
  let result;
  try {
    result = await generateText({
      model: resolved.model as never,
      messages: claudeModelMessages,
      maxOutputTokens: claudeOrchestration.maxOutputTokens,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {})
    });
  } catch (err) {
    circuitBreakers.recordFailure(resolved.resolvedModelId, claudeIdentity.orgId);
    claudeNonStreamSpan.setStatus("error", sanitizeUpstreamError(err));
    claudeNonStreamSpan.end();
    app.log.error({ err, reqId, model: resolved.resolvedModelId }, "Claude non-stream generateText failed");
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "upstream_error", "generateText", sanitizeUpstreamError(err), reqId, { model: resolved.resolvedModelId });
    return reply.code(502).send({
      type: "error",
      error: { type: "upstream_error", message: sanitizeUpstreamError(err) }
    });
  }
  circuitBreakers.recordSuccess(resolved.resolvedModelId, claudeIdentity.orgId);
  claudeNonStreamSpan.setStatus("ok");
  claudeNonStreamSpan.end();
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
const tierPollTimer = setInterval(() => {
  void refreshTierRegistry();
}, config.SYNESIS_YARN_TIER_POLL_INTERVAL * 1000);

await app.listen({ port: config.PORT, host: config.HOST });
