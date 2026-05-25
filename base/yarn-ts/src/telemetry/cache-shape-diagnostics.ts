import crypto from "node:crypto";

import { stableJsonStringify } from "../compat/sorted-tools.js";
import type { OptimizationCacheDiagnostics } from "./optimization-ledger.js";

export interface CacheShapeMessage {
  role?: string;
  content?: unknown;
}

export interface BuildCacheShapeDiagnosticsInput {
  messages: CacheShapeMessage[];
  tools?: unknown[];
  providerOptions?: unknown;
}

export interface CacheShapeOutcomeInput {
  inputTokens?: number | null;
  cachedTokens?: number | null;
  cacheCreationTokens?: number | null;
}

export interface CacheShapeSummary {
  cacheShapeKey: string;
  path?: string;
  stablePrefixHash?: string;
  toolSchemaHash?: string;
  providerOptionsHash?: string;
  samples: number;
  hits: number;
  writes: number;
  misses: number;
  unknown: number;
  promptTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  hitPct: number;
  lastSeenAt?: number;
  lastRequestId?: string;
}

function stableSerialize(value: unknown): string {
  try {
    const serialized = stableJsonStringify(value);
    return typeof serialized === "string" ? serialized : "null";
  } catch {
    return JSON.stringify(String(value ?? ""));
  }
}

function hashStable(value: unknown): string {
  return crypto.createHash("sha256").update(stableSerialize(value), "utf8").digest("hex").slice(0, 16);
}

function byteLengthStable(value: unknown): number {
  return Buffer.byteLength(stableSerialize(value), "utf8");
}

function stablePrefixMessages(messages: CacheShapeMessage[]): CacheShapeMessage[] {
  const prefix: CacheShapeMessage[] = [];
  for (const message of messages) {
    const role = String(message.role ?? "");
    if (role !== "system" && role !== "developer") break;
    prefix.push(message);
  }
  return prefix;
}

function nonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function buildCacheShapeDiagnostics(
  input: BuildCacheShapeDiagnosticsInput,
): OptimizationCacheDiagnostics {
  const tools = input.tools ?? [];
  const stablePrefix = stablePrefixMessages(input.messages);
  return {
    messageCount: input.messages.length,
    stablePrefixHash: hashStable(stablePrefix),
    stablePrefixBytes: byteLengthStable(stablePrefix),
    toolCount: tools.length,
    toolSchemaHash: tools.length > 0 ? hashStable(tools) : "0:empty",
    toolSchemaBytes: tools.length > 0 ? byteLengthStable(tools) : 0,
    providerOptionsHash: input.providerOptions ? hashStable(input.providerOptions) : "0:empty",
    providerOptionsBytes: input.providerOptions ? byteLengthStable(input.providerOptions) : 0,
  };
}

export function buildCacheShapeOutcomeDiagnostics(
  input: CacheShapeOutcomeInput,
): OptimizationCacheDiagnostics {
  const inputTokens = nonNegativeInt(input.inputTokens);
  const cachedTokens = Math.min(nonNegativeInt(input.cachedTokens), inputTokens);
  const cacheCreationTokens = nonNegativeInt(input.cacheCreationTokens);
  const cacheShapeOutcome =
    inputTokens <= 0 ? "unknown"
      : cachedTokens > 0 ? "hit"
        : cacheCreationTokens > 0 ? "write"
          : "miss";
  return {
    cacheShapePromptTokens: inputTokens,
    cacheShapeCachedTokens: cachedTokens,
    cacheShapeCacheCreationTokens: cacheCreationTokens,
    cacheShapeHitPct: inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0,
    cacheShapeOutcome,
  };
}

