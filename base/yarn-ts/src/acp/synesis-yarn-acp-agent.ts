/**
 * ACP agent that forwards prompt turns to the Synesis Yarn HTTP API (OpenAI chat completions).
 * Session execution context comes from ACP initialize (clientInfo, _meta) and newSession (cwd, workspace).
 * Tool calls returned by the model are executed on the ACP client (fs + terminal) and fed back in-loop.
 * @see https://agentclientprotocol.com/
 */
import path from "node:path";
import { z } from "zod";
import type {
  Agent,
  AgentSideConnection,
  CancelNotification,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { shapeTerminalOutput } from "../terminal/output-shaper.js";
import { attachShapingToSignals, classifyTerminalOutput } from "../terminal/terminal-signals.js";
import {
  applyUpperHarnessToolCall,
  buildYarnUpperHarnessContext,
  upperHarnessBlockPayload,
} from "../upper-harness/bridge.js";

/** OpenAI-format messages we keep in-session (matches yarn-ts /v1/chat/completions). */
export interface OaiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
}

type AcpToolName = "Read" | "Write" | "Bash";

interface SessionData {
  messages: OaiChatMessage[];
  conversationId: string;
  /** Merged into every POST body `metadata` for session execution context + ACP hints. */
  requestMetadata: Record<string, unknown>;
  availableToolNames: Set<AcpToolName>;
}

const META_MAX = 500;
const ACP_META_JSON_MAX = 2048;
const MAX_TOOL_ROUNDS = 32;
const ACP_MAX_PATH_CHARS = 4096;
const ACP_MAX_COMMAND_CHARS = 16_000;
const ACP_MAX_WRITE_CONTENT_CHARS = 2_000_000;

const ACP_USER_ERROR_PREFIX = "[Synesis ACP] ";
const ACP_TOOL_NAMES = new Set<string>(["Read", "Write", "Bash"]);

const AcpPathArgSchema = z.string().min(1).max(ACP_MAX_PATH_CHARS);

const AcpReadInputSchema = z.object({
  file_path: AcpPathArgSchema.optional(),
  path: AcpPathArgSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (!input.file_path && !input.path) {
    ctx.addIssue({ code: "custom", message: "Read requires file_path or path" });
  }
});

const AcpWriteInputSchema = z.object({
  file_path: AcpPathArgSchema.optional(),
  path: AcpPathArgSchema.optional(),
  content: z.string().max(ACP_MAX_WRITE_CONTENT_CHARS),
}).strict().superRefine((input, ctx) => {
  if (!input.file_path && !input.path) {
    ctx.addIssue({ code: "custom", message: "Write requires file_path or path" });
  }
});

const AcpBashInputSchema = z.object({
  command: z.string().min(1).max(ACP_MAX_COMMAND_CHARS),
  cwd: AcpPathArgSchema.optional(),
}).strict();

const AcpRuntimeMetaSchema = z.object({
  platform: z.string().max(64).optional(),
  os_version: z.string().max(128).optional(),
  shell: z.string().max(128).optional(),
}).strict();

const READ_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "Read",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the session cwd, or an absolute path within the workspace." },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
} as const;

const WRITE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "Write",
    description: "Write UTF-8 text content to a workspace file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the session cwd, or an absolute path within the workspace." },
        content: { type: "string", description: "Complete file content to write." },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
} as const;

const BASH_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command in the session workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Optional working directory within the workspace." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
} as const;

function acpToolNamesForCapabilities(capabilities: ClientCapabilities | undefined): Set<AcpToolName> {
  const names = new Set<AcpToolName>();
  if (capabilities?.fs?.readTextFile) names.add("Read");
  if (capabilities?.fs?.writeTextFile) names.add("Write");
  if (capabilities?.terminal) names.add("Bash");
  return names;
}

function acpToolSchemas(names: Set<AcpToolName>): unknown[] {
  const tools: unknown[] = [];
  if (names.has("Read")) tools.push(READ_TOOL_SCHEMA);
  if (names.has("Write")) tools.push(WRITE_TOOL_SCHEMA);
  if (names.has("Bash")) tools.push(BASH_TOOL_SCHEMA);
  return tools;
}

