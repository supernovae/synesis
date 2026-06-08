import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setFgaCheckOverride } from "../src/auth/openfga-client.js";

beforeAll(() => {
  setFgaCheckOverride(() => ({ allowed: true }));
});
afterAll(() => {
  setFgaCheckOverride(null);
});

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    ...overrides
  });
}

describe("API contract", () => {
  it("lists Synesis tier model ids", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/models"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = (body.data ?? []).map((m: { id?: string }) => String(m.id ?? ""));
    expect(ids).toContain("Synesis Auto");
    expect(ids).toContain("Synesis Pulse");
    expect(ids).toContain("Synesis Core");
    expect(ids).toContain("Synesis Horizon");
    await app.close();
  });

  it("normalizes response model id for selected tier", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "synesis horizon",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.model).toBe("Synesis Horizon");
    await app.close();
  });

  it("reports authz engine on health", async () => {
    const token = "test-internal-token";
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: token }));
    const response = await app.inject({
      method: "GET",
      url: "/health/detailed",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.auth?.engine).toBe("openfga");
    expect(body.auth?.policyStats).toBeTruthy();
    expect(body.auth?.openfga).toBeTruthy();
    expect(body.auth?.openfga?.apiUrlConfigured).toBe(false);
    await app.close();
  });

  it("returns minimal liveness on /health without auth", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.auth).toBeUndefined();
    expect(body.llm).toBeUndefined();
    await app.close();
  });

  it("exposes readiness endpoint", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/health/readiness"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.checks?.llm).toBeTruthy();
    expect(body.checks?.redis).toBeTruthy();
    await app.close();
  });

  it("requires internal token on metrics", async () => {
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "metrics-token" }));
    const response = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });

  it("returns metrics for internal callers", async () => {
    const token = "metrics-token";
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: token }));
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# HELP");
    await app.close();
  });

  it("returns authz recent events on dedicated health endpoint", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "debug-token",
        SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER: "true"
      })
    );
    setFgaCheckOverride(() => ({ allowed: false, resolution: "test_deny" }));
    try {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test-token" },
        payload: {
          model: "Synesis",
          messages: [{ role: "user", content: "hello planner" }],
          stream: false
        }
      });
      const response = await app.inject({
        method: "GET",
        url: "/health/authz-events",
        headers: { authorization: "Bearer debug-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.auth?.engine).toBe("openfga");
      expect(Array.isArray(body.auth?.recentEvents)).toBe(true);
      expect((body.auth?.recentEvents ?? []).length).toBeGreaterThanOrEqual(1);
      expect(body.auth?.recentEvents?.slice(-1)?.[0]?.allow).toBe(false);
    } finally {
      setFgaCheckOverride(() => ({ allowed: true }));
      await app.close();
    }
  });

  it("returns failure diagnostics on dedicated health endpoint", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "debug-token"
      })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/failures",
        headers: { authorization: "Bearer debug-token" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.failures)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns dependency diagnostics endpoint with service token", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "debug-token"
      })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/deps",
        headers: { authorization: "Bearer debug-token" }
      });
      expect([200, 503]).toContain(response.statusCode);
      const body = response.json();
      expect(body.service).toBe("planner-ts");
      expect(Array.isArray(body.checks)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns OpenAI-like non-stream response", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("chat.completion");
    expect(typeof body.system_fingerprint).toBe("string");
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0]?.message?.role).toBe("assistant");
    expect(body.choices[0]?.logprobs).toBeNull();
    expect(body.usage).toBeTruthy();
    expect(typeof body.authz_trace_id).toBe("string");
    expect(body.authz_trace_id.length).toBeGreaterThan(10);
    expect(response.headers["x-synesis-authz-engine"]).toBe("openfga");
    expect(String(response.headers["x-synesis-authz-rules"] ?? "")).toContain("scope_model_ok");
    const responseTraceId = String(response.headers["x-synesis-authz-trace-id"] ?? "");
    expect(responseTraceId.length).toBeGreaterThan(10);
    expect(body.authz_trace_id).toBe(responseTraceId);
    await app.close();
  });

  it("supports json_object response_format for non-stream requests", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_LLM_ENABLED: "false",
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "return a JSON object with a status field" }],
        stream: false,
        response_format: { type: "json_object" },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const content = String(body.choices?.[0]?.message?.content ?? "");
    expect(() => JSON.parse(content)).not.toThrow();
    await app.close();
  });

  it("supports json_schema response_format and common chat client parameters", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_LLM_ENABLED: "false",
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [
          { role: "developer", content: "Keep output compact." },
          {
            role: "user",
            content: [
              { type: "text", text: "Return a JSON object with an answer field." },
            ],
          },
        ],
        stream: false,
        max_completion_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        frequency_penalty: 0,
        presence_penalty: 0,
        stop: ["END"],
        seed: 7,
        logprobs: false,
        n: 1,
        tool_choice: "none",
        parallel_tool_calls: false,
        extra_body: { top_k: 20, enable_prefix_caching: true },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "writer_answer",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const content = String(body.choices?.[0]?.message?.content ?? "");
    expect(() => JSON.parse(content)).not.toThrow();
    await app.close();
  });

  it("rejects unknown extra_body provider attributes", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false,
        extra_body: { custom_provider_option: "x" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error?.type).toBe("invalid_request_error");
    await app.close();
  });

  it("uses the latest user message for task framing", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_LLM_ENABLED: "false"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis Auto",
        stream: false,
        messages: [
          { role: "user", content: "old prompt should not be reused" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "new follow up prompt should be used" }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const content = String(body.choices?.[0]?.message?.content ?? "");
    expect(content).toContain("new follow up prompt should be used");
    expect(content).not.toContain("old prompt should not be reused");
    await app.close();
  });

  it("enforces bearer auth when configured", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error?.type).toBe("authentication_error");
    await app.close();
  });

  it("rejects opaque bearer by default before caller-provided scopes can affect policy", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer non-pat-bearer-token",
        "x-synesis-token-scopes": "coder:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error?.type).toBe("authentication_error");
    await app.close();
  });

  it("increments authz policy stats after denied request", async () => {
    const token = "test-internal-token";
    setFgaCheckOverride(() => ({ allowed: false, resolution: "test_deny" }));
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: token,
        SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER: "true",
      })
    );
    try {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer non-pat-bearer-token",
          "x-synesis-token-scopes": "coder:readonly"
        },
        payload: {
          model: "Synesis",
          messages: [{ role: "user", content: "hello planner" }],
          stream: false
        }
      });
      const health = await app.inject({
        method: "GET",
        url: "/health/detailed",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(health.statusCode).toBe(200);
      const body = health.json();
      expect(Number(body.auth?.policyStats?.evaluations ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(body.auth?.policyStats?.rejectedCount ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(body.auth?.policyStats?.recentEvents)).toBe(true);
      const lastEvent = body.auth?.policyStats?.recentEvents?.slice(-1)?.[0];
      expect(lastEvent?.allow).toBe(false);
      expect(String(lastEvent?.traceId ?? "").length).toBeGreaterThan(10);
    } finally {
      setFgaCheckOverride(() => ({ allowed: true }));
      await app.close();
    }
  });

  it("rejects untrusted forwarded identity headers in strict mode", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer someone-else",
        "x-openwebui-user-id": "spoofed-user"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error?.type).toBe("permission_error");
    await app.close();
  });

  it("allows trusted forwarded identity service token", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer internal-service-token",
        "x-openwebui-user-id": "trusted-user",
        "x-synesis-token-scopes": "model:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("records trusted forwarded identity in authz event lineage", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer internal-service-token",
        "x-openwebui-user-id": "trusted-user",
        "x-synesis-token-scopes": "model:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "lineage check" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const traceId = String(response.headers["x-synesis-authz-trace-id"] ?? "");
    expect(traceId.length).toBeGreaterThan(10);
    expect(body.authz_trace_id).toBe(traceId);

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/health/authz-events",
      headers: { authorization: "Bearer internal-service-token" }
    });
    expect(eventsResponse.statusCode).toBe(200);
    const eventsBody = eventsResponse.json();
    const matching = (eventsBody.auth?.recentEvents ?? []).find(
      (event: Record<string, unknown>) => String(event.traceId ?? "") === traceId
    );
    expect(matching).toBeTruthy();
    expect(matching?.allow).toBe(true);
    expect(String(matching?.userId ?? "")).toBe("trusted-user");
    await app.close();
  });

  it("returns 403 when openfga denies the check", async () => {
    const app = buildApp(makeConfig());
    setFgaCheckOverride(() => ({ allowed: false, resolution: "test_deny" }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "Synesis",
          messages: [{ role: "user", content: "hello planner" }],
          stream: false
        }
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error?.message).toContain("denied");
      expect(body.error?.type).toBe("permission_error");
    } finally {
      setFgaCheckOverride(() => ({ allowed: true }));
      await app.close();
    }
  });

  it("includes cached_prompt_tokens in usage (non-stream)", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "prefix cache telemetry check" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.usage).toBeTruthy();
    expect(typeof body.usage.prompt_tokens).toBe("number");
    expect(typeof body.usage.completion_tokens).toBe("number");
    expect(typeof body.usage.total_tokens).toBe("number");
    expect(typeof body.usage.cached_prompt_tokens).toBe("number");
    await app.close();
  });

  it("includes cached_prompt_tokens in SSE final chunk usage", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "stream usage check" }],
        stream: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"cached_prompt_tokens"');
    await app.close();
  });

  it("reports prefix cache mode and redis status on health", async () => {
    const token = "test-internal-token";
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: token }));
    const response = await app.inject({
      method: "GET",
      url: "/health/detailed",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.llm?.prefixCacheMode).toBe("auto");
    expect(body.redis).toBeTruthy();
    expect(body.redis?.configured).toBe(false);
    expect(body.session?.storeBackend).toBe("memory");
    await app.close();
  });

  it("purges memory by conversation id", async () => {
    const app = buildApp(makeConfig());
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello" }],
        conversation_id: "purge-test-conv",
        stream: false
      }
    });
    const purge = await app.inject({
      method: "DELETE",
      url: "/v1/memory/purge-test-conv"
    });
    expect(purge.statusCode).toBe(200);
    const body = purge.json();
    expect(body.deleted).toBe(true);
    expect(body.conversation_id).toBe("purge-test-conv");
    expect(typeof body.authz_trace_id).toBe("string");
    await app.close();
  });

  it("returns deleted:false for non-existent conversation purge", async () => {
    const app = buildApp(makeConfig());
    const purge = await app.inject({
      method: "DELETE",
      url: "/v1/memory/nonexistent-conv"
    });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().deleted).toBe(false);
    await app.close();
  });

  it("enforces auth on purge endpoint", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    const purge = await app.inject({
      method: "DELETE",
      url: "/v1/memory/test-conv"
    });
    expect(purge.statusCode).toBe(401);
    await app.close();
  });

  it("emits OpenAI-compatible SSE completion chunks", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const payload = response.body;
    expect(payload).not.toContain('"reasoning_content"');
    expect(payload).not.toContain('"event"');
    expect(payload).toContain('"chat.completion.chunk"');
    expect(payload).toContain('"role":"assistant"');
    expect(payload).toContain("[DONE]");
    await app.close();
  });

  it("omits final usage chunk payload when stream_options.include_usage=false", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: true,
        stream_options: { include_usage: false },
      },
    });
    expect(response.statusCode).toBe(200);
    const dataFrames = response.body
      .split("\n\n")
      .filter((chunk: string) => chunk.startsWith("data: "))
      .map((chunk: string) => chunk.slice(6).trim())
      .filter((chunk: string) => chunk !== "[DONE]");
    const parsed = dataFrames.map((chunk: string) => JSON.parse(chunk));
    const finalChunk = [...parsed].reverse().find((payload: Record<string, unknown>) => {
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      return choices[0]?.finish_reason === "stop";
    });
    expect(finalChunk).toBeTruthy();
    expect(finalChunk?.usage).toBeUndefined();
    await app.close();
  });

  it("returns 429 when user request rate exceeds configured window", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS: "1",
      SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS: "60000",
    }));
    const payload = {
      model: "Synesis",
      messages: [{ role: "user", content: "hello planner" }],
      stream: false,
    };
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeTruthy();
    await app.close();
  });

  it("returns 503 when streaming admission is saturated", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT: "0",
      SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX: "0",
      SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS: "1",
    }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: true
      }
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBeTruthy();
    await app.close();
  });
});
