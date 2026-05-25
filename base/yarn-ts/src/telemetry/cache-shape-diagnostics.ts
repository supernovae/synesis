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

export function cacheShapeDiagnosticFields(
  diagnostics: OptimizationCacheDiagnostics | undefined,
): Record<string, unknown> {
  if (!diagnostics) return {};
  return {
    cacheShapeMessageCount: diagnostics.messageCount,
    cacheShapeStablePrefixHash: diagnostics.stablePrefixHash,
    cacheShapeStablePrefixBytes: diagnostics.stablePrefixBytes,
    cacheShapeToolCount: diagnostics.toolCount,
    cacheShapeToolSchemaHash: diagnostics.toolSchemaHash,
    cacheShapeToolSchemaBytes: diagnostics.toolSchemaBytes,
    cacheShapeProviderOptionsHash: diagnostics.providerOptionsHash,
    cacheShapeProviderOptionsBytes: diagnostics.providerOptionsBytes,
  };
}
