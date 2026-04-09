/**
 * Canonical Serializer
 *
 * Produces deterministic byte sequences from messages and content blocks.
 * Required for stable hash computation — identical logical content must
 * always produce identical bytes regardless of key ordering, whitespace
 * variation, or non-semantic differences.
 */

import { sortObjectKeys } from "../../compat/sorted-tools.js";
import type { ChatMessage, ContentBlock } from "./types.js";

/**
 * Canonical key order for content blocks.
 * Keys not in this list are sorted alphabetically after the canonical ones.
 */
const CONTENT_BLOCK_KEY_ORDER = ["type", "text", "cache_control"];

/**
 * Canonical key order for messages.
 */
const MESSAGE_KEY_ORDER = ["role", "content", "name", "tool_call_id", "tool_calls"];

function orderKeys(obj: Record<string, unknown>, priority: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of priority) {
    if (key in obj) result[key] = obj[key];
  }
  const remaining = Object.keys(obj).filter((k) => !priority.includes(k)).sort();
  for (const key of remaining) {
    result[key] = obj[key];
  }
  return result;
}

/**
 * Normalize whitespace in text content for stable hashing.
 * Collapses multiple blank lines to a single blank line, trims trailing
 * whitespace on each line, and ensures consistent \n line endings.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Canonicalize a single content block for deterministic serialization.
 */
export function canonicalizeContentBlock(block: ContentBlock): ContentBlock {
  const canonical: Record<string, unknown> = {};
  for (const key of CONTENT_BLOCK_KEY_ORDER) {
    if (key in block) {
      canonical[key] = key === "text" && typeof block[key] === "string"
        ? normalizeWhitespace(block[key] as string)
        : block[key];
    }
  }
  const remaining = Object.keys(block).filter((k) => !CONTENT_BLOCK_KEY_ORDER.includes(k)).sort();
  for (const key of remaining) {
    canonical[key] = block[key];
  }
  return canonical as ContentBlock;
}

/**
 * Canonicalize content blocks array.
 */
export function canonicalizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(canonicalizeContentBlock);
}

/**
 * Canonicalize a message for deterministic serialization.
 * Strips non-semantic variation (key order, whitespace) while preserving content.
 */
export function canonicalizeMessage(msg: ChatMessage): ChatMessage {
  const ordered = orderKeys(msg as Record<string, unknown>, MESSAGE_KEY_ORDER);
  if (typeof ordered.content === "string") {
    ordered.content = normalizeWhitespace(ordered.content);
  } else if (Array.isArray(ordered.content)) {
    ordered.content = canonicalizeContentBlocks(ordered.content as ContentBlock[]);
  }
  if (ordered.tool_calls) {
    ordered.tool_calls = sortObjectKeys(ordered.tool_calls);
  }
  return ordered as ChatMessage;
}

/**
 * Produce a deterministic string representation for hashing.
 * Uses sorted keys recursively.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}