export function cacheShapeDiagnosticFields(
  diagnostics: OptimizationCacheDiagnostics | undefined,
): Record<string, unknown> {
  if (!diagnostics) return {};
  const fields: Record<string, unknown> = {};
  if (diagnostics.messageCount !== undefined) fields.cacheShapeMessageCount = diagnostics.messageCount;
  if (diagnostics.stablePrefixHash !== undefined) fields.cacheShapeStablePrefixHash = diagnostics.stablePrefixHash;
  if (diagnostics.stablePrefixBytes !== undefined) fields.cacheShapeStablePrefixBytes = diagnostics.stablePrefixBytes;
  if (diagnostics.toolCount !== undefined) fields.cacheShapeToolCount = diagnostics.toolCount;
  if (diagnostics.toolSchemaHash !== undefined) fields.cacheShapeToolSchemaHash = diagnostics.toolSchemaHash;
  if (diagnostics.toolSchemaBytes !== undefined) fields.cacheShapeToolSchemaBytes = diagnostics.toolSchemaBytes;
  if (diagnostics.providerOptionsHash !== undefined) fields.cacheShapeProviderOptionsHash = diagnostics.providerOptionsHash;
  if (diagnostics.providerOptionsBytes !== undefined) fields.cacheShapeProviderOptionsBytes = diagnostics.providerOptionsBytes;
  if (diagnostics.cacheShapePromptTokens !== undefined) fields.cacheShapePromptTokens = diagnostics.cacheShapePromptTokens;
  if (diagnostics.cacheShapeCachedTokens !== undefined) fields.cacheShapeCachedTokens = diagnostics.cacheShapeCachedTokens;
  if (diagnostics.cacheShapeCacheCreationTokens !== undefined) {
    fields.cacheShapeCacheCreationTokens = diagnostics.cacheShapeCacheCreationTokens;
  }
  if (diagnostics.cacheShapeHitPct !== undefined) fields.cacheShapeHitPct = diagnostics.cacheShapeHitPct;
  if (diagnostics.cacheShapeOutcome !== undefined) fields.cacheShapeOutcome = diagnostics.cacheShapeOutcome;
  return fields;
}

function recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordOutcome(record: Record<string, unknown>): OptimizationCacheDiagnostics["cacheShapeOutcome"] {
  const value = record.cacheShapeOutcome;
  if (value === "hit" || value === "write" || value === "miss" || value === "unknown") return value;
  return undefined;
}

export function summarizeCacheShapeDiagnostics(
  records: Array<Record<string, unknown>>,
  limit = 20,
): CacheShapeSummary[] {
  const grouped = new Map<string, CacheShapeSummary>();
  for (const record of records) {
    const stablePrefixHash = recordString(record, "cacheShapeStablePrefixHash");
    const toolSchemaHash = recordString(record, "cacheShapeToolSchemaHash");
    const providerOptionsHash = recordString(record, "cacheShapeProviderOptionsHash");
    const outcome = recordOutcome(record);
    if (!stablePrefixHash && !toolSchemaHash && !providerOptionsHash && !outcome) continue;

    const path = recordString(record, "path");
    const cacheShapeKey = [
      path ?? "unknown-path",
      stablePrefixHash ?? "unknown-prefix",
      toolSchemaHash ?? "unknown-tools",
      providerOptionsHash ?? "unknown-provider-options",
    ].join(":");
    const current = grouped.get(cacheShapeKey) ?? {
      cacheShapeKey,
      path,
      stablePrefixHash,
      toolSchemaHash,
      providerOptionsHash,
      samples: 0,
      hits: 0,
      writes: 0,
      misses: 0,
      unknown: 0,
      promptTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      hitPct: 0,
    };

    current.samples += 1;
    const normalizedOutcome = outcome ?? "unknown";
    if (normalizedOutcome === "hit") current.hits += 1;
    else if (normalizedOutcome === "write") current.writes += 1;
    else if (normalizedOutcome === "miss") current.misses += 1;
    else current.unknown += 1;

    current.promptTokens += nonNegativeInt(recordNumber(record, "cacheShapePromptTokens"));
    current.cachedTokens += nonNegativeInt(recordNumber(record, "cacheShapeCachedTokens"));
    current.cacheCreationTokens += nonNegativeInt(recordNumber(record, "cacheShapeCacheCreationTokens"));
    const timestamp = recordNumber(record, "timestamp");
    if (timestamp > (current.lastSeenAt ?? 0)) {
      current.lastSeenAt = timestamp;
      current.lastRequestId = recordString(record, "requestId");
    }
    grouped.set(cacheShapeKey, current);
  }

  return [...grouped.values()]
    .map((summary) => ({
      ...summary,
      hitPct: summary.promptTokens > 0 ? Math.round((summary.cachedTokens / summary.promptTokens) * 100) : 0,
    }))
    .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0) || right.samples - left.samples)
    .slice(0, Math.max(0, Math.round(limit)));
}
