import type { OpenAIChatCompletionRequest } from "../schemas.js";
import { OpenAIChatCompletionRequestSchema } from "../schemas.js";
import type { AppConfig } from "../config.js";
import type { AuthUser } from "../auth.js";
import type { GovernorService } from "../governance/governor-service.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { CanonicalChatRequest, PipelineContext, PipelineResult } from "./types.js";
import { normalizeToolDescriptions, type ToolDescriptionTruncation } from "../compat/tool-description-normalizer.js";
import { type SessionIdentity } from "../session/session-key.js";
import { buildProtocolSessionIdentity } from "../session/protocol-session.js";
import { resolvePipelineMode, shouldRunGovernorForMode, type PipelineModeResolution } from "./modes.js";
import {
  runPreparedOpenAIChatProviderExecution,
  type PreparedOpenAIChatProviderExecutionInput,
  type PreparedOpenAIChatProviderExecutionResult,
} from "./openai-chat-provider-execution.js";
export type { OpenAIChatPipelineResult, OpenAIChatReplyAdapter } from "./openai-chat-results.js";
export { sendOpenAIChatPipelineResult } from "./openai-chat-results.js";

export interface OpenAIChatPipelineDeps {
  governorService?: Pick<GovernorService, "beforeProviderCall">;
}

export type OpenAIChatPipelineEnvironment = OpenAIChatPipelineDeps;

export interface OpenAIChatIngressSuccess {
  ok: true;
  request: OpenAIChatCompletionRequest;
  canonicalRequest: CanonicalChatRequest;
  modeResolution: PipelineModeResolution;
  bodyMetadata: Record<string, unknown> | null;
  clientKind: string;
  conversationId: string;
  requestUser: unknown;
  truncations: ToolDescriptionTruncation[];
}

export interface OpenAIChatIngressFailure {
  ok: false;
  statusCode: 400;
  body: { error: { type: "invalid_request_error"; message: string } };
  truncations: ToolDescriptionTruncation[];
}

export type OpenAIChatIngressResult = OpenAIChatIngressSuccess | OpenAIChatIngressFailure;

export interface OpenAIChatIdentityResolution {
  identity: SessionIdentity;
  identityUserId: string;
  displayName?: string;
}

function formatValidationError(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }>; message: string }): string {
  const issue = error.issues?.[0];
  if (issue) {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join(".") : "request";
    const message = typeof issue.message === "string" && issue.message.trim() ? issue.message.trim() : "invalid value";
    return `Invalid request: ${path}: ${message}`;
  }
  return `Invalid request: ${error.message.slice(0, 500)}`;
}

function headerOne(headers: Record<string, unknown>, key: string): string | null {
  const raw = headers[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
    }
  }
  return null;
}

function inferOpenAiClientKindFromUserAgent(ua: string): string | null {
  const normalized = ua.toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("roo") && normalized.includes("opencode")) return "roo-opencode";
  if (normalized.includes("claude-code") || normalized.includes("anthropic")) return "claude-code";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("codex")) return "codex-cli";
  if (normalized.includes("goose")) return "goose";
  return null;
}

function resolveOpenAiClientKind(
  headers: Record<string, unknown>,
  metadata: Record<string, unknown> | null,
): string {
  const explicit = headerOne(headers, "x-synesis-client");
  if (explicit) return explicit;

  const candidates: unknown[] = metadata
    ? [
        metadata.synesis_client,
        metadata.client,
        metadata.client_name,
        metadata.synesis_acp_client_name,
      ]
    : [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase().replace(/\s+/g, "-");
    }
  }

  const userAgent = headerOne(headers, "user-agent");
  if (userAgent) {
    const inferred = inferOpenAiClientKindFromUserAgent(userAgent);
    if (inferred) return inferred;
  }
  return "unknown";
}

function resolveOpenAiConversationId(
  bodyConversationId: unknown,
  metadata: Record<string, unknown> | null,
  headers: Record<string, unknown>,
): string {
  if (typeof bodyConversationId === "string" && bodyConversationId.trim()) return bodyConversationId.trim();

  if (metadata) {
    for (const key of ["synesis_conversation_id", "conversation_id", "session_id", "thread_id", "chat_id"]) {
      const val = metadata[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    const rawUserId = metadata.user_id;
    if (typeof rawUserId === "string" && rawUserId.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawUserId) as Record<string, unknown>;
        const nested = parsed.session_id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      } catch { /* ignore malformed nested metadata */ }
    }
  }

  for (const key of ["x-synesis-conversation-id", "x-opencode-session-id"]) {
    const val = headerOne(headers, key);
    if (val) return val;
  }
  return "";
}

