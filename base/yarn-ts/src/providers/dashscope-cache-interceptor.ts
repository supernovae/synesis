/**
 * DashScope Explicit Cache Interceptor
 *
 * Wraps native fetch to inject `cache_control: { type: "ephemeral" }` markers
 * into outgoing DashScope chat completion requests. DashScope supports up to
 * 4 markers per request; each creates a prefix-cache block from the start of
 * the messages array to the marker position.
 *
 * Marker placement strategy (most-stable → least-stable):
 *   1. Last system message — nearly 100% hit rate across turns
 *   2. Boundary between system block and conversation history
 *   3. Last message before the final user turn — high hit rate for tool loops
 *   4. Final user message — helps retry scenarios within the same turn
 *
 * Cost model: creation = 125% of input cost (one-time per 5 min TTL),
 * cache read = 10% of input cost.
 */

interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  [key: string]: unknown;
}

function ensureArrayContent(msg: ChatMessage): ContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map((b) => ({ ...b }));
  }
  return [{ type: "text", text: String(msg.content) }];
}

function tagLastBlock(blocks: ContentBlock[]): ContentBlock[] {
  if (blocks.length === 0) return blocks;
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  return blocks;
}

/**
 * Compute message indices that should receive cache_control markers,
 * ordered by priority (most stable first). Returns at most `maxMarkers`.
 */
export function selectBreakpoints(messages: ChatMessage[], maxMarkers: number): number[] {
  if (messages.length === 0 || maxMarkers <= 0) return [];

  const indices: number[] = [];

  let lastSystemIdx = -1;
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      lastSystemIdx = i;
    } else if (firstNonSystemIdx === -1) {
      firstNonSystemIdx = i;
    }
  }

  // Marker 1: last system message (most stable)
  if (lastSystemIdx >= 0) {
    indices.push(lastSystemIdx);
  }

  // Marker 2: first non-system message (system/conversation boundary)
  // Only distinct from marker 1 when there's a gap
  if (firstNonSystemIdx >= 0 && firstNonSystemIdx !== lastSystemIdx && !indices.includes(firstNonSystemIdx)) {
    indices.push(firstNonSystemIdx);
  }

  // Find the final user message index
  let finalUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      finalUserIdx = i;
      break;
    }
  }

  // Marker 3: last message before the final user turn (history boundary)
  if (finalUserIdx > 0) {
    const historyBoundary = finalUserIdx - 1;
    if (!indices.includes(historyBoundary)) {
      indices.push(historyBoundary);
    }
  }

  // Marker 4: final user message (retry scenarios)
  if (finalUserIdx >= 0 && !indices.includes(finalUserIdx)) {
    indices.push(finalUserIdx);
  }

  return indices.slice(0, maxMarkers);
}

/**
 * Inject cache_control markers into a cloned messages array.
 */
export function injectCacheMarkers(messages: ChatMessage[], maxMarkers: number): ChatMessage[] {
  const breakpoints = new Set(selectBreakpoints(messages, maxMarkers));
  if (breakpoints.size === 0) return messages;

  return messages.map((msg, idx) => {
    if (!breakpoints.has(idx)) return msg;
    const blocks = tagLastBlock(ensureArrayContent(msg));
    return { ...msg, content: blocks };
  });
}

/**
 * Create a fetch wrapper that injects DashScope cache markers.
 * Pass this as the `fetch` option to `createOpenAI()`.
 */
export function createDashScopeCacheFetch(
  nativeFetch: typeof globalThis.fetch,
  maxMarkers = 3,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== "string") {
      return nativeFetch(input, init);
    }

    try {
      const body = JSON.parse(init.body);
      if (!Array.isArray(body?.messages)) {
        return nativeFetch(input, init);
      }

      body.messages = injectCacheMarkers(body.messages, maxMarkers);
      return nativeFetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      return nativeFetch(input, init);
    }
  };
}
