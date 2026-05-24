import { describe, expect, it } from "vitest";
import { OpenAIChatPipeline } from "../src/pipeline/openai-chat-pipeline.js";
import type { AuthUser } from "../src/auth.js";

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: "auth-user-1",
    orgId: "org-1",
    tenantIds: [],
    role: "user",
    authMethod: "pat",
    tokenScopes: ["coder:default"],
    ...overrides,
  };
}

describe("OpenAIChatPipeline ingress", () => {
  it("normalizes and parses OpenAI chat requests into canonical pipeline state", () => {
    const pipeline = new OpenAIChatPipeline();
    const result = pipeline.prepareIngress({
      body: {
        model: "synesis-core",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        metadata: {
          synesis_client: "OpenCode",
          session_id: "session-from-meta",
          synesis_mode: "compat",
        },
      },
      headers: { "user-agent": "ignored" },
      config: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.model).toBe("synesis-core");
    expect(result.canonicalRequest).toMatchObject({
      protocol: "openai",
      model: "synesis-core",
      stream: true,
    });
    expect(result.modeResolution).toMatchObject({ mode: "compat", source: "body", valid: true });
    expect(result.clientKind).toBe("opencode");
    expect(result.conversationId).toBe("session-from-meta");
  });

  it("preserves header precedence for mode, client, and conversation identity", () => {
    const pipeline = new OpenAIChatPipeline();
    const result = pipeline.prepareIngress({
      body: {
        model: "synesis-core",
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          synesis_client: "metadata-client",
          session_id: "metadata-session",
          synesis_mode: "optimized",
        },
      },
      headers: {
        "x-synesis-mode": "raw",
        "x-synesis-client": "header-client",
        "x-synesis-conversation-id": "header-session",
      },
      config: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modeResolution).toMatchObject({ mode: "raw", source: "header", explicit: true });
    expect(result.clientKind).toBe("header-client");
    expect(result.conversationId).toBe("metadata-session");
  });

  it("returns the documented OpenAI-compatible validation envelope", () => {
    const pipeline = new OpenAIChatPipeline();
    const result = pipeline.prepareIngress({
      body: { messages: [] },
      headers: {},
      config: {},
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      body: {
        error: {
          type: "invalid_request_error",
        },
      },
    });
    if (!result.ok) {
      expect(result.body.error.message).toContain("Invalid request:");
    }
  });

  it("resolves authenticated session identity without trusting request.user for keying", () => {
    const pipeline = new OpenAIChatPipeline();
    const result = pipeline.prepareIngress({
      body: {
        model: "synesis-core",
        user: "Display.Name@example.com",
        messages: [{ role: "user", content: "hello" }],
        metadata: { session_id: "session-1" },
      },
      headers: { "user-agent": "codex-cli" },
      config: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identity = pipeline.resolveIdentity(result, authUser());

    expect(identity.identity).toEqual({
      userId: "auth-user-1",
      orgId: "org-1",
      conversationId: "session-1",
      clientKind: "codex-cli",
      displayName: "display.name@example.com",
    });
  });
});
