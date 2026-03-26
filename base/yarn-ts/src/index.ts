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
import { ToolResultReductionService } from "./reduction/tool-result-reducer.js";
import { WorkingFrameService } from "./frame/working-frame-service.js";
import { ProjectManifestService } from "./project/project-manifest-service.js";
import { DeterministicPolicyEngine } from "./policy/deterministic-policy-engine.js";
import { PhaseModelOrchestrator } from "./orchestration/phase-model-orchestrator.js";
import { ClientAdapterPacks } from "./adapters/client-adapter-packs.js";
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
  record: SessionRecord;
};

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
const validationNormalization = new ValidationNormalizationService(config, artifactStore);
const toolResultReduction = new ToolResultReductionService(config, artifactStore);
const workingFrameService = new WorkingFrameService(config.SYNESIS_YARN_FRAME_MAX_FILES);
const projectManifestService = new ProjectManifestService();
const policyEngine = new DeterministicPolicyEngine();
const phaseOrchestrator = new PhaseModelOrchestrator();
const clientAdapterPacks = new ClientAdapterPacks();

function enrichWithFrameAndManifest(
  messages: Array<{ role: string; content: unknown }>,
  adapterBlock?: string
): Array<{ role: string; content: unknown }> {
  const out = [...messages];
  const blocks: string[] = [];
  if (adapterBlock) {
    blocks.push(adapterBlock);
  }
  if (config.SYNESIS_YARN_WORKING_FRAME_ENABLED) {
    const frame = workingFrameService.build(out);
    blocks.push(workingFrameService.toSystemBlock(frame));
  }
  if (config.SYNESIS_YARN_PROJECT_MANIFEST_ENABLED) {
    const manifest = projectManifestService.build(out);
    blocks.push(projectManifestService.toSystemBlock(manifest));
  }
  if (blocks.length > 0) {
    out.unshift({
      role: "system",
      content: blocks.join("\n\n")
    });
  }
  return out;
}

function getSessionKey(request: OpenAIChatCompletionRequest): string {
  return request.conversation_id || request.user || "anon";
}

async function getSessionState(key: string, request: OpenAIChatCompletionRequest): Promise<SessionState> {
  const existing = sessions.get(key);
  if (existing) {
    existing.record.lastActiveAt = Date.now();
    return existing;
  }
  const loaded = await sessionStore.load(key);
  const record: SessionRecord = loaded ?? {
    sessionKey: key,
    userId: request.user || "anon",
    orgId: "",
    conversationId: request.conversation_id || "",
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
  const state: SessionState = { history: [], toolCallsSinceCheckpoint: 0, record };
  sessions.set(key, state);
  return state;
}


async function casSessionSave(state: SessionState): Promise<void> {
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

// --- Health endpoints ---
app.get("/health", async () => ({ status: "ok" }));
app.get("/health/readiness", async () => ({ status: "ready" }));
app.get("/health/telemetry", async () => ({
  timestamp: Date.now(),
  writeQueue: usageWriter.getStats(),
  validationNormalization: validationNormalization.getStats(),
  toolResultReduction: toolResultReduction.getStats(),
  workingFrame: workingFrameService.getStats(),
  projectManifest: projectManifestService.getStats(),
  deterministicPolicy: policyEngine.getStats(),
  phaseOrchestrator: phaseOrchestrator.getStats(),
  clientAdapterPacks: clientAdapterPacks.getStats()
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
  try {
    await authResolver.resolve(req.headers.authorization);
  } catch (error) {
    return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
  }

  const request = parsed.data;
  const policyPrecheck = policyEngine.evaluate({
    tools: request.tools as unknown[],
    repeatAttempt: {
      action: "chat_completion",
      args: { model: request.model, tool_choice: request.tool_choice },
      fsFingerprint: "unknown"
    }
  });
  if (!policyPrecheck.allow) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: policyPrecheck.rejectReason ?? "Policy rejected request." } });
  }
  const reducedOpenAI = toolResultReduction.reduceMessages(request.messages as never);
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
  const normalizedRequest: OpenAIChatCompletionRequest = {
    ...request,
    model: orchestration.selectedModel,
    messages: enrichWithFrameAndManifest(normalizedOpenAI.messages as never, adapterBlock) as never
  };

  const session = await getSessionState(getSessionKey(normalizedRequest), normalizedRequest);
  const reqId = `chatcmpl-${crypto.randomUUID()}`;
  if (policyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: policyPrecheck.pivotPrompt });
  }

  const { resolved, messages } = runOpenAIRequest(normalizedRequest);
  const sdkTools = openAIToolsToSDK(normalizedRequest.tools);
  const sdkToolChoice = mapToolChoice(normalizedRequest.tool_choice);

  if (!normalizedRequest.stream) {
    const started = Date.now();
    const result = await generateText({
      model: resolved.model as never,
      messages,
      maxOutputTokens: orchestration.maxOutputTokens,
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {})
    });
    const toolCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? [];
    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    session.history.push({ role: "assistant", content: result.text });
    const usage = readUsage((result as unknown as { usage?: unknown }).usage);
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, finishReason);
    maybeCheckpoint(session);

    const message: Record<string, unknown> = { role: "assistant", content: result.text };
    if (toolCalls.length > 0) {
      message.tool_calls = sdkToolCallsToOpenAI(toolCalls);
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

  reply.raw.write(`data: ${JSON.stringify({
    id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  })}\n\n`);
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
  const totalUsage = await streamed.totalUsage;
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, readUsage(totalUsage as unknown), Date.now() - started, finishReason);
  return reply;
});

