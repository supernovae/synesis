import { describe, expect, it } from "vitest";
import { redactOperationalError, summarizeOperationalError } from "../src/security/error-redaction.js";

describe("operational error redaction", () => {
  it("redacts provider-returned key fragments while preserving useful error context", () => {
    const detail = 'LLM HTTP 400: {"code":"invalid-argument","error":"Incorrect API key provided: xa***ME."}';

    const redacted = redactOperationalError(detail);

    expect(redacted).toContain("LLM HTTP 400");
    expect(redacted).toContain("Incorrect API key provided");
    expect(redacted).not.toContain("xa***ME");
    expect(redacted).toContain("[REDACTED]");
  });

  it("summarizes authentication failures for trace metadata", () => {
    const detail = 'LLM HTTP 400: {"code":"invalid-argument","error":"Incorrect API key provided: xa***ME."}';

    expect(summarizeOperationalError(detail)).toBe("LLM provider authentication failed");
  });
});
