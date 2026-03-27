import crypto from "node:crypto";
import Fastify from "fastify";
import { generateText, streamText } from "ai";
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
  openAIMessagesToModelMessages
} from "./tool-mapping.js";

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

const config = loadConfig();
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  forceCloseConnections: "idle"
});
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
}

function getSessionKey(identity: SessionIdentity): string {
  return identity.conversationId || identity.userId || "anon";
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
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalTokensCached: 0,
    requestCount: 0,
    escalationCount: 0,
    metadata: {},
    version: 0
  };
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
  if (state.history.length > 2 && state.record.userId !== "anon") {
    const continuity = sessionContinuity.extract(state.history);
    state.record.continuity = continuity;
    void sessionStore.saveContinuity(state.record.userId, continuity);
  }
  const ok = await sessionStore.save(state.record);
  if (!ok) {
    const reloaded = await sessionStore.load(state.record.sessionKey);
    if (reloaded) {
      reloaded.totalTokensIn = Math.max(reloaded.totalTokensIn, state.record.totalTokensIn);
      reloaded.totalTokensOut = Math.max(reloaded.totalTokensOut, state.record.totalTokensOut);
      reloaded.totalTokensCached = Math.max(reloaded.totalTokensCached, state.record.totalTokensCached);
      reloaded.requestCount = Math.max(reloaded.requestCount, state.record.requestCount);
      reloaded.lastActiveAt = Math.max(reloaded.lastActiveAt, state.record.lastActiveAt);
      const remoteCost = Number(reloaded.metadata.total_cost_usd ?? 0);
      const localCost = Number(state.record.metadata.total_cost_usd ?? 0);
      reloaded.metadata.total_cost_usd = Math.max(remoteCost, localCost);
      state.record = reloaded;
      await sessionStore.save(state.record);
    }
  }
}

function maybeCheckpoint(state: SessionState): void {
  if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint)) {
    return;
  }
  void sawtooth.compressTrajectory(state.history).then((consolidated) => {
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
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

function runOpenAIRequest(request: OpenAIChatCompletionRequest) {
  const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER);
  const messages = openAIMessagesToModelMessages(request.messages as never);
  return { resolved, messages };
}

function persistSessionAndUsage(
  state: SessionState,
  requestId: string,
  resolvedModelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number },
  latencyMs: number,
  finishReason: string
): void {
  const tier = tierRegistry.getTierConfig(resolvedModelId);
  const computedCostUsd =
    usage.costUsd > 0
      ? usage.costUsd
      : ((usage.inputTokens - usage.cachedTokens) / 1_000_000) * Number(tier?.inputPerM ?? 0) +
        (usage.cachedTokens / 1_000_000) * Number(tier?.cachedPerM ?? 0) +
        (usage.outputTokens / 1_000_000) * Number(tier?.outputPerM ?? 0);
  const normalizedCostUsd = Number.isFinite(computedCostUsd) ? Math.max(0, computedCostUsd) : 0;
  state.record.totalTokensIn += usage.inputTokens;
  state.record.totalTokensOut += usage.outputTokens;
  state.record.totalTokensCached += usage.cachedTokens;
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
    latencyMs,
    costUsd: normalizedCostUsd,
    escalated: false,
    toolCallsCount: state.toolCallsSinceCheckpoint,
    finishReason
  });
}

function readUsage(input: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const prompt = Number(obj.inputTokens ?? obj.promptTokens ?? obj.input_tokens ?? 0);
  const completion = Number(obj.outputTokens ?? obj.completionTokens ?? obj.output_tokens ?? 0);
  const cached = Number(obj.cachedInputTokens ?? obj.cached_tokens ?? 0);
  const cost = Number(obj.costUsd ?? obj.cost_usd ?? 0);
  return {
    inputTokens: Number.isFinite(prompt) ? prompt : 0,
    outputTokens: Number.isFinite(completion) ? completion : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
    costUsd: Number.isFinite(cost) ? cost : 0
  };
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
app.get("/health/telemetry", async () => {
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
      contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED
    },
    safetyLimits: {
      hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
      sessionMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
      consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT
    }
  };
});