type FetchChatCompletionResult =
  | {
      ok: true;
      message: {
        content?: string | null;
        /** OpenAI-style extension: model chain-of-thought / thinking separate from `content` */
        reasoning_content?: string;
        tool_calls?: Array<{
          id: string;
          type?: string;
          function?: { name: string; arguments: string };
        }>;
      };
    }
  | { ok: false; userMessage: string };

function envBaseUrl(): string {
  const u = (process.env.SYNESIS_YARN_URL ?? process.env.SYNESIS_CODER_URL ?? "http://127.0.0.1:8000").trim();
  return u.replace(/\/$/, "");
}

function envToken(): string {
  return (process.env.SYNESIS_YARN_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
}

function envModel(): string {
  return (process.env.SYNESIS_YARN_MODEL ?? "synesis-core").trim();
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function acpTerminalShapingEnabled(): boolean {
  return (process.env.SYNESIS_YARN_TERMINAL_SHAPING_ENABLED ?? "true").toLowerCase() !== "false";
}

function acpBashTimeoutMs(): number {
  const raw = Number(process.env.SYNESIS_YARN_ACP_BASH_TIMEOUT_MS ?? 600_000);
  if (!Number.isFinite(raw) || raw < 1000) return 600_000;
  return Math.min(raw, 3_600_000);
}

/** When the coder tier supports it, set `enable_thinking` on the OpenAI chat request (Qwen/DeepSeek-class). */
function acpRequestEnableThinking(): boolean {
  const v = (process.env.SYNESIS_YARN_ACP_ENABLE_THINKING ?? process.env.SYNESIS_YARN_ENABLE_THINKING ?? "").trim();
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** If the API returns `reasoning_content`, show it in the ACP transcript (set to `false` to show answer only). */
function acpIncludeReasoningInTranscript(): boolean {
  return (process.env.SYNESIS_YARN_ACP_INCLUDE_REASONING ?? "true").toLowerCase() !== "false";
}

function blocksToUserText(blocks: ContentBlock[]): string {
  const lines: string[] = [];
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
export function mapCoderToolNameToAcpKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "execute";
  if (n.includes("read") || n.includes("file")) return "read";
  if (n.includes("write") || n.includes("edit") || n.includes("strreplace")) return "edit";
  if (n.includes("grep") || n.includes("search")) return "search";
  return "other";
}

/** Resolve relative coder paths using session metadata anchors (for ACP fs RPC). */
export function resolvePathForAcp(filePath: string, meta: Record<string, unknown>): string {
  const fp = filePath.trim();
  if (!fp) return fp;
  const root = meta.synesis_project_root;
  const cwd = meta.synesis_shell_cwd;
  const projectRoot = typeof root === "string" && root.trim() ? path.resolve(root.trim()) : "";
  const shellCwd = typeof cwd === "string" && cwd.trim() ? path.resolve(cwd.trim()) : "";
  const anchor = shellCwd || projectRoot;
  const hasAnchor = anchor.trim().length > 0;
  const normalized = fp.replace(/\\/g, "/");
  const maybeHostLikeNoSlash = /^(Users|home|root)\//.test(normalized);
  const withHostSlash = maybeHostLikeNoSlash ? `/${normalized}` : normalized;
  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(fp) || /^[A-Za-z]:\//.test(normalized);
  const rel = !path.isAbsolute(withHostSlash) && !looksWindowsAbsolute && hasAnchor
    ? normalizeAcpRelativePath(normalized, anchor, shellCwd || null)
    : fp;
  const candidate = hasAnchor
    ? (
      looksWindowsAbsolute && path.sep !== "\\"
        ? path.resolve("/", normalized.replace(/^[A-Za-z]:[\\/]/, ""))
        : (path.isAbsolute(withHostSlash) ? path.resolve(withHostSlash) : path.resolve(anchor, rel))
    )
    : (
      looksWindowsAbsolute && path.sep !== "\\"
        ? path.resolve("/", normalized.replace(/^[A-Za-z]:[\\/]/, ""))
        : (path.isAbsolute(withHostSlash) ? path.resolve(withHostSlash) : path.resolve(fp))
    );

  const boundary = projectRoot || shellCwd;
  if (boundary && !isInsideDirectory(candidate, boundary)) {
    throw new Error(`Path escapes project root: ${fp}`);
  }
  return candidate;
}

function isInsideDirectory(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeAcpRelativePath(relPath: string, anchor: string, shellCwdForDuplicateRepair: string | null): string {
  const clean = relPath.replace(/\0/g, "").replace(/^\.\/+/, "");
  const anchorBase = path.basename(path.resolve(anchor));
  if (anchorBase && (clean === anchorBase || clean.startsWith(`${anchorBase}/`))) {
    const stripped = clean.slice(anchorBase.length).replace(/^\/+/, "");
    return stripped || ".";
  }
  if (shellCwdForDuplicateRepair) {
    return repairShellCwdPrefixedRelativePath(clean, shellCwdForDuplicateRepair);
  }
  return clean;
}

function repairShellCwdPrefixedRelativePath(relPath: string, shellCwd: string): string {
  const relParts = relPath.split("/").filter(Boolean);
  const cwdParts = path.resolve(shellCwd).split(path.sep).filter(Boolean);
  const max = Math.min(relParts.length, cwdParts.length);
  for (let len = max; len >= 1; len -= 1) {
    const suffix = cwdParts.slice(cwdParts.length - len);
    const prefix = relParts.slice(0, len);
    if (suffix.join("/") === prefix.join("/")) {
      const rest = relParts.slice(len);
      return rest.length > 0 ? rest.join("/") : ".";
    }
  }
  return relPath;
}

function validateAcpToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case "Read":
      return AcpReadInputSchema.parse(input);
    case "Write":
      return AcpWriteInputSchema.parse(input);
    case "Bash":
      return AcpBashInputSchema.parse(input);
    default:
      return input;
  }
}

function parseToolArguments(toolName: string, argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson || !argumentsJson.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error(`${toolName}: arguments must be valid JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${toolName}: arguments must be a JSON object`);
  }
  return validateAcpToolInput(toolName, v as Record<string, unknown>);
}

function acpToolError(message: string): string {
  return JSON.stringify({ error: message });
}

function requiredPathArg(input: Record<string, unknown>): string | null {
  const fp = input.file_path ?? input.path;
  if (typeof fp !== "string" || !fp.trim()) return null;
  return fp;
}

function shellInvocation(command: string, cwd?: string | null): { command: string; args?: string[]; cwd?: string | null } {
  const c = command.trim();
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/c", c], cwd: cwd ?? undefined };
  }
  return { command: "/bin/bash", args: ["-lc", c], cwd: cwd ?? undefined };
}

