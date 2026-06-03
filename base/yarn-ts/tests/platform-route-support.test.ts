import { describe, expect, it } from "vitest";

import { authRejectionLogFields } from "../src/routes/platform-route-support.js";

describe("platform route auth diagnostics", () => {
  it("classifies double Bearer PAT headers without exposing token material", () => {
    const fields = authRejectionLogFields(
      new Error("Malformed Authorization header: configure API key as the raw syn- token"),
      "Bearer Bearer syn-secret-value",
      "/v1/chat/completions",
    );

    expect(fields).toMatchObject({
      endpoint: "/v1/chat/completions",
      authHeaderKind: "double_bearer_syn_pat",
    });
    expect(JSON.stringify(fields)).not.toContain("syn-secret-value");
  });

  it("classifies quoted PAT headers without exposing token material", () => {
    const fields = authRejectionLogFields(
      new Error("Malformed Authorization header: token value is quoted"),
      'Bearer "syn-secret-value"',
      "/v1/chat/completions",
    );

    expect(fields).toMatchObject({
      endpoint: "/v1/chat/completions",
      authHeaderKind: "quoted_syn_pat",
    });
    expect(JSON.stringify(fields)).not.toContain("syn-secret-value");
  });
});