app.get("/v1/diagnostics/recent", async () => ({
  diagnostics: [...diagnosticRing],
  count: diagnosticRing.length
}));

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
  const id = (req.params as { id: string }).id;
  const artifact = artifactStore.get(id);
  if (!artifact) {
    return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
  }
  return reply.send(artifact);
});

// --- MCP proxy ---
app.get("/v1/mcp/tools", async (req, reply) => {
  try {
    const user = await authResolver.resolve(req.headers.authorization);
    authResolver.requireCoderScope(user);
    const bearer = getBearerToken(req.headers.authorization);
    const data = await proxyMcpGet("/api/v1/mcp/tools", bearer);
    return reply.send(data);
  } catch (error) {
    return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
  }
});

app.post("/v1/mcp/tools/call", async (req, reply) => {
  try {
    const user = await authResolver.resolve(req.headers.authorization);
    authResolver.requireCoderScope(user);
    const bearer = getBearerToken(req.headers.authorization);
    const data = await proxyMcpPost("/api/v1/mcp/tools/call", bearer, req.body);
    return reply.send(data);
  } catch (error) {
    return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
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
  } catch (error) {
    return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
  }

  const request = parsed.data;
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
  const orchestration = phaseOrchestrator.decide({
    requestedModel: request.model,
    latestUserText: String(latestUserText?.content ?? ""),
    riskProfile: preManifest.riskProfile
  });
  const identity: SessionIdentity = {
    userId: request.user || authUser.userId,
    orgId: authUser.orgId,
    conversationId: request.conversation_id || ""
  };
  const sessionKey = getSessionKey(identity);
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
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER
  });
  if (!policyPrecheck.allow) {
    logAndPersistSafetyEvent(policyPrecheck, sessionKey, session.record.totalTokensIn);
    return reply.code(400).send({ error: { type: "invalid_request_error", message: policyPrecheck.rejectReason ?? "Policy rejected request." } });
  }
  const normalizedRequest: OpenAIChatCompletionRequest = {
    ...request,
    model: orchestration.selectedModel,
    messages: enrichWithFrameAndManifest(normalizedOpenAI.messages as never, sessionKey, adapterBlock) as never
  };

  session.toolCallsSinceCheckpoint += toolResultCount;
  const reqId = `chatcmpl-${crypto.randomUUID()}`;
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

  const { resolved, messages } = runOpenAIRequest(normalizedRequest);
  const sdkTools = openAIToolsToSDK(normalizedRequest.tools);
  const sdkToolChoice = mapToolChoice(normalizedRequest.tool_choice);

  if (!normalizedRequest.stream) {
    const started = Date.now();
    let currentMessages = messages;
    let finalResult = await generateText({
      model: resolved.model as never,
      messages: currentMessages,
      maxOutputTokens: orchestration.maxOutputTokens,
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {})
    });

    // Auto-resolve artifact retrieval tool calls (max 3 rounds to prevent loops)
    for (let round = 0; round < 3; round++) {
      const allCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? [];
      const artifactCalls = allCalls.filter((tc) => tc.toolName === ARTIFACT_TOOL_NAME);
      if (artifactCalls.length === 0) break;
      const clientCalls = allCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);

      const toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }> = [];
      for (const ac of artifactCalls) {
        const args = ac.args as { artifact_handle?: string; query?: string };
        const result = artifactRetrieval.retrieve(args.artifact_handle ?? "", args.query);
        toolResults.push({
          type: "tool-result",
          toolCallId: ac.toolCallId,
          toolName: ARTIFACT_TOOL_NAME,
          output: { type: "text", value: result.content }
        });
      }

      if (clientCalls.length > 0) break;

      const assistantParts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }> = [];
      if (finalResult.text) assistantParts.push({ type: "text", text: finalResult.text });
      for (const ac of artifactCalls) {
        assistantParts.push({ type: "tool-call", toolCallId: ac.toolCallId, toolName: ac.toolName, args: ac.args });
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

    const toolCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? [];
    const externalToolCalls = toolCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);
    const finishReason = externalToolCalls.length > 0 ? "tool_calls" : "stop";
    session.history.push({ role: "assistant", content: finalResult.text });
    const usage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
    const oaiLatency = Date.now() - started;
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, oaiLatency, finishReason);
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
    ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {})
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
        reply.raw.write(`data: ${JSON.stringify({
          id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
          choices: [{ index: 0, delta: { content: (part as unknown as { text: string }).text ?? "" }, finish_reason: null }]
        })}\n\n`);
      } else if (part.type === "tool-call" || part.type === "tool-input-start") {
        const tc = part as unknown as { toolCallId?: string; toolName?: string; args?: unknown };
        if (part.type === "tool-input-start") {
          pendingToolCalls.push({ index: pendingToolCalls.length, id: tc.toolCallId ?? "", name: tc.toolName ?? "", args: "" });
          reply.raw.write(`data: ${JSON.stringify({
            id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length - 1, id: tc.toolCallId, type: "function", function: { name: tc.toolName, arguments: "" } }] }, finish_reason: null }]
          })}\n\n`);
        } else if (part.type === "tool-call") {
          finishReason = "tool_calls";
          const argsStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {});
          const existing = pendingToolCalls.find((p) => p.id === tc.toolCallId);
          if (existing) {
            reply.raw.write(`data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: existing.index, function: { arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
          } else {
            reply.raw.write(`data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length, id: tc.toolCallId, type: "function", function: { name: tc.toolName, arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
          }
        }
      } else if (part.type === "tool-input-delta") {
        const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
        const idx = pendingToolCalls.findIndex((p) => p.id === td.toolCallId);
        if (idx >= 0) {
          reply.raw.write(`data: ${JSON.stringify({
            id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: td.inputTextDelta ?? "" } }] }, finish_reason: null }]
          })}\n\n`);
        }
      }
    }
  } catch (streamErr) {
    const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
    app.log.error({ err: streamErr, reqId, model: resolved.resolvedModelId }, `OpenAI stream error: ${detail}`);
  }

  reply.raw.write(`data: ${JSON.stringify({
    id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  })}\n\n`);
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
  const totalUsage = await streamed.totalUsage;
  const streamedText = await streamed.text;
  if (streamedText) {
    session.history.push({ role: "assistant", content: streamedText });
  }
  const oaiStreamUsage = readUsage(totalUsage as unknown);
  const oaiStreamLatency = Date.now() - started;
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, oaiStreamUsage, oaiStreamLatency, finishReason);
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
  } catch (error) {
    return reply.code(401).send({
      type: "error",
      error: { type: "authentication_error", message: String(error) }
    });
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
  const openAIMessages = claudeMessagesToOpenAI(
    body.messages as never,
    (content, toolName) => toolResultReduction.reduceStandaloneToolResult(content, toolName)
  );
  const claudeToolResultCount = (body.messages as Array<{ role: string }>).filter((m) => m.role === "tool_result" || m.role === "tool").length;
  const normalizedFromClaude = validationNormalization.normalizeMessages(openAIMessages as never);
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
  const claudeIdentity: SessionIdentity = {
    userId: claudeAuthUser.userId,
    orgId: claudeAuthUser.orgId,
    conversationId: ""
  };
  const claudeSessionKey = getSessionKey(claudeIdentity);
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
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER
  });
  if (!claudePolicyPrecheck.allow) {
    logAndPersistSafetyEvent(claudePolicyPrecheck, claudeSessionKey, session.record.totalTokensIn);
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: claudePolicyPrecheck.rejectReason ?? "Policy rejected request." }
    });
  }

  const openAIShape: OpenAIChatCompletionRequest = {
    model: claudeOrchestration.selectedModel,
    messages: enrichWithFrameAndManifest(normalizedFromClaude.messages as never, claudeSessionKey, claudeAdapterBlock) as never,
    stream: body.stream
  };
  session.toolCallsSinceCheckpoint += claudeToolResultCount;
  const reqId = `msg-${crypto.randomUUID()}`;
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

  const { resolved, messages } = runOpenAIRequest(openAIShape);
  const sdkTools = claudeToolsToSDK(body.tools as never);
  const sdkToolChoice = mapToolChoice(body.tool_choice);

  // Thinking passthrough: forward via providerOptions if present.
  const providerOptions = body.thinking ? { openai: { thinking: body.thinking } } : undefined;

  if (body.stream) {
    const started = Date.now();
    const streamed = streamText({
      model: resolved.model as never,
      messages,
      maxOutputTokens: claudeOrchestration.maxOutputTokens,
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
      ...(providerOptions ? { providerOptions } : {})
    });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const msgId = `msg_${crypto.randomUUID()}`;
    sse(reply, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: resolved.resolvedModelId, content: [] } });

    let blockIdx = 0;
    let inTextBlock = false;
    let stopReason = "end_turn";
    const pendingClaudeToolIds = new Set<string>();

    try {
      for await (const part of streamed.fullStream) {
        if (part.type === "text-delta") {
          const delta = (part as unknown as { text?: string }).text ?? "";
          if (!inTextBlock) {
            sse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
            inTextBlock = true;
          }
          sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: delta } });
        } else if (part.type === "reasoning-start") {
          if (inTextBlock) {
            sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
            blockIdx++;
            inTextBlock = false;
          }
          const text = (part as unknown as { text?: string }).text ?? "";
          sse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "thinking", thinking: "" } });
          if (text) {
            sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
          }
        } else if (part.type === "reasoning-delta") {
          const text = (part as unknown as { textDelta?: string }).textDelta ?? "";
          sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
        } else if (part.type === "reasoning-end") {
          sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
        } else if (part.type === "tool-input-start") {
          const tc = part as unknown as { toolCallId?: string; toolName?: string };
          if (tc.toolName === ARTIFACT_TOOL_NAME) {
            pendingClaudeToolIds.add(tc.toolCallId ?? "");
            continue;
          }
          if (inTextBlock) {
            sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
            blockIdx++;
            inTextBlock = false;
          }
          sse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: tc.toolCallId ?? "", name: tc.toolName ?? "" } });
          stopReason = "tool_use";
        } else if (part.type === "tool-input-delta") {
          const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
          const tdToolCall = pendingClaudeToolIds.has(td.toolCallId ?? "");
          if (!tdToolCall) {
            sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: td.inputTextDelta ?? "" } });
          }
        } else if (part.type === "tool-call") {
          const tc = part as unknown as { toolName?: string };
          if (tc.toolName === ARTIFACT_TOOL_NAME) continue;
          sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
          stopReason = "tool_use";
        }
      }
    } catch (streamErr) {
      const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
      app.log.error({ err: streamErr, reqId, model: resolved.resolvedModelId }, `Claude stream error: ${detail}`);
      if (!inTextBlock) {
        sse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
        inTextBlock = true;
      }
      sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: `\n\n[Upstream provider error: ${detail}]` } });
      stopReason = "end_turn";
    }

    if (inTextBlock) {
      sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
    }

    const totalUsage = await streamed.totalUsage;
    const usage = readUsage(totalUsage as unknown);
    sse(reply, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
    });
    sse(reply, "message_stop", { type: "message_stop" });
    reply.raw.end();
    const claudeStreamedText = await streamed.text;
    if (claudeStreamedText) {
      session.history.push({ role: "assistant", content: claudeStreamedText });
    }
    const claudeStreamLatency = Date.now() - started;
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, claudeStreamLatency, stopReason);
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
  const result = await generateText({
    model: resolved.model as never,
    messages,
    maxOutputTokens: claudeOrchestration.maxOutputTokens,
    ...(sdkTools ? { tools: sdkTools } : {}),
    ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
    ...(providerOptions ? { providerOptions } : {})
  });
  const allToolCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? [];
  const externalClaudeToolCalls = allToolCalls.filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME);
  const reasoning = (result as unknown as { reasoning?: string }).reasoning;
  const usage = readUsage((result as unknown as { usage?: unknown }).usage);
  const stopReason = externalClaudeToolCalls.length > 0 ? "tool_use" : "end_turn";
  if (result.text) {
    session.history.push({ role: "assistant", content: result.text });
  }
  const claudeNonStreamLatency = Date.now() - started;
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, claudeNonStreamLatency, stopReason);
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