interface InitBridgeContext {
  clientLabel?: string;
  clientName?: string;
  clientVersion?: string;
}

function parseInitializeContext(params: InitializeRequest): InitBridgeContext {
  const ci = params.clientInfo;
  const name = typeof ci?.name === "string" && ci.name.trim() ? ci.name.trim() : undefined;
  const version = typeof ci?.version === "string" && ci.version.trim() ? ci.version.trim() : undefined;
  const clientLabel =
    name && version ? `${name}/${version}` : name ?? version ?? undefined;
  return { clientLabel, clientName: name, clientVersion: version };
}

/**
 * Merge ACP `_meta` hints into Synesis `metadata` fields consumed by
 * parseSessionExecutionContext / prompt chain (synesis_runtime, git summary, etc.).
 */
function applyAcpMetaHints(target: Record<string, unknown>, meta: Record<string, unknown> | null | undefined): void {
  if (!meta || typeof meta !== "object") return;

  const rtExisting =
    target.synesis_runtime && typeof target.synesis_runtime === "object" && target.synesis_runtime !== null
      ? { ...(target.synesis_runtime as Record<string, unknown>) }
      : {};

  const pick = (k: string, dest: "platform" | "os_version" | "shell") => {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) rtExisting[dest] = v.trim();
  };
  pick("platform", "platform");
  pick("os", "platform");
  pick("os_version", "os_version");
  pick("shell", "shell");

  const nested = meta.synesis_runtime;
  if (nested && typeof nested === "object" && nested !== null) {
    const raw = nested as Record<string, unknown>;
    const parsed = AcpRuntimeMetaSchema.safeParse({
      platform: raw.platform,
      os_version: raw.os_version,
      shell: raw.shell,
    });
    if (parsed.success) {
      for (const [k, v] of Object.entries(parsed.data)) {
        if (typeof v === "string" && v.trim()) rtExisting[k] = v.trim();
      }
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

function metaPath(meta: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function envProjectRoot(): string | undefined {
  const raw = (process.env.SYNESIS_YARN_ACP_PROJECT_ROOT ?? process.env.SYNESIS_PROJECT_ROOT ?? "").trim();
  return raw || undefined;
}

function closestContainingRoot(cwd: string, candidates: string[]): string | undefined {
  const absCwd = path.resolve(cwd);
  const matches = candidates
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => path.resolve(c))
    .filter((c) => isInsideDirectory(absCwd, c));
  matches.sort((a, b) => b.length - a.length);
  return matches[0];
}

/** Safe, bounded JSON snapshot for observability (no secrets). */
function compactAcpMetaForAudit(meta: Record<string, unknown> | null | undefined): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  try {
    const keys = Object.keys(meta).filter((k) => !/token|secret|password|key/i.test(k));
    const slim: Record<string, unknown> = {};
    for (const k of keys.slice(0, 32)) {
      const v = meta[k];
      if (typeof v === "string") slim[k] = truncate(v, 200);
      else if (typeof v === "number" || typeof v === "boolean") slim[k] = v;
      else if (v === null) slim[k] = null;
    }
    const s = JSON.stringify(slim);
    return s.length <= ACP_META_JSON_MAX ? s : `${s.slice(0, ACP_META_JSON_MAX - 1)}…`;
  } catch {
    return undefined;
  }
}

function buildRequestMetadata(
  init: InitBridgeContext,
  initMeta: InitializeRequest["_meta"],
  ns: NewSessionRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (init.clientLabel) out.synesis_client_model_label = truncate(init.clientLabel, 256);
  if (init.clientName) out.synesis_acp_client_name = truncate(init.clientName, 128);
  if (init.clientVersion) out.synesis_acp_client_version = truncate(init.clientVersion, 64);

  applyAcpMetaHints(out, initMeta as Record<string, unknown> | null | undefined);
  applyAcpMetaHints(out, ns._meta as Record<string, unknown> | null | undefined);

  const cwd = typeof ns.cwd === "string" && ns.cwd.trim() ? ns.cwd.trim() : "";
  const extra = ns.additionalDirectories?.filter((d) => typeof d === "string" && d.trim()) ?? [];
  if (cwd) out.synesis_shell_cwd = cwd;
  const explicitProjectRoot =
    envProjectRoot()
    ?? metaPath(ns._meta as Record<string, unknown> | null | undefined, [
      "synesis_project_root",
      "workspace_context_project_root",
      "project_root",
      "projectRoot",
    ])
    ?? metaPath(initMeta as Record<string, unknown> | null | undefined, [
      "synesis_project_root",
      "workspace_context_project_root",
      "project_root",
      "projectRoot",
    ]);
  const projectRoot = explicitProjectRoot ?? (cwd ? closestContainingRoot(cwd, extra) : undefined);
  if (projectRoot) out.synesis_project_root = projectRoot;

  const mcp = ns.mcpServers ?? [];
  out.synesis_acp_session = {
    additional_directory_count: extra.length,
    mcp_server_count: mcp.length,
  };

  const initAudit = compactAcpMetaForAudit(initMeta as Record<string, unknown> | undefined);
  const sessAudit = compactAcpMetaForAudit(ns._meta as Record<string, unknown> | undefined);
  if (initAudit) out.synesis_acp_initialize_meta_json = initAudit;
  if (sessAudit) out.synesis_acp_new_session_meta_json = sessAudit;

  return out;
}

export class SynesisYarnAcpAgent implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly sessions = new Map<string, SessionData>();
  private initBridge: InitBridgeContext = {};
  private initMeta: InitializeRequest["_meta"];
  private clientCapabilities: ClientCapabilities | undefined;

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initBridge = parseInitializeContext(params);
    this.initMeta = params._meta;
    this.clientCapabilities = params.clientCapabilities;
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

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async setSessionMode(): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const conversationId = `acp_${sessionId}`;
    const requestMetadata = buildRequestMetadata(this.initBridge, this.initMeta, params);
    requestMetadata.synesis_conversation_id = conversationId;

    this.sessions.set(sessionId, {
      messages: [],
      conversationId,
      requestMetadata,
      availableToolNames: acpToolNamesForCapabilities(this.clientCapabilities),
    });
    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const token = envToken();
    if (!token) {
      await this.emitUserVisibleError(
        params.sessionId,
        "Set SYNESIS_YARN_TOKEN or ANTHROPIC_AUTH_TOKEN to authenticate to the Synesis coder API.",
      );
      return { stopReason: "end_turn" };
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      await this.emitUserVisibleError(
        params.sessionId,
        `Unknown ACP session. Call newSession before prompt (sessionId was invalid).`,
      );
      return { stopReason: "end_turn" };
    }

    const userText = blocksToUserText(params.prompt);
    if (!userText) {
      return { stopReason: "end_turn" };
    }

    session.messages.push({ role: "user", content: userText });

    const base = envBaseUrl();
    const model = envModel();

    let modelCalls = 0;
    try {
      while (true) {
        if (modelCalls >= MAX_TOOL_ROUNDS) {
          await this.emitUserVisibleError(
            params.sessionId,
            `Stopped after ${MAX_TOOL_ROUNDS} coder round-trips (safety limit). Continue in a new message or narrow the task.`,
          );
          return { stopReason: "end_turn" };
        }
        modelCalls += 1;

        const fetched = await this.fetchChatCompletion(session, token, base, model);
        if (!fetched.ok) {
          await this.emitUserVisibleError(params.sessionId, fetched.userMessage);
          return { stopReason: "end_turn" };
        }
        const msg = fetched.message;

        const text = typeof msg.content === "string" ? msg.content : msg.content === null ? "" : "";
        const toolCalls = msg.tool_calls ?? [];
        const reasoning =
          typeof msg.reasoning_content === "string" && msg.reasoning_content.trim() ? msg.reasoning_content : "";

        if (reasoning && acpIncludeReasoningInTranscript()) {
          await this.emitTextChunks(
            params.sessionId,
            `### Model reasoning\n\n${reasoning}\n\n---\n\n`,
          );
        }
        if (text) {
          await this.emitTextChunks(params.sessionId, text);
        }

        for (const tc of toolCalls) {
          const id = tc.id;
          const name = tc.function?.name ?? "";
          if (!id || !name) continue;
          let rawInput: unknown = {};
          try {
            rawInput = parseToolArguments(name, tc.function?.arguments);
          } catch (err) {
            rawInput = {
              error: "invalid_acp_tool_arguments",
              message: err instanceof Error ? err.message : String(err),
            };
          }
          const n: SessionNotification = {
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
        if (text || reasoning) {
          session.messages.push({ role: "assistant", content: text || null });
        } else {
          await this.emitUserVisibleError(
            params.sessionId,
            "Coder returned an empty assistant message (no text and no tool calls). Check the model deployment or try again.",
          );
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
        let input: Record<string, unknown>;
        let inputError: Error | null = null;
        try {
          input = parseToolArguments(name, tc.function?.arguments);
        } catch (err) {
          inputError = err instanceof Error ? err : new Error(String(err));
          input = {};
        }
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "in_progress",
            title: name,
          },
        });
        let resultText: string;
        try {
          if (inputError) throw inputError;
          resultText = await this.executeSynesisToolOnAcpClient(params.sessionId, session, name, input);
        } catch (err) {
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
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || detail.toLowerCase().includes("abort"));
      await this.emitUserVisibleError(
        params.sessionId,
        isAbort
          ? "Request to the coder was cancelled (disconnected or aborted)."
          : `Unexpected ACP bridge error: ${detail.slice(0, 800)}`,
      );
    }

    return { stopReason: "end_turn" };
  }

  private async fetchChatCompletion(
    session: SessionData,
    token: string,
    base: string,
    model: string,
  ): Promise<FetchChatCompletionResult> {
    const tools = acpToolSchemas(session.availableToolNames);
    const body: Record<string, unknown> = {
      model,
      max_tokens: 32_768,
      messages: session.messages,
      stream: false,
      conversation_id: session.conversationId,
      metadata: { ...session.requestMetadata },
      ...(tools.length > 0 ? { tools } : {}),
      ...(acpRequestEnableThinking() ? { enable_thinking: true } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-synesis-client": "synesis-acp",
        },
        body: JSON.stringify(body),
        signal: this.connection.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        userMessage: `Network error calling ${base}/v1/chat/completions: ${msg}`,
      };
    }

    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      let detail = bodyText.slice(0, 800);
      try {
        const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
        const m = j?.error?.message ?? j?.message;
        if (typeof m === "string" && m.trim()) detail = m.trim();
      } catch {
        /* keep raw slice */
      }
      return {
        ok: false,
        userMessage: `Coder API HTTP ${res.status}: ${detail}`,
      };
    }

    let json: {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            type?: string;
            function?: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    try {
      json = JSON.parse(bodyText) as typeof json;
    } catch {
      return {
        ok: false,
        userMessage: "Coder API returned a non-JSON response (or malformed JSON). Check deployment and proxy configuration.",
      };
    }

    const message = json.choices?.[0]?.message;
    if (!message) {
      return {
        ok: false,
        userMessage:
          "Coder API returned no choices[0].message (empty completion). Check Yarn logs and model availability.",
      };
    }

    return { ok: true, message };
  }

  /**
   * Run Synesis tool names against the ACP client's fs + terminal capabilities.
   */
  private async executeSynesisToolOnAcpClient(
    sessionId: string,
    session: SessionData,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const meta = session.requestMetadata;
    const upper = applyUpperHarnessToolCall({
      context: buildYarnUpperHarnessContext({
        surface: "acp",
        modelId: envModel(),
        requestedModel: envModel(),
        baseUrl: envBaseUrl(),
        provider: "acp",
      }),
      toolName,
      input,
    });
    if (upper.blocked) {
      return JSON.stringify(upperHarnessBlockPayload(upper.decision, toolName));
    }

    const effectiveToolName = upper.toolName;
    const effectiveInput = validateAcpToolInput(effectiveToolName, upper.input);

    if (ACP_TOOL_NAMES.has(effectiveToolName) && !session.availableToolNames.has(effectiveToolName as AcpToolName)) {
      return JSON.stringify({
        synesis_error: true,
        schema_version: 1,
        category: "acp_missing_client_capability",
        error: true,
        message: `ACP client did not advertise the capability required to execute "${effectiveToolName}".`,
        tool: effectiveToolName,
        retryable: false,
      });
    }
    switch (effectiveToolName) {
      case "Read": {
        const fp = requiredPathArg(effectiveInput);
        if (!fp) return acpToolError("Read: missing file_path");
        const abs = resolvePathForAcp(fp, meta);
        const r = await this.connection.readTextFile({ sessionId, path: abs });
        return r.content;
      }
      case "Write": {
        const fp = requiredPathArg(effectiveInput);
        const content = effectiveInput.content;
        if (!fp) return acpToolError("Write: missing file_path");
        if (typeof content !== "string") {
          return acpToolError("Write: content must be a string");
        }
        const abs = resolvePathForAcp(fp, meta);
        await this.connection.writeTextFile({ sessionId, path: abs, content });
        return JSON.stringify({ ok: true, path: abs, bytes: Buffer.byteLength(content, "utf8") });
      }
      case "Bash": {
        const cmd = effectiveInput.command;
        if (typeof cmd !== "string" || !cmd.trim()) {
          return acpToolError("Bash: missing command");
        }
        const cwdRaw = effectiveInput.cwd;
        const cwd =
          typeof cwdRaw === "string" && cwdRaw.trim()
            ? resolvePathForAcp(cwdRaw, meta)
            : typeof meta.synesis_shell_cwd === "string"
              ? meta.synesis_shell_cwd
              : null;
        const sh = shellInvocation(cmd, cwd);
        const resolvedCwd = sh.cwd ?? null;
        const handle = await this.connection.createTerminal({
          sessionId,
          command: sh.command,
          ...(sh.args ? { args: sh.args } : {}),
          cwd: sh.cwd ?? undefined,
        });
        try {
          const bashTimeoutMs = acpBashTimeoutMs();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let exitRes: { exitCode?: number | null };
          let killedReason: "wall_clock_timeout" | undefined;
          try {
            exitRes = await Promise.race([
              handle.waitForExit().finally(() => {
                if (timer !== undefined) clearTimeout(timer);
              }),
              new Promise<{ exitCode?: number | null }>((_, rej) => {
                timer = setTimeout(() => rej(new Error("SYNESIS_ACP_BASH_TIMEOUT")), bashTimeoutMs);
              }),
            ]);
          } catch (e) {
            if (timer !== undefined) clearTimeout(timer);
            if (e instanceof Error && e.message === "SYNESIS_ACP_BASH_TIMEOUT") {
              killedReason = "wall_clock_timeout";
              exitRes = { exitCode: null };
            } else {
              throw e;
            }
          }

          const out = await handle.currentOutput();
          const skip = !acpTerminalShapingEnabled();
          const shaped = shapeTerminalOutput(out.output, { skip });
          const signals = classifyTerminalOutput(shaped.text, {
            shapingStats: shaped.stats,
            killedReason,
          });
          const terminal_signals = attachShapingToSignals(signals, shaped.shapingApplied, shaped.stats);
          return JSON.stringify({
            stdout: shaped.text,
            exit_code: exitRes.exitCode ?? null,
            truncated: out.truncated,
            cwd: resolvedCwd,
            terminal_signals,
            ...(killedReason ? { killed_reason: killedReason } : {}),
          });
        } finally {
          await handle.release();
        }
      }
      default:
        return JSON.stringify({
          synesis_error: true,
          schema_version: 1,
          category: "acp_unsupported_tool",
          error: true,
          message: `synesis-yarn-acp does not execute tool "${effectiveToolName}" on the ACP client yet. Supported: Read, Write, Bash.`,
          tool: effectiveToolName,
          retryable: false,
          hint: "Use only Read, Write, or Bash for local execution, or ask the model to avoid this tool name.",
        });
    }
  }

  /** User-visible line in the ACP transcript (not a silent failure). */
  private async emitUserVisibleError(sessionId: string, message: string): Promise<void> {
    const text = message.startsWith(ACP_USER_ERROR_PREFIX) ? message : `${ACP_USER_ERROR_PREFIX}${message}`;
    await this.emitTextChunks(sessionId, text);
  }

  private async emitTextChunks(sessionId: string, text: string): Promise<void> {
    const chunkSize = 400;
    for (let i = 0; i < text.length; i += chunkSize) {
      const slice = text.slice(i, i + chunkSize);
      const n: SessionNotification = {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: slice },
        },
      };
      await this.connection.sessionUpdate(n);
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    /* Future: abort in-flight fetch tied to this session */
  }
}
