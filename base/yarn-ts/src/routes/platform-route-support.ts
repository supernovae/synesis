import type { FastifyInstance } from "fastify";
import type { Registry } from "prom-client";

import type { AuthResolver } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { ModelArchitectureProfileOverride } from "../providers/model-architecture-profile.js";
import type { UserRuntimePreferences } from "../runtime/user-preferences.js";
import type { SessionIdentity } from "../session/session-key.js";

export type WritableRaw = NodeJS.WritableStream & { destroyed?: boolean };

export type RequireInternalToken = (req: { headers: Record<string, unknown> }) => boolean;
export type FgaCheck = (
  user: string,
  relation: string,
  objectType: string,
  objectId: string,
) => Promise<{ allowed: boolean }>;
export type SafeWrite = (raw: WritableRaw, data: string) => boolean;
export type SafeEnd = (raw: WritableRaw) => void;
export type FormatValidationError = (error: {
  issues?: Array<{ path?: PropertyKey[]; message?: string }>;
  message: string;
}) => string;
export type SelectedOpenAiCompatHeaders = (headers: Record<string, unknown>) => Record<string, string>;
export type RecordSessionEvent = (
  sessionKey: string,
  userId: string,
  orgId: string,
  type: string,
  source: string,
  summary: string,
  metadataJson?: Record<string, unknown>,
) => void;

export interface StatsProvider {
  getStats(): unknown;
}

function classifyAuthorizationHeader(authorization: string | undefined): string {
  const raw = (authorization ?? "").trim();
  if (!raw) return "missing";
  if (!raw.toLowerCase().startsWith("bearer ")) return "non_bearer";
  const token = raw.slice(7).trim();
  if (!token) return "empty_bearer";
  if (/^bearer\s+syn-/i.test(token)) return "double_bearer_syn_pat";
  if (/^["']syn-/i.test(token)) return "quoted_syn_pat";
  if (token.startsWith("syn-")) return "syn_pat";
  if (token.split(".").length === 3) return "jwt";
  return "opaque";
}

function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  return err.message.slice(0, 160);
}

export function authRejectionLogFields(
  err: unknown,
  authorization: string | undefined,
  endpoint: string,
): Record<string, unknown> {
  return {
    endpoint,
    authHeaderKind: classifyAuthorizationHeader(authorization),
    reason: errorReason(err),
  };
}

export interface SessionStateForTelemetry {
  history: Array<{ content: string }>;
}

export interface SessionStateForCommand {
  record: {
    sessionKey: string;
    userId: string;
    orgId: string;
    metadata: Record<string, unknown>;
  };
}

export interface SessionStoreLike {
  ping(): Promise<boolean>;
  saveUserRuntimePreferences(userId: string, preferences: UserRuntimePreferences, ttlMs: number): Promise<void>;
}

export interface UsageWriterLike {
  getStats(): unknown;
  getConversationMemoryStats(): unknown;
  getPoolStats(): unknown;
}

export interface ToolResultReductionLike {
  getStats(): {
    reducedCount: number;
    fallbackToArtifactCount: number;
    artifactHandleCount: number;
    rawCharsTotal: number;
    reducedCharsTotal: number;
    jsonCompactionCount: number;
  };
  getRecallStats(): unknown;
  getVerificationStats(): unknown;
}

export interface ContentDedupLike {
  getStats(): {
    totalReads: number;
    deduplicatedReads: number;
    charsSaved: number;
  };
}

export interface DiagnosticRegistryLike {
  listRecent(): Promise<{ diagnostics: unknown[]; source: string }>;
  getByRequestId(requestId: string): Promise<unknown | null>;
  getRingStats(): { max: number; current: number };
}

export interface UserRateLimiterLike {
  check(userId: string): Promise<{
    allowed: boolean;
    currentCount?: number;
    limit?: number;
    retryAfterSeconds?: number;
  }>;
  getStats(): unknown;
}

export interface TierRegistryLike {
  getAvailableModels(): Array<{ id: string; [key: string]: unknown }>;
  getTierConfig?(modelId: string): {
    id: string;
    backendModel: string;
    baseUrl: string;
    adapterHint?: string | null;
    modelCapabilityPreset?: string | null;
    contextCeilingTokens?: number | null;
    architectureProfile?: ModelArchitectureProfileOverride | null;
  } | undefined;
}

export interface ArtifactStoreLike extends StatsProvider {
  get(id: string): unknown | null;
}

export interface PlatformRouteDependencies {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: Pick<AuthResolver, "resolve" | "requireCoderScope" | "requireModelReadScope" | "getPoolStats">;
  fgaCheck: FgaCheck;
  userRateLimiter: UserRateLimiterLike;
  requireInternalToken: RequireInternalToken;
  promRegistry: Registry;
  usagePersistenceEnabled: boolean;
  usageWriter: UsageWriterLike;
  sessionStore: SessionStoreLike;
  sessions: Iterable<[unknown, SessionStateForTelemetry]>;
  validationNormalization: StatsProvider;
  toolResultReduction: ToolResultReductionLike;
  transcriptPruning: StatsProvider;
  contentDedupBySession: ReadonlyMap<unknown, ContentDedupLike>;
  toolArgHardeningStats: Record<string, unknown>;
  toolSchemaPruningStats: Record<string, unknown>;
  toolBlobRedisEnabled: boolean;
  openClawProfileStats: Record<string, unknown>;
  contextAdmissionStats: Record<string, unknown> & { byPath?: Record<string, unknown> };
  workingFrameService: StatsProvider;
  projectManifestService: StatsProvider;
  policyEngine: StatsProvider;
  governanceClient: StatsProvider | null;
  phaseOrchestrator: StatsProvider;
  clientAdapterPacks: StatsProvider & { getCatalog(): unknown };
  stablePrefixService: StatsProvider;
  yarnToolPrefixCache: StatsProvider | null;
  artifactRetrieval: StatsProvider;
  knowledgeSearch: StatsProvider;
  getEvidencePrefetchStats(): unknown;
  getPatternPrefetchStats(): unknown;
  getPatternFeedbackStats(): unknown;
  artifactStore: ArtifactStoreLike;
  circuitBreakers: StatsProvider;
  distributedCounters: StatsProvider;
  streamAdmission: StatsProvider;
  attentionPositioning: StatsProvider;
  languagePacksConformance(): unknown;
  sessionContinuity: StatsProvider;
  enrichmentPool: StatsProvider;
  sensemakingStats: unknown;
  getEventLoopStats(): unknown;
  promptSnapshotRegistry: {
    service: string;
    profiles: Array<{ content_hash: string }>;
    assignments: unknown[];
    updated_at?: unknown;
  } | null;
  diagnosticRegistry: DiagnosticRegistryLike;
  resolveRequestId(headers: Record<string, unknown>): string;
  formatValidationError: FormatValidationError;
  selectedOpenAiCompatHeaders: SelectedOpenAiCompatHeaders;
  safeWrite: SafeWrite;
  safeEnd: SafeEnd;
  tierRegistry: TierRegistryLike;
  loadUserRuntimePreferences(userId: string): Promise<UserRuntimePreferences>;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionStateForCommand>;
  forceCheckpoint(state: SessionStateForCommand): Promise<boolean>;
  casSessionSave(state: SessionStateForCommand): Promise<unknown>;
  recordSessionEvent: RecordSessionEvent;
}

export function computeEfficiencyIndex(toolResultReduction: ToolResultReductionLike): {
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
    jsonCompactionRate: Math.round(jsonCompactionRate * 1000) / 1000,
  };
}