// --- Claude Messages API ---
app.post("/v1/messages", async (req, reply) => {
  try {
    await authResolver.resolve(req.headers.authorization);
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
  const claudePolicyPrecheck = policyEngine.evaluate({
    tools: (body.tools as unknown[]) ?? [],
    repeatAttempt: {
      action: "claude_messages",
      args: { model: body.model, tool_choice: body.tool_choice },
      fsFingerprint: "unknown"
    }
  });
  if (!claudePolicyPrecheck.allow) {
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: claudePolicyPrecheck.rejectReason ?? "Policy rejected request." }
    });
  }

  const openAIMessages = claudeMessagesToOpenAI(
    body.messages as never,
    (content, toolName) => toolResultReduction.reduceStandaloneToolResult(content, toolName)
  );
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
  const openAIShape: OpenAIChatCompletionRequest = {
    model: claudeOrchestration.selectedModel,
    messages: enrichWithFrameAndManifest(normalizedFromClaude.messages as never, claudeAdapterBlock) as never,
    stream: body.stream
  };
  const session = await getSessionState(getSessionKey(openAIShape), openAIShape);
  const reqId = `msg-${crypto.randomUUID()}`;
  if (claudePolicyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: claudePolicyPrecheck.pivotPrompt });
  }

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
        if (inTextBlock) {
          sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
          inTextBlock = false;
        }
        const tc = part as unknown as { toolCallId?: string; toolName?: string };
        sse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: tc.toolCallId ?? "", name: tc.toolName ?? "" } });
        stopReason = "tool_use";
      } else if (part.type === "tool-input-delta") {
        const td = part as unknown as { inputTextDelta?: string };
        sse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: td.inputTextDelta ?? "" } });
      } else if (part.type === "tool-call") {
        sse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
        blockIdx++;
        stopReason = "tool_use";
      }
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
    persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, stopReason);
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
  const toolCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> }).toolCalls ?? [];
  const reasoning = (result as unknown as { reasoning?: string }).reasoning;
  const usage = readUsage((result as unknown as { usage?: unknown }).usage);
  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
  persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, stopReason);

  const content: Array<Record<string, unknown>> = [];
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (result.text) {
    content.push({ type: "text", text: result.text });
  }
  if (toolCalls.length > 0) {
    for (const tc of sdkToolCallsToClaude(toolCalls)) {
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
