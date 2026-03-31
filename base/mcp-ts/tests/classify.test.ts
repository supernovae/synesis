import { describe, it, expect, vi, afterEach } from "vitest";
import { createClassifyTool } from "../src/handlers/classify.js";
import type { McpConfig } from "../src/config.js";

const config: McpConfig = {
  PORT: 8100,
  HOST: "0.0.0.0",
  LOG_LEVEL: "info",
  SYNESIS_PLANNER_URL: "http://classify-planner:9090/",
  SYNESIS_CRITIC_URL: "http://critic/v1",
  SYNESIS_CRITIC_MODEL: "synesis-critic",
  SYNESIS_INTERNAL_SERVICE_TOKEN: "secret-token",
};

describe("createClassifyTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to planner /v1/chat/completions with classify-only header and body options", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://classify-planner:9090/v1/chat/completions");

      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Synesis-MCP"]).toBe("classify-only");
      expect(headers.Authorization).toBe("Bearer secret-token");

      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("Synesis");
      expect(body.stream).toBe(false);
      expect(body.max_tokens).toBe(1);
      expect(body.messages).toEqual([{ role: "user", content: "do the thing" }]);

      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createClassifyTool(config);
    await tool.handler({ task: "do the thing" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
