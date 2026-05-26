import type { AppConfig } from "../config.js";
import { MemoryGovernorTracker } from "../memory/governor-integration.js";
import { IncrementalStructuralIndex } from "../memory/incremental-index.js";
import { ContentAddressedDedup } from "../reduction/content-addressed-dedup.js";
import { FileSnapshotRegistry } from "../reduction/file-snapshot-registry.js";

export interface SessionResourceRegistry {
  contentDedupBySession: Map<string, ContentAddressedDedup>;
  fileSnapshotBySession: Map<string, FileSnapshotRegistry>;
  structuralIndexBySession: Map<string, IncrementalStructuralIndex>;
  memoryGovernorBySession: Map<string, MemoryGovernorTracker>;
  blockedDiscoveryBySession: Map<string, number>;
  getContentDedup(sessionKey: string): ContentAddressedDedup;
  getFileSnapshotRegistry(sessionKey: string): FileSnapshotRegistry;
  getStructuralIndex(sessionKey: string): IncrementalStructuralIndex | null;
  getMemoryGovernor(sessionKey: string): MemoryGovernorTracker;
  recordBlockedDiscovery(sessionKey: string, count: number): number;
  getBlockedDiscoveryCount(sessionKey: string): number;
  shouldStripGlobFromTools(sessionKey: string): boolean;
  stripGlobFromTools(tools: unknown[] | undefined): { tools: unknown[] | undefined; stripped: boolean };
}

export function createSessionResourceRegistry(config: AppConfig): SessionResourceRegistry {
  const contentDedupBySession = new Map<string, ContentAddressedDedup>();
  const fileSnapshotBySession = new Map<string, FileSnapshotRegistry>();
  const structuralIndexBySession = new Map<string, IncrementalStructuralIndex>();
  const memoryGovernorBySession = new Map<string, MemoryGovernorTracker>();
  const blockedDiscoveryBySession = new Map<string, number>();

  function getContentDedup(sessionKey: string): ContentAddressedDedup {
    let dedup = contentDedupBySession.get(sessionKey);
    if (!dedup) {
      dedup = new ContentAddressedDedup();
      if (config.SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED) {
        let idx = structuralIndexBySession.get(sessionKey);
        if (!idx) {
          idx = new IncrementalStructuralIndex();
          structuralIndexBySession.set(sessionKey, idx);
        }
        dedup.attachStructuralIndex(idx);
      }
      contentDedupBySession.set(sessionKey, dedup);
    }
    return dedup;
  }

  function getFileSnapshotRegistry(sessionKey: string): FileSnapshotRegistry {
    let registry = fileSnapshotBySession.get(sessionKey);
    if (!registry) {
      registry = new FileSnapshotRegistry();
      fileSnapshotBySession.set(sessionKey, registry);
    }
    return registry;
  }

  function getStructuralIndex(sessionKey: string): IncrementalStructuralIndex | null {
    return structuralIndexBySession.get(sessionKey) ?? null;
  }

  function getMemoryGovernor(sessionKey: string): MemoryGovernorTracker {
    let tracker = memoryGovernorBySession.get(sessionKey);
    if (!tracker) {
      tracker = new MemoryGovernorTracker();
      memoryGovernorBySession.set(sessionKey, tracker);
    }
    return tracker;
  }

  function recordBlockedDiscovery(sessionKey: string, count: number): number {
    const prev = blockedDiscoveryBySession.get(sessionKey) ?? 0;
    const next = prev + count;
    blockedDiscoveryBySession.set(sessionKey, next);
    return next;
  }

  function getBlockedDiscoveryCount(sessionKey: string): number {
    return blockedDiscoveryBySession.get(sessionKey) ?? 0;
  }

  function shouldStripGlobFromTools(sessionKey: string): boolean {
    return getBlockedDiscoveryCount(sessionKey) >= 2;
  }

  function stripGlobFromTools(tools: unknown[] | undefined): { tools: unknown[] | undefined; stripped: boolean } {
    if (!Array.isArray(tools) || tools.length === 0) return { tools, stripped: false };
    const deny = new Set(["glob", "glob_file_search"]);
    let stripped = false;
    const filtered = tools.filter((tool) => {
      if (!tool || typeof tool !== "object") return true;
      const row = tool as Record<string, unknown>;
      const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
      const rawName = (typeof row.name === "string" ? row.name : "")
        || (nested && typeof nested.name === "string" ? nested.name : "");
      const name = rawName.trim().toLowerCase();
      if (!deny.has(name)) return true;
      stripped = true;
      return false;
    });
    return { tools: filtered, stripped };
  }

  return {
    contentDedupBySession,
    fileSnapshotBySession,
    structuralIndexBySession,
    memoryGovernorBySession,
    blockedDiscoveryBySession,
    getContentDedup,
    getFileSnapshotRegistry,
    getStructuralIndex,
    getMemoryGovernor,
    recordBlockedDiscovery,
    getBlockedDiscoveryCount,
    shouldStripGlobFromTools,
    stripGlobFromTools,
  };
}