export async function authorizeClaudeCompatRequest(
  deps: Pick<PlatformRouteDependencies, "app" | "authResolver" | "fgaCheck" | "userRateLimiter">,
  authorization: string | undefined,
): Promise<
  | { ok: true; authUser: Awaited<ReturnType<AuthResolver["resolve"]>> }
  | { ok: false; statusCode: number; retryAfter?: number; body: Record<string, unknown> }
> {
  let authUser: Awaited<ReturnType<AuthResolver["resolve"]>>;
  try {
    authUser = await deps.authResolver.resolve(authorization);
  } catch (err) {
    deps.app.log.warn(authRejectionLogFields(err, authorization, "/v1/claude/*"), "auth_request_rejected");
    return { ok: false, statusCode: 401, body: { error: { type: "auth_error", message: "Authentication required" } } };
  }
  try {
    deps.authResolver.requireCoderScope(authUser);
  } catch {
    return { ok: false, statusCode: 403, body: { error: { type: "authz_error", message: "Insufficient scope for coder access" } } };
  }
  const fgaResult = await deps.fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!fgaResult.allowed) {
    return { ok: false, statusCode: 403, body: { error: { type: "authz_error", message: "Authorization denied by policy" } } };
  }
  const rateResult = await deps.userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    const retryAfterSeconds = rateResult.retryAfterSeconds ?? 0;
    return {
      ok: false,
      statusCode: 429,
      retryAfter: retryAfterSeconds,
      body: {
        error: {
          type: "rate_limit_error",
          message: `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
        },
      },
    };
  }
  return { ok: true, authUser };
}

export async function authorizeModelCatalogRequest(
  deps: Pick<PlatformRouteDependencies, "app" | "authResolver">,
  authorization: string | undefined,
): Promise<
  | { ok: true; authUser: Awaited<ReturnType<AuthResolver["resolve"]>> }
  | { ok: false; statusCode: number; body: Record<string, unknown> }
> {
  let authUser: Awaited<ReturnType<AuthResolver["resolve"]>>;
  try {
    authUser = await deps.authResolver.resolve(authorization);
  } catch (err) {
    deps.app.log.warn(authRejectionLogFields(err, authorization, "/v1/model-catalog"), "auth_request_rejected");
    return { ok: false, statusCode: 401, body: { error: { type: "auth_error", message: "Authentication required" } } };
  }
  try {
    deps.authResolver.requireModelReadScope(authUser);
  } catch {
    return { ok: false, statusCode: 403, body: { error: { type: "authz_error", message: "Insufficient scope for model catalog access" } } };
  }
  return { ok: true, authUser };
}
