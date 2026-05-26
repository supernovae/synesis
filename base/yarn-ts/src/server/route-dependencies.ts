import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModelMessage } from "ai";

import type { AuthResolver, AuthUser } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { OpenAIChatPipeline } from "../pipeline/openai-chat-pipeline.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { SessionState } from "../state/session-state.js";

type AnyFn = (...args: any[]) => any;
type AnyRecord = Record<string, any>;

export interface RateLimiterLike {
  check(userId: string): Promise<{
    allowed: boolean;
    currentCount?: number;
    limit?: number;
    retryAfterSeconds?: number;
  }>;
  [key: string]: any;
}

export interface OpenAIChatCompletionsRouteDependencies extends AnyRecord {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: AuthResolver;
  fgaCheck: AnyFn;
  userRateLimiter: RateLimiterLike;
  openAiChatPipeline: OpenAIChatPipeline;
  resolveRequestId(headers: Record<string, unknown>): string;
  recordSessionEvent: AnyFn;
  applyClarificationRoundResponseHeader: AnyFn;
  policyRejectOpenAIBody: AnyFn;
  sendOpenAISoftFail: AnyFn;
  sendOpenAIWorkspaceHandshake: AnyFn;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionState>;
  casSessionSave(state: SessionState): Promise<unknown>;
  runOpenAIRequest(request: OpenAIChatCompletionRequest): {
    ok: true;
    resolved: {
      resolvedModelId: string;
      model: unknown;
      adapter: ModelAdapter;
    };
    messages: ModelMessage[];
    transforms: {
      systemMessagesReordered: boolean;
      toolCallsSanitized: boolean;
      messageCountDelta: number;
    };
    [key: string]: any;
  } | {
    ok: false;
    error: string;
    [key: string]: any;
  };
}

export interface ClaudeRuntimeDependencies extends AnyRecord {
  app: FastifyInstance;
  config: AppConfig;
}

export interface ClaudeAuthDependencies extends AnyRecord {
  authResolver: AuthResolver;
  fgaCheck: AnyFn;
  userRateLimiter: RateLimiterLike;
}

export interface ClaudeProtocolDependencies extends AnyRecord {
  resolveRequestId(headers: Record<string, unknown>): string;
}

export interface ClaudeSessionDependencies extends AnyRecord {
  applyAuthKeyAttribution(
    session: SessionState,
    authUser: Pick<AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">,
  ): void;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionState>;
  loadUserRuntimePreferences(userId: string): Promise<unknown>;
  casSessionSave(state: SessionState): Promise<unknown>;
  sessions: Map<string, SessionState>;
  recordSessionEvent: AnyFn;
}

export interface ClaudeProviderResolveOk {
  ok: true;
  resolved: AnyRecord;
  messages: Array<{ role: string; content?: unknown }>;
  providerOptions?: AnyRecord;
  [key: string]: any;
}

export interface ClaudeProviderResolveError {
  ok: false;
  statusCode: number;
  body: Record<string, unknown>;
  [key: string]: any;
}

export interface ClaudeProviderDependencies extends AnyRecord {
  runOpenAIRequest: OpenAIChatCompletionsRouteDependencies["runOpenAIRequest"];
}

export interface ClaudeMessagesRouteDependencies {
  runtime: ClaudeRuntimeDependencies;
  auth: ClaudeAuthDependencies;
  protocol: ClaudeProtocolDependencies;
  session: ClaudeSessionDependencies;
  workspace: AnyRecord;
  reduction: AnyRecord;
  tools: AnyRecord;
  governance: AnyRecord;
  planning: AnyRecord;
  provider: ClaudeProviderDependencies;
  evidence: AnyRecord;
  telemetry: AnyRecord;
  adapter: AnyRecord;
}

export type RouteRequest = FastifyRequest;
export type RouteReply = FastifyReply;
