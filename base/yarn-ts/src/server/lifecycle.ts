import type { FastifyInstance } from "fastify";

import type { SessionState } from "../state/session-state.js";
import type { SessionRecord, SessionStateSnapshot } from "../state/session-store.js";

type TimeoutHandle = ReturnType<typeof setInterval>;

interface SessionStoreLike {
  save(record: SessionRecord): Promise<unknown>;
  saveSessionState(sessionKey: string, snapshot: SessionStateSnapshot): Promise<unknown>;
  close(): Promise<unknown>;
}

interface Closable {
  close(): void | Promise<unknown>;
}

interface OptionalRedisLike {
  quit(): Promise<unknown>;
}

interface StartSessionTtlEvictionInput {
  ttlMs: number;
  sessions: Map<string, SessionState>;
  saveSession(state: SessionState): Promise<unknown>;
  contentDedupBySession: { delete(key: string): unknown };
  fileSnapshotBySession: { delete(key: string): unknown };
  structuralIndexBySession: { delete(key: string): unknown };
  memoryGovernorBySession: { delete(key: string): unknown };
  clearSessionMemory(key: string): void;
  blockedDiscoveryBySession: { delete(key: string): unknown };
  stablePrefixService: { evictSession(key: string): void };
}

export function startSessionTtlEviction(input: StartSessionTtlEvictionInput): TimeoutHandle {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, state] of input.sessions) {
      if (now - state.record.lastActiveAt > input.ttlMs) {
        void input.saveSession(state);
        input.sessions.delete(key);
        input.contentDedupBySession.delete(key);
        input.fileSnapshotBySession.delete(key);
        input.structuralIndexBySession.delete(key);
        input.memoryGovernorBySession.delete(key);
        input.clearSessionMemory(key);
        input.blockedDiscoveryBySession.delete(key);
        input.stablePrefixService.evictSession(key);
      }
    }
  }, 60_000);
}

interface SnapshotSessionsInput {
  sessions: Map<string, SessionState>;
  sessionStore: SessionStoreLike;
  buildSessionStateSnapshot(state: SessionState): SessionStateSnapshot;
}

async function snapshotSessionsToRedis(input: SnapshotSessionsInput): Promise<void> {
  const saves: Promise<unknown>[] = [];
  for (const [key, state] of input.sessions) {
    state.record.lastActiveAt = Date.now();
    saves.push(input.sessionStore.save(state.record));
    saves.push(input.sessionStore.saveSessionState(key, input.buildSessionStateSnapshot(state)));
  }
  await Promise.allSettled(saves);
}

export interface CreateGracefulShutdownInput extends SnapshotSessionsInput {
  app: FastifyInstance;
  sessionEvictionTimer: TimeoutHandle;
  getTierPollTimer(): TimeoutHandle | null;
  streamAdmission: Closable;
  userRateLimiter: Closable;
  policyEngine: Closable;
  governanceClient: Closable | null;
  artifactStore: Closable;
  usageWriter: { close(): Promise<unknown> };
  authResolver: { close(): Promise<unknown> };
  distributedCounters: { close(): Promise<unknown> };
  diagnosticRegistry: { close(): Promise<unknown> };
  enrichmentPool: { close(): Promise<unknown> };
  memoryStoreRedis: OptionalRedisLike | null;
}

export function createGracefulShutdown(input: CreateGracefulShutdownInput): () => Promise<void> {
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(input.sessionEvictionTimer);
    const tierPollTimer = input.getTierPollTimer();
    if (tierPollTimer) clearInterval(tierPollTimer);
    input.streamAdmission.close();
    input.userRateLimiter.close();
    input.policyEngine.close();
    input.governanceClient?.close();
    input.artifactStore.close();
    await snapshotSessionsToRedis(input);
    await input.app.close();
    await Promise.all([
      input.sessionStore.close(),
      input.usageWriter.close(),
      input.authResolver.close(),
      input.distributedCounters.close(),
      input.diagnosticRegistry.close(),
      input.enrichmentPool.close(),
      input.memoryStoreRedis?.quit(),
    ]);
  };
}

export function registerShutdownSignals(shutdown: () => Promise<void>): void {
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

export interface StartTierPollingInput {
  refreshTierRegistry(): Promise<void>;
  intervalSeconds: number;
}

export async function startTierPolling(input: StartTierPollingInput): Promise<TimeoutHandle> {
  await input.refreshTierRegistry();
  return setInterval(() => {
    void input.refreshTierRegistry();
  }, input.intervalSeconds * 1000);
}
