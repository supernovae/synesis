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

import crypto from "node:crypto";
import type {
  ChatMessage,
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
import { buildDiagnostics, logPrefixDiagnostics, logPrefixDivergence } from "./diagnostics.js";
import { extractMetadataFromMessages } from "./metadata-extractor.js";
import { canonicalStringify } from "./serializer.js";
import { isSyntheticHarnessReminderText } from "../../adapters/synthetic-reminders.js";

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

interface ComparablePromptChunk {
  region: string;
  hash: string;
  bytes: number;
}

interface ComparablePromptFingerprint {
  chunks: ComparablePromptChunk[];
  totalBytes: number;
}

interface PromptDivergenceSummary {
  divergeAtByte: number;
  divergenceRegion: string;
  previousPayloadBytes: number;
  currentPayloadBytes: number;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function chunkFingerprint(region: string, text: string): ComparablePromptChunk {
  return {
    region,
    hash: hashText(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function computeSharedPrefix(
  previous: ComparablePromptFingerprint | null,
  current: ComparablePromptFingerprint,
): { bytes: number; divergence: PromptDivergenceSummary | null } {
  if (!previous) return { bytes: 0, divergence: null };
  const max = Math.min(previous.chunks.length, current.chunks.length);
  let bytes = 0;
  for (let idx = 0; idx < max; idx += 1) {
    const prev = previous.chunks[idx];
    const curr = current.chunks[idx];
    if (prev.hash !== curr.hash || prev.bytes !== curr.bytes) {
      return {
        bytes,
        divergence: {
          divergeAtByte: bytes,
          divergenceRegion: curr.region,
          previousPayloadBytes: previous.totalBytes,
          currentPayloadBytes: current.totalBytes,
        },
      };
    }
    bytes += curr.bytes;
  }
  if (previous.chunks.length !== current.chunks.length) {
    return {
      bytes,
      divergence: {
        divergeAtByte: bytes,
        divergenceRegion: current.chunks[max]?.region ?? "end",
        previousPayloadBytes: previous.totalBytes,
        currentPayloadBytes: current.totalBytes,
      },
    };
  }
  return { bytes, divergence: null };
}

function buildComparablePromptFingerprint(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
): ComparablePromptFingerprint {
  const toolsSlice = canonicalStringify(tools ?? []);
  const chunks = [chunkFingerprint("tools", `tools=${toolsSlice}\nmessages=`)];
  for (const [idx, message] of messages.entries()) {
    const boundary = idx === 0 ? "" : "\n<MSG_BOUNDARY>\n";
    chunks.push(chunkFingerprint(`message[${idx}]`, `${boundary}${canonicalStringify(message)}`));
  }
  return {
    chunks,
    totalBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
  };
}

export class PrefixOptimizer {
  private readonly opts: PrefixOptimizerOpts;
  private sessionDiagnostics = new Map<string, PrefixDiagnostics>();
  private sessionMarkerIndices = new Map<string, number[]>();
  private sessionPromptFingerprints = new Map<string, ComparablePromptFingerprint>();

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
    overrides?: { markerBackend?: MarkerBackend },
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
      const hasTaskFrameBlock = frameSeg.content.includes("<TASK_FRAME>");
      const hasSyntheticReminderObjective = hasTaskFrameBlock
        && isSyntheticHarnessReminderText(frameSeg.content.match(/\bobjective=(.+)/)?.[1] ?? "");
      if (frameText && (!hasTaskFrameBlock || hasSyntheticReminderObjective)) {
        frameSeg.content = frameText;
        frameSeg.hash = frameHash;
      }
      // If the payload already contains a TASK_FRAME block, keep the hash tied
      // to that exact segment content to avoid diagnostic drift.
    }

    const rebuilt = rebuildRequest(segments, messages);

    const effectiveMarkerBackend = overrides?.markerBackend ?? this.opts.markerBackend;
    const markerIndices = computeMarkerPlacements(
      rebuilt,
      segments,
      previousDiag,
      effectiveMarkerBackend,
      this.opts.maxMarkers,
    );

    const resolvedTools = canonicalTools.length > 0 ? canonicalTools : tools;
    const comparableFingerprint = buildComparablePromptFingerprint(rebuilt, resolvedTools);
    const previousFingerprint = this.sessionPromptFingerprints.get(sessionKey) ?? null;
    const { bytes: prefixStableBytes, divergence } = computeSharedPrefix(previousFingerprint, comparableFingerprint);
    this.sessionPromptFingerprints.set(sessionKey, comparableFingerprint);

    const diagnostics = buildDiagnostics(
      segments,
      markerIndices,
      effectiveMarkerBackend,
      previousDiag,
      prefixStableBytes,
    );

    this.sessionDiagnostics.set(sessionKey, diagnostics);
    this.sessionMarkerIndices.set(sessionKey, markerIndices);

    if (this.opts.enableDiagnosticLogging) {
      logPrefixDiagnostics(diagnostics, previousDiag, null);
      if (divergence && prefixStableBytes < comparableFingerprint.totalBytes) {
        logPrefixDivergence(divergence);
      }
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
    this.sessionPromptFingerprints.delete(sessionKey);
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
export { buildDiagnostics, logPrefixDiagnostics, logPrefixDivergence, generateMissReport } from "./diagnostics.js";
export { canonicalizeMessage, canonicalStringify, normalizeWhitespace } from "./serializer.js";
export { extractClientMetadata, extractMetadataFromMessages } from "./metadata-extractor.js";
