/**
 * MCP tool handlers for StoreObservation and RecallFindings.
 *
 * These give the model explicit memory tools: it can store findings
 * from exploration passes and recall them later without re-reading files.
 * Backed by the shared MemoryStore (Redis + in-memory write-through cache).
 */

import { z } from "zod";
import type { McpToolDefinition } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import type { MemoryScope } from "../../memory/types.js";

const MemoryStoreScopeSchema = z.enum(["session", "project"]);
const MemoryRecallScopeSchema = z.enum(["session", "project", "all"]);

// ---------------------------------------------------------------------------
// Shared singleton — initialized at import time with null Redis.
// Call `initMemoryToolStore(redis)` from startup to enable Redis persistence.
// ---------------------------------------------------------------------------

let sharedStore = new MemoryStore(null);

/**
 * Initialize the memory tool store with a Redis client.
 * Must be called during server startup before any tool calls.
 */
export function initMemoryToolStore(store: MemoryStore): void {
  sharedStore = store;
}

/** Get the shared store (for wiring into governor, diagnostics, etc.). */
export function getMemoryToolStore(): MemoryStore {
  return sharedStore;
}

/** Clear session-scoped entries (called on session expiry). */
export function clearSessionMemory(sessionKey: string): void {
  void sharedStore.clearSession(sessionKey);
}

/** Clear project-scoped entries (for testing). */
export function clearProjectMemory(projectRoot: string): void {
  void sharedStore.clearProject(projectRoot);
}

/** Get count of stored observations for a session. */
export function getSessionMemoryCount(sessionKey: string): number {
  return sharedStore.countSession(sessionKey);
}

function memoryNamespace(context: { orgId?: string; userId?: string } | undefined): string {
  const orgId = context?.orgId?.trim() || "no-org";
  const userId = context?.userId?.trim() || "unknown";
  return `org:${orgId}:user:${userId}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const storeObservationTool: McpToolDefinition<
  { topic: string; finding: string; scope?: string },
  { ok: boolean; id: string; stored: number } | Promise<{ ok: boolean; id: string; stored: number }>
> = {
  name: "store_observation",
  description:
    "Store a finding or observation for later recall. Use this to persist " +
    "important discoveries (architecture patterns, file purposes, decisions, " +
    "implementation gaps) so you can recall them without re-reading files. " +
    "Scope 'session' persists within the current session; 'project' persists " +
    "across sessions for the same project root.",
  inputSchema: z.object({
    topic: z.string().min(1).max(256).describe("Short topic label (e.g. 'auth flow', 'database schema', 'missing tests')"),
    finding: z.string().min(1).max(16_000).describe("The finding or observation to store (be concise but complete)"),
    scope: MemoryStoreScopeSchema.optional().describe("'session' (default) or 'project'"),
  }).strict(),
  async handler(input, context) {
    const scope: MemoryScope = input.scope === "project" ? "project" : "session";
    const sessionKey = context?.sessionKey ?? "unknown";
    const projectRoot = context?.projectRoot ?? "";
    const obs = await sharedStore.store(
      input.topic,
      input.finding,
      scope,
      sessionKey,
      projectRoot,
      { namespace: memoryNamespace(context) },
    );
    const count = sharedStore.countSession(sessionKey);
    return { ok: true, id: obs.id, stored: count };
  },
};

export const recallFindingsTool: McpToolDefinition<
  { query?: string; scope?: string; limit?: number },
  Promise<{ findings: Array<{ topic: string; finding: string; scope: string; age: string }>; count: number }>
> = {
  name: "recall_findings",
  description:
    "Recall previously stored observations. Use this before re-reading files " +
    "or running broad discovery — your past findings may already contain the " +
    "information you need. Returns matching findings sorted by recency.",
  inputSchema: z.object({
    query: z.string().max(512).optional().describe("Search query to filter findings (empty returns all)"),
    scope: MemoryRecallScopeSchema.optional().describe("'session', 'project', or 'all' (default 'all')"),
    limit: z.number().int().min(1).max(100).optional().describe("Max findings to return (default 10)"),
  }).strict(),
  async handler(input, context) {
    const scope = (input.scope === "session" || input.scope === "project") ? input.scope : "all";
    const sessionKey = context?.sessionKey ?? "unknown";
    const projectRoot = context?.projectRoot ?? "";
    const limit = input.limit ?? 10;
    const entries = await sharedStore.recall(
      input.query ?? "",
      scope,
      sessionKey,
      projectRoot,
      limit,
      { namespace: memoryNamespace(context) },
    );
    const now = Date.now();
    const findings = entries.map((e) => {
      const ageMs = now - e.createdAt;
      const ageSec = Math.floor(ageMs / 1000);
      const age = ageSec < 60 ? `${ageSec}s ago`
        : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago`
        : `${Math.floor(ageSec / 3600)}h ago`;
      return { topic: e.topic, finding: e.finding, scope: e.scope, age };
    });
    return { findings, count: findings.length };
  },
};
