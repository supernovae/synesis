/**
 * Synesis Prefix Optimizer
 *
 * Provider-agnostic prompt prefix optimizer that restructures IDE traffic
 * into a stable-prefix-first layout for maximum KV-cache reuse at any
 * OpenAI-compatible endpoint.
 *
 * Benefits every provider's implicit KV-cache (prefix matching in the
 * attention engine). For providers with explicit caching (DashScope,
 * Anthropic), additionally places cache_control markers on stable boundaries.
 *
 * Architecture:
 *   parse → classify → canonicalize tools → compact frame → rebuild →
 *   compute markers → serialize → diagnostics
 */

import type {
  ChatMessage,
  ClientMetadata,
  MarkerBackend,
  OptimizedRequest,
  PrefixDiagnostics,
  ToolDefinition,
} from "./types.js";
import { parseRequest } from "./request-parser.js";
import { canonicalizeTools } from "./tool-canonicalizer.js";
import { extractCompactFrame } from "./frame-compactor.js";
import { rebuildRequest } from "./request-rebuilder.js";
import { computeMarkerPlacements } from "./marker-policy.js";
import { buildDiagnostics, logPrefixDiagnostics } from "./diagnostics.js";
import { extractMetadataFromMessages } from "./metadata-extractor.js";
import { canonicalStringify } from "./serializer.js";

export interface PrefixOptimizerOpts {
  markerBackend: MarkerBackend;
  maxMarkers: number;
  enableReduction: boolean;
  enableDiagnosticLogging: boolean;
}

const DEFAULT_OPTS: PrefixOptimizerOpts = {
  markerBackend: "none",
  maxMarkers: 3,
  enableReduction: true,
  enableDiagnosticLogging: true,
};

function computeSharedPrefixBytes(previousPayload: string | null, currentPayload: string): number {
  if (!previousPayload || !currentPayload) return 0;
  const prev = Buffer.from(previousPayload, "utf8");
  const curr = Buffer.from(currentPayload, "utf8");
  const max = Math.min(prev.length, curr.length);
  let idx = 0;
  while (idx < max && prev[idx] === curr[idx]) idx += 1;
  return idx;
}

function buildComparablePromptPayload(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
): string {
  const toolsSlice = canonicalStringify(tools ?? []);
  const messageSlice = messages
    .map((m) => canonicalStringify(m))
    .join("\n<MSG_BOUNDARY>\n");
  return `tools=${toolsSlice}\nmessages=${messageSlice}`;
}

export class PrefixOptimizer {
  private readonly opts: PrefixOptimizerOpts;
  private sessionDiagnostics = new Map<string, PrefixDiagnostics>();
  private sessionMarkerIndices = new Map<string, number[]>();
  private sessionPromptPayloads = new Map<string, string>();

  constructor(opts?: Partial<PrefixOptimizerOpts>) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /**
   * Optimize a request for prefix-cache reuse.
   *
   * Restructures messages so stable content leads the prompt (benefiting
   * any provider's implicit KV-cache). For explicit-cache providers,
   * additionally computes marker placement indices.
   */
  optimize(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    sessionKey: string,
  ): OptimizedRequest {
    const previousDiag = this.sessionDiagnostics.get(sessionKey) ?? null;

    const clientMetadata = extractMetadataFromMessages(messages);

    const { tools: canonicalTools, hash: toolsetHash } = canonicalizeTools(tools);

    const segments = parseRequest(messages, canonicalTools.length > 0 ? canonicalTools : undefined);

    const toolSeg = segments.find((s) => s.category === "tool_definitions");
    if (toolSeg) {
      toolSeg.hash = toolsetHash;
    }

    const previousFrameHash = previousDiag?.frameHash ?? null;
    const { serialized: frameText, hash: frameHash } = extractCompactFrame(messages, previousFrameHash);

    const frameSeg = segments.find((s) => s.category === "task_frame");
    if (frameSeg) {
      if (frameText && !frameSeg.content.includes("<TASK_FRAME>")) {
        frameSeg.content = frameText;
      }
      frameSeg.hash = frameHash;
    }

    const rebuilt = rebuildRequest(segments, messages);

    const markerIndices = computeMarkerPlacements(
      rebuilt,
      segments,
      previousDiag,
      this.opts.markerBackend,
      this.opts.maxMarkers,
    );

    const resolvedTools = canonicalTools.length > 0 ? canonicalTools : tools;
    const comparablePayload = buildComparablePromptPayload(rebuilt, resolvedTools);
    const previousPayload = this.sessionPromptPayloads.get(sessionKey) ?? null;
    const prefixStableBytes = computeSharedPrefixBytes(previousPayload, comparablePayload);
    this.sessionPromptPayloads.set(sessionKey, comparablePayload);

    const diagnostics = buildDiagnostics(
      segments,
      markerIndices,
      this.opts.markerBackend,
      previousDiag,
      prefixStableBytes,
    );

    this.sessionDiagnostics.set(sessionKey, diagnostics);
    this.sessionMarkerIndices.set(sessionKey, markerIndices);

    if (this.opts.enableDiagnosticLogging) {
      logPrefixDiagnostics(diagnostics, previousDiag, null);
    }

    return {
      messages: rebuilt,
      tools: resolvedTools,
      markerIndices,
      diagnostics,
      clientMetadata,
    };
  }

  /**
   * Get the most recent diagnostics for a session.
   */
  getSessionDiagnostics(sessionKey: string): PrefixDiagnostics | null {
    return this.sessionDiagnostics.get(sessionKey) ?? null;
  }

  /**
   * Get the current marker indices for a session.
   * Used by the DashScope fetch interceptor to know where to place markers.
   */
  getMarkerIndicesForSession(sessionKey: string): number[] {
    return this.sessionMarkerIndices.get(sessionKey) ?? [];
  }

  /**
   * Evict session state (call on session close).
   */
  evictSession(sessionKey: string): void {
    this.sessionDiagnostics.delete(sessionKey);
    this.sessionMarkerIndices.delete(sessionKey);
    this.sessionPromptPayloads.delete(sessionKey);
  }

  /**
   * Get the configured marker backend.
   */
  get markerBackend(): MarkerBackend {
    return this.opts.markerBackend;
  }
}

export { type OptimizedRequest, type PrefixDiagnostics, type MarkerBackend, type ClientMetadata } from "./types.js";
export { canonicalizeTools } from "./tool-canonicalizer.js";
export { parseRequest } from "./request-parser.js";
export { classifyVolatility, splitAtVolatileBoundary } from "./volatility.js";
export { rebuildRequest, countSystemPrefix } from "./request-rebuilder.js";
export { computeMarkerPlacements } from "./marker-policy.js";
export { buildDiagnostics, logPrefixDiagnostics, generateMissReport } from "./diagnostics.js";
export { canonicalizeMessage, canonicalStringify, normalizeWhitespace } from "./serializer.js";
export { extractClientMetadata, extractMetadataFromMessages } from "./metadata-extractor.js";
