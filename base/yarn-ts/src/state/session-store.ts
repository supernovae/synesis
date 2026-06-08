import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import type { UserRuntimePreferences } from "../runtime/user-preferences.js";
import type { ProviderCachePolicyWindow } from "../telemetry/cache-policy-controller.js";
import type { TokenEconomicsDecision } from "../telemetry/token-economics.js";

export interface SessionContinuity {
  currentTask: string;
  keyFindings: string[];
  decisions: string[];
  recentFiles: string[];
  planGraph?: Record<string, unknown> | null;
  planFilePath?: string | null;
  updatedAt: number;
}

/**
 * Serializable snapshot of the full proxy-side session state.
 * Stored in a separate Redis key from SessionRecord so that sessions
 * survive pod migration without requiring session affinity.
 * Maps/Sets are serialized as plain objects/arrays for JSON compatibility.
 */
export interface SessionStateSnapshot {
  history: Array<{ role: string; content: string }>;
  toolCallsSinceCheckpoint: number;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  pruningWatermark: number;
  consecutiveRecoveryFires: number;
  consecutiveEditContextMisses: number;
  editReplayHardStopGraceUsed: boolean;
  editMissForceReadPending: boolean;
  lastGovernorPhase?: string | null;
  artifactEditTurns: Record<string, number>;
  seenFailureSignatures: string[];
  previousFailureSignature: string | null;
  lastIncomingMessageCount: number;
  implementationSoftStallNudgeStrikes: number;
  regroundCooldownRemaining: number;
  lastGovernorNoPauseAt: number;
  skipToolIdStabilization: boolean;
  gitInspectionBlockCount: number;
  snapshotAt: number;
}

export interface SessionRecord {
  sessionKey: string;
  userId: string;
  orgId: string;
  conversationId: string;
  clientKind: string;
  displayName?: string;
  createdAt: number;
  lastActiveAt: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokensCached: number;
  totalTokensSaved: number;
  requestCount: number;
  escalationCount: number;
  lastTier?: string;
  lastProvider?: string;
  lastModel?: string;
  consecutiveFailedVerifications: number;
  metadata: Record<string, unknown>;
  continuity?: SessionContinuity;
  version: number;
}

