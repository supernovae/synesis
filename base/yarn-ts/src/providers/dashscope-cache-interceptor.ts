/**
 * DashScope Explicit Cache Marker Injector
 *
 * Thin fetch wrapper that injects `cache_control: { type: "ephemeral" }`
 * markers at message indices determined by the PrefixOptimizer.
 *
 * The optimizer (application layer) decides WHERE markers go based on
 * semantic content stability. This interceptor (transport layer) only
 * applies the markers to the serialized request body and captures
 * response usage for diagnostics.
 *
 * Also supports a legacy fallback mode (selectBreakpoints) when the
 * optimizer is not active.
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
 * Legacy breakpoint selection — used only when the PrefixOptimizer is not active.
 * Computes message indices from role boundaries (least accurate but still functional).
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

  if (lastSystemIdx >= 0) {
    indices.push(lastSystemIdx);
  }

  if (firstNonSystemIdx >= 0 && firstNonSystemIdx !== lastSystemIdx && !indices.includes(firstNonSystemIdx)) {
    indices.push(firstNonSystemIdx);
  }

  let finalUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      finalUserIdx = i;
      break;
    }
  }

  if (finalUserIdx > 0) {
    const historyBoundary = finalUserIdx - 1;
    if (!indices.includes(historyBoundary)) {
      indices.push(historyBoundary);
    }
  }

  if (finalUserIdx >= 0 && !indices.includes(finalUserIdx)) {
    indices.push(finalUserIdx);
  }

  return indices.slice(0, maxMarkers);
}

/**
 * Inject cache_control markers at specified message indices.
 */
export function injectCacheMarkers(messages: ChatMessage[], markerIndices: number[]): ChatMessage[] {
  const indices = new Set(markerIndices);
  if (indices.size === 0) return messages;

  return messages.map((msg, idx) => {
    if (!indices.has(idx)) return msg;
    const blocks = tagLastBlock(ensureArrayContent(msg));
    return { ...msg, content: blocks };
  });
}

interface ToolDef {
  type: string;
  function: Record<string, unknown>;
  cache_control?: { type: string };
  [key: string]: unknown;
}

/**
 * Add cache_control to the last tool definition.
 * DashScope requires this for proper cache keying of tool schemas
 * (per Qwen Code reference implementation).
 */
export function injectToolCacheMarker(tools: ToolDef[]): ToolDef[] {
  if (tools.length === 0) return tools;
  const result = [...tools];
  result[result.length - 1] = {
    ...result[result.length - 1],
    cache_control: { type: "ephemeral" },
  };
  return result;
}

/**
 * Create a fetch wrapper that injects DashScope cache markers.
 *
 * When `getMarkerIndices` is provided (optimizer active), uses those indices.
 * Otherwise falls back to legacy selectBreakpoints.
 */
export function createDashScopeCacheFetch(
  nativeFetch: typeof globalThis.fetch,
  maxMarkers = 3,
  getMarkerIndices?: () => number[],
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

      const indices = getMarkerIndices
        ? getMarkerIndices()
        : selectBreakpoints(body.messages, maxMarkers);

      body.messages = injectCacheMarkers(body.messages, indices);
      if (Array.isArray(body.tools) && body.tools.length > 0 && indices.length > 0) {
        body.tools = injectToolCacheMarker(body.tools);
      }
      const hasStream = body.stream === true;

      const boundaryIdx = indices.length > 0 ? indices[indices.length - 1] : -1;
      const toolsJson = Array.isArray(body.tools) && body.tools.length > 0
        ? JSON.stringify(body.tools)
        : null;

      let toolsHash = "";
      let prefixSliceHash = "";
      let prevBoundaryHash = "";
      try {
        const encoder = new TextEncoder();
        async function sha256Hex16(data: string): Promise<string> {
          const h = await crypto.subtle.digest("SHA-256", encoder.encode(data));
          return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
        }
        if (toolsJson) {
          toolsHash = await sha256Hex16(toolsJson);
        }
        if (boundaryIdx >= 0) {
          const slice = JSON.stringify(body.messages.slice(0, boundaryIdx + 1));
          prefixSliceHash = await sha256Hex16(slice);
        }
        if (boundaryIdx >= 2) {
          const prevSlice = JSON.stringify(body.messages.slice(0, boundaryIdx - 1));
          prevBoundaryHash = await sha256Hex16(prevSlice);
        }
      } catch { /* crypto not available in all envs */ }

      console.log(JSON.stringify({
        level: 20,
        msg: "dashscope_cache_markers_injected",
        messageCount: body.messages.length,
        markerIndices: indices,
        markerCount: indices.length,
        boundaryIdx,
        optimizerActive: !!getMarkerIndices,
        stream: hasStream,
        url: String(input).replace(/\?.*/, ""),
        toolsHash,
        prefixSliceHash,
        prevBoundaryHash,
        toolsLen: toolsJson?.length ?? 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        toolsMarked: Array.isArray(body.tools) && body.tools.length > 0 && indices.length > 0,
      }));

      const resp = await nativeFetch(input, { ...init, body: JSON.stringify(body) });
      if (!hasStream) return resp;

      const origBody = resp.body;
      if (!origBody) return resp;
      const [forSDK, forDiag] = origBody.tee();

      (async () => {
        try {
          const reader = forDiag.getReader();
          const decoder = new TextDecoder();
          let lastUsage = "";
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (line.startsWith("data: ") && line.includes('"usage"') && !line.includes('"usage":null')) {
                lastUsage = line.slice(6);
              }
            }
          }
          if (lastUsage) {
            try {
              const parsed = JSON.parse(lastUsage);
              console.log(JSON.stringify({
                level: 20,
                msg: "dashscope_response_usage",
                cached_tokens: parsed?.usage?.prompt_tokens_details?.cached_tokens ?? "MISSING",
                cache_creation: parsed?.usage?.prompt_tokens_details?.cache_creation_input_tokens ?? "MISSING",
                prompt_tokens: parsed?.usage?.prompt_tokens ?? "MISSING",
              }));
            } catch { /* ignore parse error */ }
          }
        } catch { /* ignore stream read error */ }
      })();

      return new Response(forSDK, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    } catch {
      return nativeFetch(input, init);
    }
  };
}
