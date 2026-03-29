import { describe, expect, it } from "vitest";
import { ChatCompletionRequestSchema } from "../src/api-schemas.js";
import { resolvePlannerSessionKey } from "../src/app.js";

describe("resolvePlannerSessionKey", () => {
  it("uses conversation-scoped key when conversation_id is present", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      conversation_id: "conv-123",
    });
    const resolved = resolvePlannerSessionKey(body, "req-1");
    expect(resolved.source).toBe("conversation_id");
    expect(resolved.sessionKey).toBe("conversation:conv-123");
  });

  it("uses per-request ephemeral key when conversation_id is missing", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "Synesis",
      messages: [{ role: "user", content: "hello" }],
      user: "user@example.com",
    });
    const a = resolvePlannerSessionKey(body, "req-a");
    const b = resolvePlannerSessionKey(body, "req-b");
    expect(a.source).toBe("ephemeral_request");
    expect(a.sessionKey).toBe("ephemeral:req-a");
    expect(b.sessionKey).toBe("ephemeral:req-b");
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });
});
