/**
 * ACP agent that forwards prompt turns to the Synesis Yarn HTTP API (OpenAI chat completions).
 * Session execution context comes from ACP initialize (clientInfo, _meta) and newSession (cwd, workspace).
 * Tool calls returned by the model are executed on the ACP client (fs + terminal) and fed back in-loop.
 * @see https://agentclientprotocol.com/
 */
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
const META_MAX = 500;
const ACP_META_JSON_MAX = 2048;
const MAX_TOOL_ROUNDS = 32;
function envBaseUrl() {
    const u = (process.env.SYNESIS_YARN_URL ?? process.env.SYNESIS_CODER_URL ?? "http://127.0.0.1:8000").trim();
    return u.replace(/\/$/, "");
}
function envToken() {
    return (process.env.SYNESIS_YARN_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
}
function envModel() {
    return (process.env.SYNESIS_YARN_MODEL ?? "synesis-core").trim();
}
function truncate(s, max) {
    const t = s.trim();
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
function blocksToUserText(blocks) {
    const lines = [];
    for (const b of blocks) {
        if (b.type === "text") {
            lines.push(b.text);
        }
    }
    return lines.join("\n\n").trim();
}
/**
 * Map Yarn / OpenAI tool names to ACP ToolKind for UI hints.
 */
export function mapCoderToolNameToAcpKind(name) {
    const n = name.toLowerCase();
    if (n.includes("bash") || n.includes("shell") || n.includes("exec"))
        return "execute";
    if (n.includes("read") || n.includes("file"))
        return "read";
    if (n.includes("write") || n.includes("edit") || n.includes("strreplace"))
        return "edit";
    if (n.includes("grep") || n.includes("search"))
        return "search";
    return "other";
}
/** @deprecated Use mapCoderToolNameToAcpKind */
export const mapAnthropicToolNameToAcpKind = mapCoderToolNameToAcpKind;
/** Resolve relative coder paths using session metadata anchors (for ACP fs RPC). */
export function resolvePathForAcp(filePath, meta) {
    const fp = filePath.trim();
    if (!fp)
        return fp;
    if (path.isAbsolute(fp))
        return fp;
    const root = meta.synesis_project_root;
    const cwd = meta.synesis_shell_cwd;
    if (typeof root === "string" && root)
        return path.resolve(root, fp);
    if (typeof cwd === "string" && cwd)
        return path.resolve(cwd, fp);
    return path.resolve(fp);
}
function parseToolArguments(argumentsJson) {
    if (!argumentsJson || !argumentsJson.trim())
        return {};
    try {
        const v = JSON.parse(argumentsJson);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
function shellInvocation(command, cwd) {
    const c = command.trim();
    if (process.platform === "win32") {
        return { command: "cmd.exe", args: ["/c", c], cwd: cwd ?? undefined };
    }
    return { command: "/bin/bash", args: ["-lc", c], cwd: cwd ?? undefined };
}
function parseInitializeContext(params) {
    const ci = params.clientInfo;
    const name = typeof ci?.name === "string" && ci.name.trim() ? ci.name.trim() : undefined;
    const version = typeof ci?.version === "string" && ci.version.trim() ? ci.version.trim() : undefined;
    const clientLabel = name && version ? `${name}/${version}` : name ?? version ?? undefined;
    return { clientLabel, clientName: name, clientVersion: version };
}
/**
 * Merge ACP `_meta` hints into Synesis `metadata` fields consumed by
 * parseSessionExecutionContext / prompt chain (synesis_runtime, git summary, etc.).
 */
function applyAcpMetaHints(target, meta) {
    if (!meta || typeof meta !== "object")
        return;
    const rtExisting = target.synesis_runtime && typeof target.synesis_runtime === "object" && target.synesis_runtime !== null
        ? { ...target.synesis_runtime }
        : {};
    const pick = (k, dest) => {
        const v = meta[k];
        if (typeof v === "string" && v.trim())
            rtExisting[dest] = v.trim();
    };
    pick("platform", "platform");
    pick("os", "platform");
    pick("os_version", "os_version");
    pick("shell", "shell");
    const nested = meta.synesis_runtime;
    if (nested && typeof nested === "object" && nested !== null) {
        for (const [k, v] of Object.entries(nested)) {
            if (typeof v === "string" && v.trim())
                rtExisting[k] = v.trim();
        }
    }
    if (Object.keys(rtExisting).length > 0) {
        target.synesis_runtime = rtExisting;
    }
    const git = meta.synesis_git_summary ?? meta.git_summary;
    if (typeof git === "string" && git.trim()) {
        target.synesis_git_summary = truncate(git, META_MAX);
    }
    const cutoff = meta.synesis_knowledge_cutoff ?? meta.knowledge_cutoff;
    if (typeof cutoff === "string" && cutoff.trim()) {
        target.synesis_knowledge_cutoff = truncate(cutoff, 128);
    }
}
/** Safe, bounded JSON snapshot for observability (no secrets). */
function compactAcpMetaForAudit(meta) {
    if (!meta || typeof meta !== "object")
        return undefined;
    try {
        const keys = Object.keys(meta).filter((k) => !/token|secret|password|key/i.test(k));
        const slim = {};
        for (const k of keys.slice(0, 32)) {
            const v = meta[k];
            if (typeof v === "string")
                slim[k] = truncate(v, 200);
            else if (typeof v === "number" || typeof v === "boolean")
                slim[k] = v;
            else if (v === null)
                slim[k] = null;
        }
        const s = JSON.stringify(slim);
        return s.length <= ACP_META_JSON_MAX ? s : `${s.slice(0, ACP_META_JSON_MAX - 1)}…`;
    }
    catch {
        return undefined;
    }
}
function buildRequestMetadata(init, initMeta, ns) {
    const out = {};
    if (init.clientLabel)
        out.synesis_client_model_label = truncate(init.clientLabel, 256);
    if (init.clientName)
        out.synesis_acp_client_name = truncate(init.clientName, 128);
    if (init.clientVersion)
        out.synesis_acp_client_version = truncate(init.clientVersion, 64);
    applyAcpMetaHints(out, initMeta);
    applyAcpMetaHints(out, ns._meta);
    const cwd = typeof ns.cwd === "string" && ns.cwd.trim() ? ns.cwd.trim() : "";
    const extra = ns.additionalDirectories?.filter((d) => typeof d === "string" && d.trim()) ?? [];
    if (cwd)
        out.synesis_shell_cwd = cwd;
    const projectRoot = extra[0] ?? (cwd || undefined);
    if (projectRoot)
        out.synesis_project_root = projectRoot;
    const mcp = ns.mcpServers ?? [];
    out.synesis_acp_session = {
        additional_directory_count: extra.length,
        mcp_server_count: mcp.length,
    };
    const initAudit = compactAcpMetaForAudit(initMeta);
    const sessAudit = compactAcpMetaForAudit(ns._meta);
    if (initAudit)
        out.synesis_acp_initialize_meta_json = initAudit;
    if (sessAudit)
        out.synesis_acp_new_session_meta_json = sessAudit;
    return out;
}
export class SynesisYarnAcpAgent {
    connection;
    sessions = new Map();
    initBridge = {};
    initMeta;
    constructor(connection) {
        this.connection = connection;
    }
    async initialize(params) {
        this.initBridge = parseInitializeContext(params);
        this.initMeta = params._meta;
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentInfo: {
                name: "synesis-yarn-acp",
                version: "0.1.0",
            },
            agentCapabilities: {
                loadSession: false,
            },
        };
    }
    async authenticate() {
        return {};
    }
    async setSessionMode() {
        return {};
    }
    async newSession(params) {
        const sessionId = crypto.randomUUID();
        const conversationId = `acp_${sessionId}`;
        const requestMetadata = buildRequestMetadata(this.initBridge, this.initMeta, params);
        requestMetadata.synesis_conversation_id = conversationId;
        this.sessions.set(sessionId, {
            messages: [],
            conversationId,
            requestMetadata,
        });
        return { sessionId };
    }
    async prompt(params) {
        const token = envToken();
        if (!token) {
            throw new Error("SYNESIS_YARN_TOKEN or ANTHROPIC_AUTH_TOKEN is required for the Synesis ACP bridge");
        }
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Unknown session ${params.sessionId}`);
        }
        const userText = blocksToUserText(params.prompt);
        if (!userText) {
            return { stopReason: "end_turn" };
        }
        session.messages.push({ role: "user", content: userText });
        const base = envBaseUrl();
        const model = envModel();
        let modelCalls = 0;
        while (true) {
            if (modelCalls >= MAX_TOOL_ROUNDS) {
                throw new Error(`synesis-yarn-acp: exceeded ${MAX_TOOL_ROUNDS} /v1/chat/completions calls in one ACP prompt (tool loop)`);
            }
            modelCalls += 1;
            const msg = await this.fetchChatCompletion(session, token, base, model);
            if (!msg) {
                break;
            }
            const text = typeof msg.content === "string" ? msg.content : msg.content === null ? "" : "";
            const toolCalls = msg.tool_calls ?? [];
            if (text) {
                await this.emitTextChunks(params.sessionId, text);
            }
            for (const tc of toolCalls) {
                const id = tc.id;
                const name = tc.function?.name ?? "";
                if (!id || !name)
                    continue;
                let rawInput = {};
                try {
                    rawInput = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                }
                catch {
                    rawInput = { _raw: tc.function?.arguments ?? "" };
                }
                const n = {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: id,
                        title: name,
                        kind: mapCoderToolNameToAcpKind(name),
                        status: "pending",
                        rawInput,
                    },
                };
                await this.connection.sessionUpdate(n);
            }
            if (toolCalls.length === 0) {
                if (text) {
                    session.messages.push({ role: "assistant", content: text });
                }
                break;
            }
            session.messages.push({
                role: "assistant",
                content: text || null,
                tool_calls: toolCalls,
            });
            for (const tc of toolCalls) {
                const id = tc.id;
                const name = tc.function?.name ?? "";
                const input = parseToolArguments(tc.function?.arguments);
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: id,
                        status: "in_progress",
                        title: name,
                    },
                });
                let resultText;
                try {
                    resultText = await this.executeSynesisToolOnAcpClient(params.sessionId, session, name, input);
                }
                catch (err) {
                    resultText = JSON.stringify({
                        error: true,
                        message: err instanceof Error ? err.message : String(err),
                        tool: name,
                    });
                }
                await this.connection.sessionUpdate({
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: id,
                        status: "completed",
                        title: name,
                        rawOutput: resultText,
                    },
                });
                session.messages.push({
                    role: "tool",
                    tool_call_id: id,
                    name,
                    content: resultText,
                });
            }
        }
        return { stopReason: "end_turn" };
    }
    async fetchChatCompletion(session, token, base, model) {
        const body = {
            model,
            max_tokens: 32_768,
            messages: session.messages,
            stream: false,
            conversation_id: session.conversationId,
            metadata: { ...session.requestMetadata },
        };
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "x-synesis-client": "synesis-acp",
            },
            body: JSON.stringify(body),
            signal: this.connection.signal,
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Yarn OpenAI API ${res.status}: ${errText.slice(0, 500)}`);
        }
        const json = (await res.json());
        return json.choices?.[0]?.message ?? null;
    }
    /**
     * Run Synesis tool names against the ACP client's fs + terminal capabilities.
     */
    async executeSynesisToolOnAcpClient(sessionId, session, toolName, input) {
        const meta = session.requestMetadata;
        switch (toolName) {
            case "Read": {
                const fp = input.file_path ?? input.path;
                if (typeof fp !== "string" || !fp.trim()) {
                    return JSON.stringify({ error: "Read: missing file_path" });
                }
                const abs = resolvePathForAcp(fp, meta);
                const r = await this.connection.readTextFile({ sessionId, path: abs });
                return r.content;
            }
            case "Write": {
                const fp = input.file_path ?? input.path;
                const content = input.content;
                if (typeof fp !== "string" || !fp.trim()) {
                    return JSON.stringify({ error: "Write: missing file_path" });
                }
                if (typeof content !== "string") {
                    return JSON.stringify({ error: "Write: content must be a string" });
                }
                const abs = resolvePathForAcp(fp, meta);
                await this.connection.writeTextFile({ sessionId, path: abs, content });
                return JSON.stringify({ ok: true, path: abs, bytes: Buffer.byteLength(content, "utf8") });
            }
            case "Bash": {
                const cmd = input.command;
                if (typeof cmd !== "string" || !cmd.trim()) {
                    return JSON.stringify({ error: "Bash: missing command" });
                }
                const cwdRaw = input.cwd;
                const cwd = typeof cwdRaw === "string" && cwdRaw.trim()
                    ? resolvePathForAcp(cwdRaw, meta)
                    : typeof meta.synesis_shell_cwd === "string"
                        ? meta.synesis_shell_cwd
                        : null;
                const sh = shellInvocation(cmd, cwd);
                const handle = await this.connection.createTerminal({
                    sessionId,
                    command: sh.command,
                    ...(sh.args ? { args: sh.args } : {}),
                    cwd: sh.cwd ?? undefined,
                });
                try {
                    const exitRes = await handle.waitForExit();
                    const out = await handle.currentOutput();
                    return JSON.stringify({
                        stdout: out.output,
                        exit_code: exitRes.exitCode ?? null,
                        truncated: out.truncated,
                    });
                }
                finally {
                    await handle.release();
                }
            }
            default:
                return JSON.stringify({
                    error: true,
                    message: `synesis-yarn-acp does not execute tool "${toolName}" on the ACP client yet. Supported: Read, Write, Bash.`,
                    tool: toolName,
                });
        }
    }
    async emitTextChunks(sessionId, text) {
        const chunkSize = 400;
        for (let i = 0; i < text.length; i += chunkSize) {
            const slice = text.slice(i, i + chunkSize);
            const n = {
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: slice },
                },
            };
            await this.connection.sessionUpdate(n);
        }
    }
    async cancel(_params) {
        /* Future: abort in-flight fetch tied to this session */
    }
}
