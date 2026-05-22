import crypto from "node:crypto";
import type { EndpointTransportAdapter } from "./types.js";

interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  [key: string]: unknown;
}

interface ToolDef {
  type?: string;
  function?: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

export type DashScopeExplicitCacheMode = "off" | "canary" | "auto";

export interface DashScopeEndpointAdapterOptions {
  mode: DashScopeExplicitCacheMode;
  canaryPct: number;
  maxMarkers: number;
}

const MIN_CACHE_TOKENS = 1024;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return String(msg.content ?? "");
}

function stableBucket(sessionKey: string): number {
  const hash = crypto.createHash("sha256").update(sessionKey || "anon").digest();
  return hash.readUInt32BE(0) % 100;
}

function shouldEnable(mode: DashScopeExplicitCacheMode, canaryPct: number, sessionKey: string | null): boolean {
  if (mode === "auto") return true;
  if (mode !== "canary") return false;
  const pct = Math.max(0, Math.min(100, Math.floor(canaryPct)));
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return stableBucket(sessionKey ?? "anon") < pct;
}

function ensureArrayContent(msg: ChatMessage): ContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map((block) => ({ ...block }));
  }
  return [{ type: "text", text: String(msg.content ?? "") }];
}

function injectMessageMarkers(messages: ChatMessage[], markerIndices: number[], maxMarkers: number): ChatMessage[] {
  const capped = markerIndices.slice(0, Math.max(0, maxMarkers));
  if (capped.length === 0) return messages;
  const indices = new Set(capped);
  return messages.map((msg, idx) => {
    if (!indices.has(idx)) return msg;
    const blocks = ensureArrayContent(msg);
    if (blocks.length === 0) return msg;
    const last = blocks[blocks.length - 1];
    blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    return { ...msg, content: blocks };
  });
}

function injectToolMarker(tools: ToolDef[] | undefined): ToolDef[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const out = [...tools];
  out[out.length - 1] = { ...out[out.length - 1], cache_control: { type: "ephemeral" } };
  return out;
}

function markerTokenEstimate(messages: ChatMessage[], markerIndex: number): number {
  let total = 0;
  for (let i = 0; i <= markerIndex; i += 1) {
    total += estimateTokens(messageText(messages[i]));
  }
  return total;
}

function actualStableSystemEnd(messages: ChatMessage[]): number {
  let lastSystemIdx = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role !== "system") break;
    lastSystemIdx = i;
  }
  return lastSystemIdx;
}

function validMarkerIndices(messages: ChatMessage[], markerIndices: number[], maxMarkers: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const idx of markerIndices) {
    if (out.length >= maxMarkers) break;
    if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length || seen.has(idx)) continue;
    if (markerTokenEstimate(messages, idx) < MIN_CACHE_TOKENS) continue;
    out.push(idx);
    seen.add(idx);
  }
  return out;
}

function markerSkipReason(
  stableSystemEnd: number,
  stablePrefixTokens: number,
  optimizerMarkers: number[],
  maxMarkers: number,
): string {
  if (maxMarkers <= 0) return "max_markers_zero";
  if (stableSystemEnd < 0) return "no_stable_system_prefix";
  if (optimizerMarkers.length === 0) return "optimizer_marker_missing";
  if (stablePrefixTokens < MIN_CACHE_TOKENS) return "stable_prefix_below_min_tokens";
  return "marker_validation_failed";
}

/**
 * DashScope explicit context cache support.
 *
 * This adapter is intentionally endpoint-scoped and gated. It only mutates the
 * provider-facing request body after PrefixOptimizer has produced fixed marker
 * indices for the current session. Client-facing Anthropic/OpenAI protocol
 * state is unchanged.
 */
export function createDashScopeEndpointAdapter(options: DashScopeEndpointAdapterOptions): EndpointTransportAdapter {
  return {
    id: "dashscope",
    telemetryProviderTag: "dashscope",

    augmentRequest(input, init, getSessionKey, getMarkerIndices) {
      const sessionKey = getSessionKey();
      if (!shouldEnable(options.mode, options.canaryPct, sessionKey)) {
        return { input, init };
      }
      if (!init?.body || typeof init.body !== "string") {
        return { input, init };
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return { input, init };
      }
      if (!Array.isArray(body.messages)) {
        return { input, init };
      }

      const messages = body.messages as ChatMessage[];
      const optimizerMarkers = getMarkerIndices?.() ?? [];
      const stableSystemEnd = actualStableSystemEnd(messages);
      const stablePrefixTokens = stableSystemEnd >= 0
        ? markerTokenEstimate(messages, stableSystemEnd)
        : 0;
      const markerCandidates = optimizerMarkers.length > 0 && stableSystemEnd >= 0
        ? [stableSystemEnd]
        : [];
      const markerIndices = validMarkerIndices(messages, markerCandidates, options.maxMarkers);
      if (markerIndices.length === 0) {
        console.log(JSON.stringify({
          level: 20,
          msg: "dashscope_explicit_cache_decision",
          mode: options.mode,
          applied: false,
          skip_reason: markerSkipReason(
            stableSystemEnd,
            stablePrefixTokens,
            optimizerMarkers,
            options.maxMarkers,
          ),
          session_key_present: Boolean(sessionKey),
          optimizer_marker_indices: optimizerMarkers,
          stable_system_end: stableSystemEnd,
          stable_prefix_tokens: stablePrefixTokens,
          message_count: messages.length,
          cache_strategy: "explicit_premium",
          recommendation: "preserve_stable_prefix",
        }));
        return { input, init };
      }

      body.messages = injectMessageMarkers(messages, markerIndices, options.maxMarkers);
      if (Array.isArray(body.tools)) {
        body.tools = injectToolMarker(body.tools as ToolDef[]);
      }

      const serializedBody = JSON.stringify(body);
      const headers = new Headers(init.headers ?? undefined);
      headers.delete("content-length");
      console.log(JSON.stringify({
        level: 20,
        msg: "dashscope_explicit_cache_markers_applied",
        mode: options.mode,
        session_key_present: Boolean(sessionKey),
        marker_indices: markerIndices,
        optimizer_marker_indices: optimizerMarkers,
        marker_count: markerIndices.length,
        message_count: messages.length,
        tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        stable_system_end: stableSystemEnd,
        stable_prefix_tokens: stablePrefixTokens,
        cache_strategy: "explicit_premium",
        recommendation: "observe_provider_cache_hits",
      }));
      return {
        input,
        init: { ...init, headers, body: serializedBody },
      };
    },

    async transformResponse(response) {
      return response;
    },
  };
}
