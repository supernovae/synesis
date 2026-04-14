/**
 * MCP tool handlers for StoreObservation and RecallFindings.
 *
 * These give the model explicit memory tools: it can store findings
 * from exploration passes and recall them later without re-reading files.
 * Backed by a per-session in-memory store with optional Redis persistence.
 */

import { z } from "zod";
import type { McpToolDefinition, McpToolContext } from "../tool-registry.js";
import type { MemoryScope, StoredObservation } from "../../memory/types.js";

// ---------------------------------------------------------------------------
// In-memory store (no Redis dependency for the tool layer)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  id: string;
  topic: string;
  finding: string;
  scope: MemoryScope;
  sessionKey: string;
  projectRoot: string;
  createdAt: number;
}

const MAX_ENTRIES_PER_SESSION = 200;
let idCounter = 0;

const sessionStore = new Map<string, MemoryEntry[]>();
const projectStore = new Map<string, MemoryEntry[]>();

function generateId(): string {
  idCounter += 1;
  return `obs_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function getStoreList(scope: MemoryScope, key: string): MemoryEntry[] {
  const store = scope === "session" ? sessionStore : projectStore;
  let list = store.get(key);
  if (!list) {
    list = [];
    store.set(key, list);
  }
  return list;
}

function storeEntry(entry: MemoryEntry): void {
  const scopeKey = entry.scope === "session" ? entry.sessionKey : entry.projectRoot;
  const list = getStoreList(entry.scope, scopeKey);
  list.unshift(entry);
  if (list.length > MAX_ENTRIES_PER_SESSION) {
    list.length = MAX_ENTRIES_PER_SESSION;
  }
}

function recallEntries(
  query: string,
  scope: MemoryScope | "all",
  sessionKey: string,
  projectRoot: string,
  limit: number,
): MemoryEntry[] {
  const candidates: MemoryEntry[] = [];
  if (scope === "session" || scope === "all") {
    candidates.push(...(sessionStore.get(sessionKey) ?? []));
  }
  if (scope === "project" || scope === "all") {
    candidates.push(...(projectStore.get(projectRoot) ?? []));
  }

  if (!query.trim()) return candidates.slice(0, limit);

  const q = query.toLowerCase();
  return candidates
    .filter((e) => e.topic.toLowerCase().includes(q) || e.finding.toLowerCase().includes(q))
    .slice(0, limit);
}

/** Clear session-scoped entries (called on session expiry). */
export function clearSessionMemory(sessionKey: string): void {
  sessionStore.delete(sessionKey);
}

/** Clear project-scoped entries (for testing). */
export function clearProjectMemory(projectRoot: string): void {
  projectStore.delete(projectRoot);
}

/** Get count of stored observations for a session. */
export function getSessionMemoryCount(sessionKey: string): number {
  return (sessionStore.get(sessionKey) ?? []).length;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const storeObservationTool: McpToolDefinition<
  { topic: string; finding: string; scope?: string },
  { ok: boolean; id: string; stored: number }
> = {
  name: "store_observation",
  description:
    "Store a finding or observation for later recall. Use this to persist " +
    "important discoveries (architecture patterns, file purposes, decisions, " +
    "implementation gaps) so you can recall them without re-reading files. " +
    "Scope 'session' persists within the current session; 'project' persists " +
    "across sessions for the same project root.",
  inputSchema: z.object({
    topic: z.string().describe("Short topic label (e.g. 'auth flow', 'database schema', 'missing tests')"),
    finding: z.string().describe("The finding or observation to store (be concise but complete)"),
    scope: z.string().optional().describe("'session' (default) or 'project'"),
  }),
  handler(input, context) {
    const scope: MemoryScope = input.scope === "project" ? "project" : "session";
    const sessionKey = context?.sessionKey ?? "unknown";
    const projectRoot = context?.projectRoot ?? "";
    const entry: MemoryEntry = {
      id: generateId(),
      topic: input.topic.trim(),
      finding: input.finding.trim(),
      scope,
      sessionKey,
      projectRoot,
      createdAt: Date.now(),
    };
    storeEntry(entry);
    const scopeKey = scope === "session" ? sessionKey : projectRoot;
    const total = getStoreList(scope, scopeKey).length;
    return { ok: true, id: entry.id, stored: total };
  },
};

export const recallFindingsTool: McpToolDefinition<
  { query?: string; scope?: string; limit?: number },
  { findings: Array<{ topic: string; finding: string; scope: string; age: string }>; count: number }
> = {
  name: "recall_findings",
  description:
    "Recall previously stored observations. Use this before re-reading files " +
    "or running broad discovery — your past findings may already contain the " +
    "information you need. Returns matching findings sorted by recency.",
  inputSchema: z.object({
    query: z.string().optional().describe("Search query to filter findings (empty returns all)"),
    scope: z.string().optional().describe("'session', 'project', or 'all' (default 'all')"),
    limit: z.number().optional().describe("Max findings to return (default 10)"),
  }),
  handler(input, context) {
    const scope = (input.scope === "session" || input.scope === "project") ? input.scope : "all";
    const sessionKey = context?.sessionKey ?? "unknown";
    const projectRoot = context?.projectRoot ?? "";
    const limit = input.limit ?? 10;
    const entries = recallEntries(input.query ?? "", scope, sessionKey, projectRoot, limit);
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