function resolveOpenAiIdentityUserId(
  requestUser: unknown,
  authUser: { userId: string; authMethod: "pat" | "bearer" },
): string {
  // Always use the authenticated identity for session keying so turns
  // from the same token converge to a single session even when
  // request.user varies per-turn (common with opencode and other clients).
  if (authUser.authMethod === "pat") return authUser.userId;
  return authUser.userId;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function resolveOpenAiDisplayName(
  requestUser: unknown,
  authUser: { displayName?: string },
): string | undefined {
  if (authUser.displayName) return authUser.displayName;
  if (typeof requestUser === "string") {
    const trimmed = requestUser.trim();
    if (trimmed && EMAIL_RE.test(trimmed) && trimmed.length <= 200) {
      return trimmed.toLowerCase();
    }
  }
  return undefined;
}

function metadataFromRequest(request: OpenAIChatCompletionRequest): Record<string, unknown> | null {
  const raw = (request as Record<string, unknown>).metadata;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

export class OpenAIChatPipeline {
  constructor(private readonly env: OpenAIChatPipelineEnvironment = {}) {}

  canonicalize(request: OpenAIChatCompletionRequest): CanonicalChatRequest {
    return {
      protocol: "openai",
      model: request.model,
      messages: request.messages as unknown[],
      stream: request.stream ?? false,
      tools: request.tools as unknown[] | undefined,
      metadata: request.metadata ?? null,
      raw: request,
    };
  }

  resolveMode(input: Parameters<typeof resolvePipelineMode>[0]) {
    return resolvePipelineMode(input);
  }

  prepareIngress(input: {
    body: unknown;
    headers: Record<string, unknown>;
    config: Partial<AppConfig> & { SYNESIS_YARN_PIPELINE_MODE?: string };
  }): OpenAIChatIngressResult {
    const normalizedIngress = normalizeToolDescriptions(input.body, "openai", "/v1/chat/completions");
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(normalizedIngress.body);
    if (!parsed.success) {
      return {
        ok: false,
        statusCode: 400,
        body: { error: { type: "invalid_request_error", message: formatValidationError(parsed.error) } },
        truncations: normalizedIngress.truncations,
      };
    }

    const request = parsed.data;
    const modeResolution = this.resolveMode({
      headers: input.headers,
      body: request as unknown as Record<string, unknown>,
      config: input.config,
    });
    const bodyMetadata = metadataFromRequest(request);
    return {
      ok: true,
      request,
      canonicalRequest: this.canonicalize(request),
      modeResolution,
      bodyMetadata,
      clientKind: resolveOpenAiClientKind(input.headers, bodyMetadata),
      conversationId: resolveOpenAiConversationId(
        (request as Record<string, unknown>).conversation_id,
        bodyMetadata,
        input.headers,
      ),
      requestUser: (request as Record<string, unknown>).user,
      truncations: normalizedIngress.truncations,
    };
  }

  resolveIdentity(
    ingress: OpenAIChatIngressSuccess,
    authUser: AuthUser,
  ): OpenAIChatIdentityResolution {
    const identityUserId = resolveOpenAiIdentityUserId(ingress.requestUser, authUser);
    const displayName = resolveOpenAiDisplayName(ingress.requestUser, authUser);
    return {
      identityUserId,
      displayName,
      identity: buildProtocolSessionIdentity({
        authUser,
        userId: identityUserId,
        conversationId: ingress.conversationId,
        clientKind: ingress.clientKind,
        displayName,
      }),
    };
  }

  async beforeProviderCall(
    ctx: PipelineContext,
    request: { messages: GovernorInputMessage[]; governorOptions?: Parameters<GovernorService["beforeProviderCall"]>[1]["options"] },
  ): Promise<PipelineResult["governor"]> {
    if (!shouldRunGovernorForMode(ctx.mode) || !this.env.governorService) {
      return null;
    }
    return this.env.governorService.beforeProviderCall(ctx, {
      messages: request.messages,
      options: request.governorOptions,
    });
  }

  executePreparedProviderCall(
    input: PreparedOpenAIChatProviderExecutionInput,
  ): Promise<PreparedOpenAIChatProviderExecutionResult> {
    return runPreparedOpenAIChatProviderExecution(input);
  }
}
