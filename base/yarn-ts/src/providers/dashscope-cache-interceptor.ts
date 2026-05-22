/**
 * DashScope-style explicit cache marker injector (optional provider shim).
 *
 * **Not** required for core Yarn: kept for tests and re-wiring a DashScope or
 * similar HTTP layer without changing the `resolve()` call shape in
 * `SynesisProviderRegistry`. When enabled, the wrapper injects
 * `cache_control: { type: "ephemeral" }` at indices from the prefix optimizer
 * and records usage. See `docs/CACHING.md` for when explicit cache does or
 * does not help versus implicit prefix stability.
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
 *
 * With the fixed-position marker strategy, the marker never moves,
 * so we only need to convert MARKED messages to array format. Non-marked
 * messages keep their original format (string or array), preserving
 * byte-level stability of the prefix across requests.
 *
 * DashScope docs confirm that string content "A" matches cached
 * array content [{"type":"text","text":"A","cache_control":...}]
 * — the platform normalizes content format for cache key computation.
 */
export function injectCacheMarkers(messages: ChatMessage[], markerIndices: number[]): ChatMessage[] {
  const indices = new Set(markerIndices);

  return messages.map((msg, idx) => {
    if (indices.has(idx)) {
      const blocks = ensureArrayContent(msg);
      tagLastBlock(blocks);
      return { ...msg, content: blocks };
    }
    return msg;
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
// Module-level replay cache test state (persists across closure recreation)
let _replayBody: string | null = null;
let _replayUrl: string | null = null;
let _replayHeaders: Record<string, string> | null = null;
let _replayDone = false;
let _replayRequestCount = 0;

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

      let indices = getMarkerIndices
        ? getMarkerIndices()
        : selectBreakpoints(body.messages, maxMarkers);

      // Align with Qwen Code reference implementation: for streaming requests,
      // ALWAYS mark the last message (creates a cache block covering the entire
      // conversation prefix, enabling multi-turn cache reuse).
      const isStreaming = body.stream === true;
      if (isStreaming && body.messages.length > 0) {
        const lastIdx = body.messages.length - 1;
        const indicesSet = new Set(indices);
        if (!indicesSet.has(lastIdx)) {
          indices = [...indices, lastIdx];
        }
      }

      // --- PRE-INJECTION diagnostics (content before any markers) ---
      const encoder = new TextEncoder();
      async function sha256Hex16(data: string): Promise<string> {
        const h = await crypto.subtle.digest("SHA-256", encoder.encode(data));
        return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
      }

      const preInjectionHashes: string[] = [];
      let preMsg0Role = "";
      let preMsg0ContentType = "";
      let preMsg0Snippet = "";
      try {
        const diagCount = Math.min(8, body.messages.length);
        for (let i = 0; i < diagCount; i++) {
          preInjectionHashes.push(await sha256Hex16(JSON.stringify(body.messages[i])));
        }
        if (body.messages.length > 0) {
          const m0 = body.messages[0];
          preMsg0Role = m0.role ?? "";
          preMsg0ContentType = typeof m0.content === "string" ? "string"
            : Array.isArray(m0.content) ? "array" : typeof m0.content;
          const t = typeof m0.content === "string" ? m0.content : JSON.stringify(m0.content);
          preMsg0Snippet = t.slice(0, 120);
        }
      } catch { /* ignore */ }

      body.messages = injectCacheMarkers(body.messages, indices);
      // Qwen Code ref: tool cache_control only for streaming requests
      if (isStreaming && Array.isArray(body.tools) && body.tools.length > 0 && indices.length > 0) {
        body.tools = injectToolCacheMarker(body.tools);
      }
      const hasStream = isStreaming;

      const boundaryIdx = indices.length > 0 ? indices[indices.length - 1] : -1;
      const toolsJson = Array.isArray(body.tools) && body.tools.length > 0
        ? JSON.stringify(body.tools)
        : null;

      let toolsHash = "";
      let prefixSliceHash = "";
      const postInjectionHashes: string[] = [];
      try {
        if (toolsJson) {
          toolsHash = await sha256Hex16(toolsJson);
        }
        if (boundaryIdx >= 0) {
          const slice = JSON.stringify(body.messages.slice(0, boundaryIdx + 1));
          prefixSliceHash = await sha256Hex16(slice);
        }
        const diagCount = Math.min(8, body.messages.length);
        for (let i = 0; i < diagCount; i++) {
          postInjectionHashes.push(await sha256Hex16(JSON.stringify(body.messages[i])));
        }
      } catch { /* ignore */ }

      // Log all non-message/tool body fields to find extra cache-key contributors
      const bodyMeta: Record<string, unknown> = {};
      for (const key of Object.keys(body)) {
        if (key !== "messages" && key !== "tools") {
          bodyMeta[key] = body[key];
        }
      }

      // Count consecutive leading system messages and capture role sequence
      let leadingSystemCount = 0;
      const roleSeq: string[] = [];
      for (let i = 0; i < Math.min(6, body.messages.length); i++) {
        roleSeq.push(body.messages[i]?.role ?? "?");
        if (body.messages[i]?.role === "system" && leadingSystemCount === i) {
          leadingSystemCount++;
        }
      }

      // Capture content snippets for first 3 messages (pre-injection)
      const msgSnippets: string[] = [];
      for (let i = 0; i < Math.min(3, body.messages.length); i++) {
        const c = body.messages[i]?.content;
        const txt = typeof c === "string" ? c : JSON.stringify(c);
        msgSnippets.push(`msg[${i}]:${body.messages[i]?.role}:${txt.length}ch:"${txt.slice(0, 80)}"`);
      }

      // Capture request headers
      const headerKeys: string[] = [];
      try {
        if (init?.headers) {
          const h = init.headers;
          if (h instanceof Headers) {
            h.forEach((_v, k) => headerKeys.push(k));
          } else if (Array.isArray(h)) {
            for (const [k] of h) headerKeys.push(k);
          } else {
            headerKeys.push(...Object.keys(h as Record<string, string>));
          }
        }
      } catch { /* ignore */ }

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
        preInjectionHashes: preInjectionHashes.slice(0, 4),
        postInjectionHashes: postInjectionHashes.slice(0, 4),
        preMsg0Role,
        preMsg0ContentType,
        preMsg0Snippet,
        bodyMeta,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        leadingSystemCount,
        roleSeq,
        msgSnippets,
        headerKeys: headerKeys.sort(),
      }));

      const serializedBody = JSON.stringify(body);

      // Hash the full serialized body for cross-request comparison
      let fullBodyHash = "";
      try {
        fullBodyHash = await sha256Hex16(serializedBody);
      } catch { /* ignore */ }

      // Capture the exact structure of marked messages to verify cache_control injection
      const markedMsgStructures: string[] = [];
      for (const idx of indices) {
        const m = body.messages[idx];
        if (m && Array.isArray(m.content)) {
          const lastBlock = m.content[m.content.length - 1];
          markedMsgStructures.push(
            `msg[${idx}]:role=${m.role},blocks=${m.content.length},lastBlockKeys=${Object.keys(lastBlock ?? {}).sort().join(",")},hasCC=${!!lastBlock?.cache_control},textLen=${(lastBlock?.text ?? "").length}`
          );
        }
      }
      // Check if tools have cache_control
      let toolCCInfo = "no_tools";
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const lastTool = body.tools[body.tools.length - 1];
        toolCCInfo = `count=${body.tools.length},lastHasCC=${!!lastTool?.cache_control}`;
      }

      console.log(JSON.stringify({
        level: 20,
        msg: "dashscope_outbound_body",
        fullBodyHash,
        bodyBytes: serializedBody.length,
        markedMsgStructures,
        toolCCInfo,
      }));

      // --- Replay cache test: on 2nd request, replay the 1st request's exact body
      //     directly via globalThis.fetch to prove DashScope caching works from
      //     this Node.js process. Module-level state persists across closure recreation.
      _replayRequestCount++;
      if (!_replayDone && _replayBody && _replayUrl && _replayRequestCount >= 2) {
        _replayDone = true;
        (async () => {
          try {
            await new Promise(r => setTimeout(r, 8000));

            // Test A: Replay EXACT same body (proves cache works at all)
            const replayBodyA = JSON.parse(_replayBody!);
            replayBodyA.stream = false;
            delete replayBodyA.stream_options;
            replayBodyA.max_tokens = 10;
            const respA = await globalThis.fetch(new URL(_replayUrl!), {
              method: "POST",
              headers: { "Content-Type": "application/json", ..._replayHeaders! },
              body: JSON.stringify(replayBodyA),
            });
            const jsonA = await respA.json() as { usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number } } };
            const rdA = jsonA?.usage?.prompt_tokens_details;
            console.log(JSON.stringify({
              level: 30,
              msg: "dashscope_replay_cache_test",
              test: "A_exact_body",
              result: (rdA?.cached_tokens ?? 0) > 0 ? "CACHE_HIT" : "CACHE_MISS",
              prompt_tokens: jsonA?.usage?.prompt_tokens ?? "?",
              cached_tokens: rdA?.cached_tokens ?? 0,
              cache_creation: rdA?.cache_creation_input_tokens ?? 0,
            }));

            // Test B: Same prefix (msg[0] + tools) but DIFFERENT trailing messages
            // This tells us if DashScope caches by prefix or full body
            await new Promise(r => setTimeout(r, 2000));
            const replayBodyB = JSON.parse(_replayBody!);
            replayBodyB.stream = false;
            delete replayBodyB.stream_options;
            replayBodyB.max_tokens = 10;
            // Keep msg[0] (system with cache_control) but replace all other messages
            replayBodyB.messages = [
              replayBodyB.messages[0],
              { role: "user", content: "What is 2+2?" },
            ];
            const respB = await globalThis.fetch(new URL(_replayUrl!), {
              method: "POST",
              headers: { "Content-Type": "application/json", ..._replayHeaders! },
              body: JSON.stringify(replayBodyB),
            });
            const jsonB = await respB.json() as { usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number } } };
            const rdB = jsonB?.usage?.prompt_tokens_details;
            console.log(JSON.stringify({
              level: 30,
              msg: "dashscope_replay_cache_test",
              test: "B_prefix_only",
              result: (rdB?.cached_tokens ?? 0) > 0 ? "CACHE_HIT" : "CACHE_MISS",
              prompt_tokens: jsonB?.usage?.prompt_tokens ?? "?",
              cached_tokens: rdB?.cached_tokens ?? 0,
              cache_creation: rdB?.cache_creation_input_tokens ?? 0,
              msgCount: 2,
            }));
          } catch (err) {
            console.log(JSON.stringify({ level: 40, msg: "dashscope_replay_test_error", error: String(err) }));
          }
        })();
      }
      if (!_replayBody) {
        _replayBody = serializedBody;
        _replayUrl = String(input);
        try {
          const h: Record<string, string> = {};
          if (init?.headers) {
            if (init.headers instanceof Headers) {
              init.headers.forEach((v, k) => { if (k.toLowerCase() !== "content-length") h[k] = v; });
            } else if (!Array.isArray(init.headers)) {
              for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
                if (k.toLowerCase() !== "content-length") h[k] = v;
              }
            }
          }
          _replayHeaders = h;
        } catch { _replayHeaders = {}; }
      }

      // Compare prefix bytes with saved replay body (detect subtle prefix drift)
      if (_replayBody) {
        const savedPrefix = _replayBody.slice(0, 500);
        const currentPrefix = serializedBody.slice(0, 500);
        const prefixMatch = savedPrefix === currentPrefix;
        if (!prefixMatch) {
          let firstDiffIdx = 0;
          for (let i = 0; i < Math.min(savedPrefix.length, currentPrefix.length); i++) {
            if (savedPrefix[i] !== currentPrefix[i]) { firstDiffIdx = i; break; }
          }
          console.log(JSON.stringify({
            level: 30,
            msg: "dashscope_prefix_drift_detected",
            firstDiffIdx,
            saved: savedPrefix.slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 40),
            current: currentPrefix.slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 40),
          }));
        } else {
          console.log(JSON.stringify({
            level: 20,
            msg: "dashscope_prefix_stable",
            prefixBytesChecked: 500,
          }));
        }
      }

      const resp = await nativeFetch(input, { ...init, body: serializedBody });

      // Capture response headers for load-balancer / server routing info
      try {
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          const kl = k.toLowerCase();
          if (kl.includes("server") || kl.includes("request-id") || kl.includes("dashscope")
              || kl.includes("x-") || kl === "via" || kl === "cf-ray") {
            respHeaders[k] = v;
          }
        });
        if (Object.keys(respHeaders).length > 0) {
          console.log(JSON.stringify({
            level: 20,
            msg: "dashscope_response_headers",
            headers: respHeaders,
          }));
        }
      } catch { /* ignore */ }

      if (!hasStream) return resp;

      const origBody = resp.body;
      if (!origBody) return resp;
      const [forSDK, forDiag] = origBody.tee();

      (async () => {
        try {
          const reader = forDiag.getReader();
          const decoder = new TextDecoder();
          let lastUsage = "";

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
              const rawDetails = parsed?.usage?.prompt_tokens_details;
              console.log(JSON.stringify({
                level: 20,
                msg: "dashscope_response_usage",
                cached_tokens: rawDetails?.cached_tokens ?? "MISSING",
                cache_creation: rawDetails?.cache_creation_input_tokens ?? "MISSING",
                prompt_tokens: parsed?.usage?.prompt_tokens ?? "MISSING",
                raw_prompt_details: rawDetails ?? "NONE",
                usage_keys: parsed?.usage ? Object.keys(parsed.usage).sort() : "NONE",
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
