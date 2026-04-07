import { describe, expect, it } from "vitest";
import { suggestScopedVerificationCommand } from "../src/verification/test-scope-selector.js";

describe("test scope selector", () => {
  it("suggests narrower go test scope", () => {
    const out = suggestScopedVerificationCommand("go test ./...", ["internal/api/client.go"]);
    expect(out.isBroad).toBe(true);
    expect(out.suggestedCommand).toContain("./internal/api/...");
  });

  it("returns no suggestion for already scoped command", () => {
    const out = suggestScopedVerificationCommand("go test ./internal/api/...", ["internal/api/client.go"]);
    expect(out.isBroad).toBe(false);
    expect(out.suggestedCommand).toBeNull();
  });
});
