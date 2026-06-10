import crypto from "node:crypto";
import { stableJsonStringify } from "../compat/sorted-tools.js";

export type CacheDebugTraceMode = "off" | "hashed";

export type CacheDebugMissReason =
  | "cache_hit"
  | "first_request"
  | "toolset_changed"
  | "system_prefix_changed"
  | "volatile_metadata_in_prefix"
  | "provider_usage_missing"
  | "provider_no_cache_hit"
  | "provider_cache_ttl_or_routing"
  | "prefix_below_provider_minimum";

export interface CacheDebugTraceContext {
  sessionKey?: string | null;
  requestId?: string | null;
  clientKind?: string | null;
}

export interface CacheDebugUsage {
  prompt: number;
  completion: number;
  cached: number;
  creation: number;
}

export interface CacheDebugTraceRecord {
  level: number;
  msg: "provider_cache_debug_trace";
  schema_version: "provider_cache_debug_trace_v1";
  provider: string;
  tier: string;
  model: string;
  source: "stream" | "non_stream";
  request_id: string;
  session_key_hash: string;
  client_kind: string;
  message_count: number;
  tool_count: number;
  payload_bytes: number;
  body_hash: string;
  toolset_hash: string;
  first_message_hashes: string[];
  stable_prefix_bytes: number;
  shared_prefix_bytes: number;
  first_divergence_byte_offset: number;
  first_divergence_message_index: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  cache_hit_pct: number;
  cache_miss_reason: CacheDebugMissReason;
}

interface CacheDebugRequestSnapshot {
  sessionKey: string;
  requestId: string;
  clientKind: string;
  bodyHash: string;
  payloadBytes: number;
  messageHashes: string[];
  systemPrefixHashes: string[];
  systemPrefixContentBytes: number[];
  firstMessageHashes: string[];
  toolsetHash: string;
  messageCount: number;
  toolCount: number;
  stablePrefixBytes: number;
  volatilePrefixMetadata: boolean;
}

interface PreviousCacheDebugSnapshot {
  requestId: string;
  messageHashes: string[];
  systemPrefixHashes: string[];
  systemPrefixContentBytes: number[];
  toolsetHash: string;
  volatilePrefixMetadata: boolean;
}

const previousBySession = new Map<string, PreviousCacheDebugSnapshot>();
const MAX_PREVIOUS_SESSIONS = 512;
const MIN_PROVIDER_CACHE_TOKENS = 1024;
const BYTES_PER_TOKEN_ESTIMATE = 4;

function hashText(value: string, length = 16): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function safeNumber(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function normalizeContext(context?: CacheDebugTraceContext): { sessionKey: string; requestId: string; clientKind: string } {
  const sessionKey = (context?.sessionKey ?? "").trim() || "unknown-session";
  const requestId = (context?.requestId ?? "").trim() || "unknown-request";
  const clientKind = (context?.clientKind ?? "").trim() || "unknown-client";
  return { sessionKey, requestId, clientKind };
}

function contentBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(stableJsonStringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value ?? ""), "utf8");
  }
}

function messageRole(value: unknown): string {
  if (!value || typeof value !== "object") return "?";
  return String((value as Record<string, unknown>).role ?? "?");
}

function canonicalHash(value: unknown): string {
  return hashText(stableJsonStringify(value));
}

function firstChangedMessageIndex(previous: string[], current: string[]): number {
  const max = Math.max(previous.length, current.length);
  for (let idx = 0; idx < max; idx += 1) {
    if (previous[idx] !== current[idx]) return idx;
  }
  return -1;
}

function containsVolatilePrefixMetadata(raw: string): boolean {
  return /\b(today'?s date|current date|cwd|working directory|project root|shell cwd|workspace|timestamp|time zone|timezone)\b/i.test(raw);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return stableJsonStringify(value);
  } catch {
    return String(value ?? "");
  }
}

function sharedStablePrefixBytes(
  previous: PreviousCacheDebugSnapshot | undefined,
  current: CacheDebugRequestSnapshot,
): number {
  if (!previous) return 0;
  const max = Math.min(previous.systemPrefixHashes.length, current.systemPrefixHashes.length);
  let shared = 0;
  for (let idx = 0; idx < max; idx += 1) {
    if (previous.systemPrefixHashes[idx] !== current.systemPrefixHashes[idx]) break;
    shared += Math.min(
      previous.systemPrefixContentBytes[idx] ?? 0,
      current.systemPrefixContentBytes[idx] ?? 0,
    );
  }
  return shared;
}

