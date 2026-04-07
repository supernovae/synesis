import { describe, expect, it } from "vitest";
import { evaluateCliProjectAcceptance } from "../src/acceptance/cli-project-harness.js";

describe("cli project acceptance harness", () => {
  it("passes when required CLI skeleton exists", () => {
    const out = evaluateCliProjectAcceptance({
      repoTree: [
        "cmd/synesis/main.go",
        "README.md",
        "Makefile",
        "Containerfile",
        ".golangci.yml",
        "internal/api/client.go",
      ],
      promptText: "Build CLI with /v1/chat/completions and session support",
      verificationSummary: "all checks pass",
    });
    expect(out.passed).toBe(true);
    expect(out.score).toBeGreaterThanOrEqual(0.8);
  });

  it("fails when required files are missing", () => {
    const out = evaluateCliProjectAcceptance({
      repoTree: ["main.go"],
      promptText: "Build CLI",
    });
    expect(out.passed).toBe(false);
    expect(out.missingRequired.length).toBeGreaterThan(0);
  });
});
