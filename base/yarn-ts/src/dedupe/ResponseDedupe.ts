import crypto from "node:crypto";
import { classifyTool } from "../tool-collapse/tool-call-collapser.js";
import type { DedupeLogEvent } from "./types.js";
import { hashToolCall } from "./ToolCallDedupe.js";
import type { DedupeCache } from "./DedupeCache.js";

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}

function responseCacheKey(toolName: string, input: unknown, resultHash: string): string {
  return `${hashToolCall(toolName, input)}\0${resultHash}`;
}

export interface ResponseDedupeOptions {
  log?: (e: DedupeLogEvent) => void;
}

/**
 * Tracks identical read/search tool results in an LRU so we can recognize repeats.
 * Always reinjects the **full** cached payload on hit — never a stub — so the model
 * retains trustworthy file/search bytes in context (token savings belong in
 * content-addressed dedup + replay envelopes, not opaque placeholders).
 */
export class ResponseDedupe {
  constructor(
    private readonly cache: DedupeCache,
    private readonly opts: ResponseDedupeOptions,
  ) {}

  /**
   * @returns Tool result text (full body; may be reinjected from cache on repeat)
   */
  wrapToolResult(toolName: string, input: unknown, resultText: string): string {
    const k = classifyTool(toolName);
    if (k === "run_tests" || k === "str_replace") {
      return resultText;
    }
    if (k !== "read_file" && k !== "search") {
      return resultText;
    }

    const h = contentHash(resultText);
    const key = responseCacheKey(toolName, input, h);
    const prev = this.cache.getResponse(key);
    if (prev !== undefined) {
      this.opts.log?.({
        kind: "response_cache_hit",
        message: "dedupe: identical read/search result; reinjecting cached full body",
        detail: key.slice(0, 32),
      });
      return prev;
    }

    this.cache.setResponse(key, resultText);
    return resultText;
  }
}
