import Fastify from "fastify";
import { convertToModelMessages, generateText, streamText } from "ai";
import { loadConfig } from "./config.js";
import { ClaudeMessagesRequestSchema, OpenAIChatCompletionRequestSchema } from "./schemas.js";
import { fetchTierConfigs } from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry } from "./providers/synesis-provider.js";
import { SawtoothContextManager } from "./context/sawtooth-manager.js";
import { RepeatGuard } from "./middleware/repeat-guard.js";
import { SessionStore } from "./state/session-store.js";
import { UsageWriter } from "./state/usage-writer.js";
import { AuthResolver } from "./auth.js";
const config = loadConfig();
const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const tierRegistry = new SynesisProviderRegistry();
const sawtooth = new SawtoothContextManager(config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS);
const repeatGuard = new RepeatGuard();
const sessions = new Map();
const sessionStore = new SessionStore(config);
const usageWriter = new UsageWriter(config);
const authResolver = new AuthResolver(config);
function getSessionKey(request) {
    return request.conversation_id || request.user || "anon";
}
async function getSessionState(key, request) {
    const existing = sessions.get(key);
    if (existing) {
        existing.record.lastActiveAt = Date.now();
        return existing;
    }
    const loaded = await sessionStore.load(key);
    const record = loaded ?? {
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
        metadata: {}
    };
    const state = { history: [], toolCallsSinceCheckpoint: 0, record };
    sessions.set(key, state);
    return state;
}
function enforcePatchFirst(request) {
    const tools = request.tools ?? [];
    for (const t of tools) {
        const fn = t?.function;
        if (!fn || typeof fn.name !== "string") {
            continue;
        }
        if (fn.name === "write_file") {
            return "Patch-first policy violation: use apply_patch/search-replace instead of write_file for non-trivial edits.";
        }
    }
    return null;
}
function maybeCheckpoint(state) {
    if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint)) {
        return;
    }
    void sawtooth.compressTrajectory(state.history).then((consolidated) => {
        state.history = [{ role: "system", content: consolidated.summary }];
        state.toolCallsSinceCheckpoint = 0;
    });
}
async function refreshTierRegistry() {
    try {
        const tiers = await fetchTierConfigs(config);
        if (tiers.length > 0) {
            tierRegistry.updateTiers(tiers);
            app.log.info({ tiers: tiers.map((t) => t.id) }, "tier_registry_refreshed");
        }
    }
    catch (error) {
        app.log.warn({ error }, "tier_registry_refresh_failed");
    }
}
async function runOpenAIRequest(request) {
    const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER);
    const messages = await convertToModelMessages(request.messages);
    return { resolved, messages };
}
async function persistSessionAndUsage(state, requestId, resolvedModelId, usage, latencyMs, finishReason) {
    state.record.totalTokensIn += usage.inputTokens;
    state.record.totalTokensOut += usage.outputTokens;
    state.record.totalTokensCached += usage.cachedTokens;
    const prevCost = Number(state.record.metadata.total_cost_usd ?? 0);
    state.record.metadata.total_cost_usd = prevCost + usage.costUsd;
    state.record.requestCount += 1;
    state.record.lastActiveAt = Date.now();
    await sessionStore.save(state.record);
    await usageWriter.upsertSession(state.record);
    await usageWriter.insertUsage({
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
        costUsd: usage.costUsd,
        escalated: false,
        toolCallsCount: state.toolCallsSinceCheckpoint,
        finishReason
    });
}
function readUsage(input) {
    const obj = (input ?? {});
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
function getBearerToken(authHeader) {
    const raw = authHeader ?? "";
    if (!raw.toLowerCase().startsWith("bearer "))
        return "";
    return raw.slice(7).trim();
}
async function proxyMcpGet(path, bearer) {
    const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${bearer}` }
    });
    if (!response.ok) {
        throw new Error(`MCP upstream error ${response.status}`);
    }
    return response.json();
}
async function proxyMcpPost(path, bearer, body) {
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
process.on("SIGTERM", () => {
    void Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close()]).then(() => process.exit(0));
});
process.on("SIGINT", () => {
    void Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close()]).then(() => process.exit(0));
});
app.get("/health", async () => ({ status: "ok" }));
app.get("/health/readiness", async () => ({ status: "ready" }));
app.get("/v1", async () => ({
    status: "ok",
    service: "synesis-yarn-ts",
    version: "0.1.0",
    endpoints: ["/v1/models", "/v1/chat/completions", "/v1/messages"]
}));
app.get("/v1/models", async () => ({
    object: "list",
    data: tierRegistry.getAvailableModels()
}));
app.get("/v1/mcp/tools", async (req, reply) => {
    try {
        const user = await authResolver.resolve(req.headers.authorization);
        authResolver.requireCoderScope(user);
        const bearer = getBearerToken(req.headers.authorization);
        const data = await proxyMcpGet("/api/v1/mcp/tools", bearer);
        return reply.send(data);
    }
    catch (error) {
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
    }
    catch (error) {
        return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
    }
});
app.post("/v1/chat/completions", async (req, reply) => {
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: { type: "invalid_request_error", message: parsed.error.message } });
    }
    try {
        await authResolver.resolve(req.headers.authorization);
    }
    catch (error) {
        return reply.code(401).send({ error: { type: "auth_error", message: String(error) } });
    }
    const request = parsed.data;
    const patchError = enforcePatchFirst(request);
    if (patchError) {
        return reply.code(400).send({ error: { type: "invalid_request_error", message: patchError } });
    }
    const session = await getSessionState(getSessionKey(request), request);
    const reqId = `chatcmpl-${Date.now()}`;
    const repeat = repeatGuard.shouldPivot({
        toolName: "chat_completion",
        args: { model: request.model, tool_choice: request.tool_choice },
        fsFingerprint: "unknown"
    });
    if (repeat) {
        session.history.push({ role: "system", content: RepeatGuard.pivotPrompt() });
    }
    const { resolved, messages } = await runOpenAIRequest(request);
    if (!request.stream) {
        const started = Date.now();
        const result = await generateText({
            model: resolved.model,
            messages
        });
        session.history.push({ role: "assistant", content: result.text });
        const usage = readUsage(result.usage);
        await persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, "stop");
        maybeCheckpoint(session);
        return reply.send({
            id: reqId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: resolved.resolvedModelId,
            choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }]
        });
    }
    const started = Date.now();
    const streamed = streamText({
        model: resolved.model,
        messages
    });
    reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
    });
    for await (const chunk of streamed.textStream) {
        const frame = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: resolved.resolvedModelId,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
        };
        reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    const totalUsage = await streamed.totalUsage;
    await persistSessionAndUsage(session, reqId, resolved.resolvedModelId, readUsage(totalUsage), Date.now() - started, "stop");
    return reply;
});
app.post("/v1/messages", async (req, reply) => {
    try {
        await authResolver.resolve(req.headers.authorization);
    }
    catch (error) {
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
    const body = parsed.data;
    const openAIShape = {
        model: body.model,
        messages: body.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        })),
        stream: body.stream
    };
    const session = await getSessionState(getSessionKey(openAIShape), openAIShape);
    const reqId = `msg-${Date.now()}`;
    const { resolved, messages } = await runOpenAIRequest(openAIShape);
    if (body.stream) {
        const started = Date.now();
        const streamed = streamText({ model: resolved.model, messages });
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        });
        reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${Date.now()}` } })}\n\n`);
        reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        for await (const chunk of streamed.textStream) {
            reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })}\n\n`);
        }
        reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        const totalUsage = await streamed.totalUsage;
        const usage = readUsage(totalUsage);
        reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
        })}\n\n`);
        reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        reply.raw.end();
        await persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, "end_turn");
        return reply;
    }
    const started = Date.now();
    const result = await generateText({ model: resolved.model, messages });
    const usage = readUsage(result.usage);
    await persistSessionAndUsage(session, reqId, resolved.resolvedModelId, usage, Date.now() - started, "end_turn");
    return reply.send({
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: openAIShape.model,
        content: [{ type: "text", text: result.text }],
        stop_reason: "end_turn",
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
    });
});
await refreshTierRegistry();
setInterval(() => {
    void refreshTierRegistry();
}, config.SYNESIS_YARN_TIER_POLL_INTERVAL * 1000);
await app.listen({ port: config.PORT, host: config.HOST });