export interface ProviderCacheObservation {
  provider: string;
  clientKind?: string;
  cacheOutcome: TokenEconomicsDecision["cacheOutcome"];
  promptTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

/**
 * Lua script for compare-and-set session writes.
 * KEYS[1] = session redis key
 * ARGV[1] = expected version (0 means unconditional create)
 * ARGV[2] = serialized new record (with incremented version)
 * ARGV[3] = TTL seconds
 *
 * Returns 1 on success, 0 on version conflict.
 */
const CAS_SCRIPT = `
local key = KEYS[1]
local expectedVersion = tonumber(ARGV[1])
local newData = ARGV[2]
local ttl = tonumber(ARGV[3])
if expectedVersion == 0 then
  redis.call("SET", key, newData, "EX", ttl)
  return 1
end
local current = redis.call("GET", key)
if current == false then
  redis.call("SET", key, newData, "EX", ttl)
  return 1
end
local decoded = cjson.decode(current)
local currentVersion = tonumber(decoded.version) or 0
if currentVersion ~= expectedVersion then
  return 0
end
redis.call("SET", key, newData, "EX", ttl)
return 1
`;

export class SessionStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(config: AppConfig, ttlMs?: number) {
    this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
      maxRetriesPerRequest: 2
    });
    const effectiveTtlMs = ttlMs ?? config.SYNESIS_YARN_SESSION_TTL_MS;
    this.ttlSeconds = Math.ceil(effectiveTtlMs / 1000);
  }

  async load(sessionKey: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.redisKey(sessionKey));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionRecord>;
      return { version: 0, ...parsed } as SessionRecord;
    } catch {
      return null;
    }
  }

  async loadActiveSessionKey(baseKey: string): Promise<string | null> {
    const raw = await this.redis.get(this.activeKey(baseKey));
    return raw && raw.trim() ? raw.trim() : null;
  }

  async saveActiveSessionKey(baseKey: string, sessionKey: string): Promise<void> {
    await this.redis.set(this.activeKey(baseKey), sessionKey, "EX", this.ttlSeconds);
  }

  /**
   * Atomically save a session record only if the stored version matches.
   * On success, the record's version is incremented in-place.
   * Returns true on success, false on version conflict.
   */
  async save(record: SessionRecord): Promise<boolean> {
    const expectedVersion = record.version;
    const newVersion = expectedVersion + 1;
    const toWrite = { ...record, version: newVersion };
    const result = await this.redis.eval(
      CAS_SCRIPT,
      1,
      this.redisKey(record.sessionKey),
      String(expectedVersion),
      JSON.stringify(toWrite),
      String(this.ttlSeconds)
    );
    if (Number(result) === 1) {
      record.version = newVersion;
      return true;
    }
    return false;
  }

  async saveContinuity(orgId: string, userId: string, continuity: SessionContinuity): Promise<void> {
    const key = this.continuityKey(orgId, userId);
    await this.redis.set(key, JSON.stringify(continuity), "EX", this.ttlSeconds);
  }

  async loadContinuity(orgId: string, userId: string): Promise<SessionContinuity | null> {
    const key = this.continuityKey(orgId, userId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionContinuity;
    } catch {
      return null;
    }
  }

  async saveUserRuntimePreferences(
    userId: string,
    preferences: UserRuntimePreferences,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.set(
      this.userPreferencesKey(userId),
      JSON.stringify(preferences),
      "EX",
      Math.ceil(ttlMs / 1000),
    );
  }

  async loadUserRuntimePreferences(userId: string): Promise<unknown | null> {
    const raw = await this.redis.get(this.userPreferencesKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async recordProviderCacheObservation(
    orgId: string,
    observation: ProviderCacheObservation,
    ttlMs: number,
  ): Promise<void> {
    const key = this.providerCacheWindowKey(
      orgId,
      observation.provider,
      observation.clientKind,
      this.providerWindowBucket(),
    );
    const multi = this.redis.multi();
    multi.hincrby(key, "requests", 1);
    if (observation.cacheOutcome === "hit") multi.hincrby(key, "hits", 1);
    if (observation.cacheOutcome === "miss") multi.hincrby(key, "misses", 1);
    if (observation.cacheOutcome === "write_without_read") multi.hincrby(key, "write_without_read", 1);
    if (observation.cacheOutcome === "no_usage") multi.hincrby(key, "telemetry_missing", 1);
    multi.hincrby(key, "prompt_tokens", Math.max(0, Math.floor(observation.promptTokens)));
    multi.hincrby(key, "cached_prompt_tokens", Math.max(0, Math.floor(observation.cachedTokens)));
    multi.hincrby(key, "cache_creation_tokens", Math.max(0, Math.floor(observation.cacheCreationTokens)));
    multi.expire(key, Math.ceil(ttlMs / 1000));
    await multi.exec();
  }

  async loadProviderCacheWindow(
    orgId: string,
    provider: string,
    windowHours: number,
    clientKind?: string,
  ): Promise<ProviderCachePolicyWindow | null> {
    const hours = Math.max(1, Math.min(720, Math.floor(windowHours)));
    const currentBucket = this.providerWindowBucket();
    const keys = Array.from({ length: hours }, (_value, idx) =>
      this.providerCacheWindowKey(orgId, provider, clientKind, currentBucket - idx)
    );
    const rows = await Promise.all(keys.map((key) => this.redis.hgetall(key)));
    const totals = {
      requests: 0,
      hits: 0,
      misses: 0,
      writeWithoutRead: 0,
      telemetryMissing: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheCreationTokens: 0,
    };
    for (const row of rows) {
      totals.requests += this.safeWindowInt(row.requests);
      totals.hits += this.safeWindowInt(row.hits);
      totals.misses += this.safeWindowInt(row.misses);
      totals.writeWithoutRead += this.safeWindowInt(row.write_without_read);
      totals.telemetryMissing += this.safeWindowInt(row.telemetry_missing);
      totals.promptTokens += this.safeWindowInt(row.prompt_tokens);
      totals.cachedPromptTokens += this.safeWindowInt(row.cached_prompt_tokens);
      totals.cacheCreationTokens += this.safeWindowInt(row.cache_creation_tokens);
    }
    if (totals.requests <= 0) return null;
    return {
      windowHours: hours,
      clientKind: clientKind || "unknown",
      ...totals,
      cacheHitPct: totals.promptTokens > 0
        ? Math.round((totals.cachedPromptTokens / totals.promptTokens) * 10000) / 100
        : 0,
      telemetryMissingPct: Math.round((totals.telemetryMissing / totals.requests) * 10000) / 100,
      writeWithoutReadPct: Math.round((totals.writeWithoutRead / totals.requests) * 10000) / 100,
    };
  }

  /**
   * Persist the full proxy-side session state (history + governor counters)
   * to a separate Redis key so sessions survive pod migration.
   */
  async saveSessionState(sessionKey: string, snapshot: SessionStateSnapshot): Promise<void> {
    const key = this.stateKey(sessionKey);
    await this.redis.set(key, JSON.stringify(snapshot), "EX", this.ttlSeconds);
  }

  async loadSessionState(sessionKey: string): Promise<SessionStateSnapshot | null> {
    const key = this.stateKey(sessionKey);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionStateSnapshot;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.redis.ping();
      return res === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private redisKey(sessionKey: string): string {
    return `yarn-ts:session:${sessionKey}`;
  }

  private stateKey(sessionKey: string): string {
    return `yarn-ts:state:${sessionKey}`;
  }

  private activeKey(baseKey: string): string {
    return `yarn-ts:active-session:${baseKey}`;
  }

  private continuityKey(orgId: string, userId: string): string {
    return `yarn-ts:continuity:${this.safeKeyPart(orgId || "no-org")}:${this.safeKeyPart(userId || "anon")}`;
  }

  private userPreferencesKey(userId: string): string {
    return `yarn-ts:user-runtime-preferences:${this.safeKeyPart(userId || "anon")}`;
  }

  private providerCacheWindowKey(
    orgId: string,
    provider: string,
    clientKind: string | undefined,
    bucket: number,
  ): string {
    return [
      "yarn-ts:cache-policy-window",
      this.safeKeyPart(orgId || "no-org"),
      this.safeKeyPart(provider || "unknown"),
      this.safeKeyPart(clientKind || "unknown-client"),
      String(bucket),
    ].join(":");
  }

  private providerWindowBucket(): number {
    return Math.floor(Date.now() / 3_600_000);
  }

  private safeWindowInt(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  private safeKeyPart(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 160) || "unknown";
  }
}
