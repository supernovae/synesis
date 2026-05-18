import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";

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

  async saveContinuity(userId: string, continuity: SessionContinuity): Promise<void> {
    const key = `yarn-ts:continuity:${userId}`;
    await this.redis.set(key, JSON.stringify(continuity), "EX", this.ttlSeconds);
  }

  async loadContinuity(userId: string): Promise<SessionContinuity | null> {
    const key = `yarn-ts:continuity:${userId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionContinuity;
    } catch {
      return null;
    }
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
}
