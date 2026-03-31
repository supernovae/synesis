import { describe, it, expect } from "vitest";
import { createPatchIntegrityTool } from "../src/handlers/patch-integrity.js";
import { runAllChecks } from "../src/integrity/core.js";

describe("integrity core", () => {
  it("detects hardcoded secrets (api_key value must be 8+ alnum per regex)", () => {
    const report = runAllChecks('api_key = "supersecretvalue123"', "python");
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "secret")).toBe(true);
  });

  it("flags network egress for Python import requests", () => {
    const report = runAllChecks("import requests\n", "python");
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "network")).toBe(true);
  });

  it("flags network egress for bash curl", () => {
    const report = runAllChecks("curl https://example.com\n", "bash");
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "network")).toBe(true);
  });

  it("flags dangerous bash commands (rm -rf)", () => {
    const report = runAllChecks("rm -rf /\n", "bash");
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "dangerous")).toBe(true);
  });

  it("flags path traversal in patch_ops", () => {
    const report = runAllChecks("", "python", [{ path: "../etc/passwd", op: "modify" }]);
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.evidence.includes("traversal"))).toBe(true);
  });

  it("flags workspace boundary violation", () => {
    const report = runAllChecks(
      "print(1)",
      "python",
      [],
      ["/etc/hosts"],
      "/workspace",
    );
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "workspace")).toBe(true);
  });

  it("flags size limit exceeded", () => {
    const huge = "a".repeat(100_001);
    const report = runAllChecks(huge, "python");
    expect(report.passed).toBe(false);
    expect(report.failures.some((f) => f.category === "size")).toBe(true);
  });

  it("clean code passes all checks", () => {
    const report = runAllChecks('print("hello")\n', "python");
    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("aggregates multiple failures", () => {
    const code = 'import requests\napi_key = "longsecretvaluehere"\n';
    const report = runAllChecks(code, "python");
    expect(report.passed).toBe(false);
    const cats = new Set(report.failures.map((f) => f.category));
    expect(cats.has("network")).toBe(true);
    expect(cats.has("secret")).toBe(true);
  });
});

describe("createPatchIntegrityTool", () => {
  const tool = createPatchIntegrityTool();

  it("returns serializable report from handler", async () => {
    const out = (await tool.handler({
      code: "rm -rf /\n",
      language: "bash",
    })) as Record<string, unknown>;

    expect(out.passed).toBe(false);
    expect(Array.isArray(out.failures)).toBe(true);
    const failures = out.failures as { category: string }[];
    expect(failures.some((f) => f.category === "dangerous")).toBe(true);
  });
});
