import { describe, expect, it } from "vitest";
import { ChatCompletionRequestSchema } from "../src/api-schemas.js";
import { resolvePlannerSessionKey } from "../src/routes/route-support.js";

describe("resolvePlannerSessionKey", () => {
  it("uses authenticated principal-scoped key when conversation_id is present", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      conversation_id: "conv-123",
    });
    const resolved = resolvePlannerSessionKey(body, "req-1", {
      authMethod: "pat",
      userId: "user-1",
      orgId: "org-1",
    });
    expect(resolved.source).toBe("conversation_id");
    expect(resolved.sessionKey).toBe("conversation:principal:org-1:user-1:conv-123");
  });

  it("isolates identical conversation ids across authenticated users", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      conversation_id: "conv-123",
    });
    const alice = resolvePlannerSessionKey(body, "req-1", {
      authMethod: "pat",
      userId: "alice",
      orgId: "org-1",
    });
    const bob = resolvePlannerSessionKey(body, "req-2", {
      authMethod: "pat",
      userId: "bob",
      orgId: "org-1",
    });
    expect(alice.sessionKey).not.toBe(bob.sessionKey);
  });

  it("request-scopes anonymous conversation ids because no stable server identity exists", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      conversation_id: "conv-123",
    });
    const a = resolvePlannerSessionKey(body, "req-a", {
      authMethod: "anonymous",
      userId: "anonymous",
    });
    const b = resolvePlannerSessionKey(body, "req-b", {
      authMethod: "anonymous",
      userId: "anonymous",
    });
    expect(a.source).toBe("conversation_id");
    expect(a.sessionKey).toBe("conversation:anonymous:req-a:conv-123");
    expect(b.sessionKey).toBe("conversation:anonymous:req-b:conv-123");
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });

  it("uses per-request ephemeral key when conversation_id is missing", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      user: "user@example.com",
    });
    const identity = { authMethod: "pat" as const, userId: "user-1", orgId: "org-1" };
    const a = resolvePlannerSessionKey(body, "req-a", identity);
    const b = resolvePlannerSessionKey(body, "req-b", identity);
    expect(a.source).toBe("ephemeral_request");
    expect(a.sessionKey).toBe("ephemeral:req-a");
    expect(b.sessionKey).toBe("ephemeral:req-b");
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });
});
