import type { CollapsedOperation } from "../tool-collapse/types.js";

/** How the prefix cache interacts with a collapsed operation (no plan reordering). */
export type CachePolicyInteraction = "read_write_safe" | "invalidate_generation" | "never";

export interface ToolPrefixCacheStats {
  readHits: number;
  readMisses: number;
  searchHits: number;
  searchMisses: number;
  repoHits: number;
  repoMisses: number;
  skippedOversized: number;
  skippedUnsafePath: number;
  /** Successful merge_patch calls that invalidated read keys and bumped per-workspace generation. */
  mutationInvalidations: number;
}

export interface ToolPrefixCacheOptions {
  maxEntries: number;
  /** Skip storing individual read/search bodies larger than this (UTF-8 bytes). */
  maxEntryBytes: number;
  log?: (e: { msg: string; data?: Record<string, unknown> }) => void;
}

export interface ToolPrefixCacheIdentity {
  orgId: string;
  userId: string;
  sessionKey: string;
}

/** Collapsed executor surface — matches [`ToolCollapseExecutor`](../tool-collapse/tool-call-executor.ts) ops. */
export type CollapsedKind = CollapsedOperation["kind"];
