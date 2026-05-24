import { describe, expect, it } from "vitest";
import { createOpenAIStreamRouteRuntime } from "../src/pipeline/openai-stream-route-runtime.js";

describe("createOpenAIStreamRouteRuntime", () => {
  it("wires heartbeat, components, lifecycle, and after-events", () => {
    const events: unknown[] = [];
    let heartbeatStarted = false;
    const raw = {
      destroyed: false,
      writeHead: () => undefined,
      write: () => true,
      end: () => undefined,
    } as unknown as NodeJS.WritableStream & { destroyed?: boolean; writeHead(statusCode: number, headers: Record<string, string>): unknown };
    const abortController = new AbortController();
    const hardTimeout = setTimeout(() => undefined, 30_000);
    const runtime = createOpenAIStreamRouteRuntime({
      raw,
      headers: { "content-type": "text/event-stream" },
      scope: {
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-1",
      },
      resolvedModelId: "model-1",
      messages: [{ role: "user", content: "hello" }],
      tierConfig: { baseUrl: "http://localhost:8000", backendModel: "backend" },
      write: () => true,
      computePrefixFingerprint: () => "prefix",
      heartbeatIntervalMs: 1000,
      longWaitEventMs: 5000,
      startHeartbeat: () => {
        heartbeatStarted = true;
        return { stop: () => undefined };
      },
      recordSessionEvent: (event) => events.push(event),
      abortRuntime: {
        abortController,
        hardTimeout,
        hardTimeoutMs: 30_000,
      },
      admissionRelease: () => undefined,
      session: { skipToolIdStabilization: false },
      span: { setStatus: () => undefined, end: () => undefined },
      circuitBreakers: { recordFailure: () => undefined, recordSuccess: () => undefined },
      logger: { error: () => undefined, warn: () => undefined },
      extractUpstreamErrorDiagnostics: () => ({
        userMessage: "upstream",
        rawMessage: "upstream",
        isVercelAiSdkError: false,
        isMissingToolResults: false,
      }),
      adapter: { family: "openai" },
      stats: { qwenParserMismatchSuspectCount: 0 },
      recordBlockedDiscovery: () => undefined,
      getBlockedDiscoveryCount: () => 0,
    });

    expect(heartbeatStarted).toBe(true);
    expect(runtime.components.prefixFingerprint).toBe("prefix");
    expect(runtime.components.localLikeBaseUrl).toBe(true);
    expect(runtime.components.streamState.toolNames()).toEqual([]);
    expect(typeof runtime.lifecycle.onEventError).toBe("function");
    expect(typeof runtime.afterEvents).toBe("function");
    expect(events).toHaveLength(0);
    clearTimeout(hardTimeout);
  });
});