export function buildCacheDebugRequestSnapshot(
  bodyText: string,
  context?: CacheDebugTraceContext,
): CacheDebugRequestSnapshot | null {
  if (!bodyText.trim()) return null;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const { sessionKey, requestId, clientKind } = normalizeContext(context);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messageHashes = messages.map((message) => canonicalHash(message));
  const firstMessageHashes = messages.slice(0, 5).map((message, idx) => {
    const bytes = contentBytes(message);
    return `${idx}:${messageRole(message)}:${messageHashes[idx] ?? ""}:${bytes}`;
  });
  const systemPrefixHashes: string[] = [];
  const systemPrefixContentBytes: number[] = [];
  let stablePrefixBytes = 0;
  let volatilePrefixMetadata = false;
  for (const message of messages) {
    if (messageRole(message) !== "system") break;
    const content = (message as Record<string, unknown>).content;
    const bytes = contentBytes(content);
    systemPrefixHashes.push(canonicalHash(message));
    systemPrefixContentBytes.push(bytes);
    stablePrefixBytes += bytes;
    volatilePrefixMetadata = volatilePrefixMetadata || containsVolatilePrefixMetadata(contentText(content));
  }
  const toolsetHash = tools.length > 0 ? `${tools.length}:${canonicalHash(tools)}` : "0:empty";

  return {
    sessionKey,
    requestId,
    clientKind,
    bodyHash: hashText(bodyText),
    payloadBytes: Buffer.byteLength(bodyText, "utf8"),
    messageHashes,
    systemPrefixHashes,
    systemPrefixContentBytes,
    firstMessageHashes,
    toolsetHash,
    messageCount: messages.length,
    toolCount: tools.length,
    stablePrefixBytes,
    volatilePrefixMetadata,
  };
}

function classifyCacheMissReason(
  snapshot: CacheDebugRequestSnapshot,
  previous: PreviousCacheDebugSnapshot | undefined,
  usage: CacheDebugUsage,
): CacheDebugMissReason {
  const prompt = safeNumber(usage.prompt);
  const completion = safeNumber(usage.completion);
  const cached = safeNumber(usage.cached);
  if (cached > 0) return "cache_hit";
  if (prompt <= 0 && completion <= 0) return "provider_usage_missing";
  const stablePrefixTokens = Math.floor(snapshot.stablePrefixBytes / BYTES_PER_TOKEN_ESTIMATE);
  if (stablePrefixTokens < MIN_PROVIDER_CACHE_TOKENS) return "prefix_below_provider_minimum";
  if (!previous) return "first_request";
  if (previous.toolsetHash !== snapshot.toolsetHash) return "toolset_changed";
  const firstSystemChange = firstChangedMessageIndex(previous.systemPrefixHashes, snapshot.systemPrefixHashes);
  if (firstSystemChange >= 0) {
    return snapshot.volatilePrefixMetadata || previous.volatilePrefixMetadata
      ? "volatile_metadata_in_prefix"
      : "system_prefix_changed";
  }
  const sharedBytes = sharedStablePrefixBytes(previous, snapshot);
  if (sharedBytes >= snapshot.stablePrefixBytes) {
    return "provider_cache_ttl_or_routing";
  }
  return "provider_no_cache_hit";
}

function prunePreviousSnapshots(): void {
  while (previousBySession.size > MAX_PREVIOUS_SESSIONS) {
    const oldest = previousBySession.keys().next().value as string | undefined;
    if (!oldest) break;
    previousBySession.delete(oldest);
  }
}

export function buildAndRememberCacheDebugTrace(
  params: {
    provider: string;
    tier: string;
    model: string;
    source: "stream" | "non_stream";
    snapshot: CacheDebugRequestSnapshot;
    usage: CacheDebugUsage;
  },
): CacheDebugTraceRecord {
  const previous = previousBySession.get(params.snapshot.sessionKey);
  const sharedBytes = sharedStablePrefixBytes(previous, params.snapshot);
  const firstMessageIndex = previous
    ? firstChangedMessageIndex(previous.messageHashes, params.snapshot.messageHashes)
    : -1;
  const prompt = safeNumber(params.usage.prompt);
  const cached = Math.min(safeNumber(params.usage.cached), prompt);

  const record: CacheDebugTraceRecord = {
    level: 20,
    msg: "provider_cache_debug_trace",
    schema_version: "provider_cache_debug_trace_v1",
    provider: params.provider,
    tier: params.tier,
    model: params.model,
    source: params.source,
    request_id: params.snapshot.requestId,
    session_key_hash: hashText(params.snapshot.sessionKey),
    client_kind: params.snapshot.clientKind,
    message_count: params.snapshot.messageCount,
    tool_count: params.snapshot.toolCount,
    payload_bytes: params.snapshot.payloadBytes,
    body_hash: params.snapshot.bodyHash,
    toolset_hash: params.snapshot.toolsetHash,
    first_message_hashes: params.snapshot.firstMessageHashes,
    stable_prefix_bytes: params.snapshot.stablePrefixBytes,
    shared_prefix_bytes: sharedBytes,
    first_divergence_byte_offset: previous ? sharedBytes : -1,
    first_divergence_message_index: firstMessageIndex,
    prompt_tokens: prompt,
    completion_tokens: safeNumber(params.usage.completion),
    cached_tokens: cached,
    cache_creation_tokens: safeNumber(params.usage.creation),
    cache_hit_pct: prompt > 0 ? Math.round((cached / prompt) * 100) : 0,
    cache_miss_reason: classifyCacheMissReason(params.snapshot, previous, params.usage),
  };

  previousBySession.set(params.snapshot.sessionKey, {
    requestId: params.snapshot.requestId,
    messageHashes: params.snapshot.messageHashes,
    systemPrefixHashes: params.snapshot.systemPrefixHashes,
    systemPrefixContentBytes: params.snapshot.systemPrefixContentBytes,
    toolsetHash: params.snapshot.toolsetHash,
    volatilePrefixMetadata: params.snapshot.volatilePrefixMetadata,
  });
  prunePreviousSnapshots();
  return record;
}

export function resetCacheDebugTraceState(): void {
  previousBySession.clear();
}
