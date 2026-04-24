import { describe, expect, it } from "vitest";

import { detectVerificationRerunLoop } from "../src/governance/verification-rerun-loop.js";

describe("verification-rerun-loop", () => {
  it("detects repeated shell verification reruns", () => {
    const out = detectVerificationRerunLoop([
      { toolName: "bash", args: { command: "go test ./pkg/worker" } },
      { toolName: "bash", args: { command: "go test ./pkg/worker 2>&1 | cat" } },
      { toolName: "bash", args: { command: "go test ./pkg/worker > /tmp/out.txt 2>&1; tail -80 /tmp/out.txt" } },
    ]);
    expect(out).not.toBeNull();
    expect(out?.detected).toBe(true);
    expect(out?.repeatCount).toBe(3);
    expect(out?.fingerprint).toBe("shell:go test ./pkg/worker");
    expect(out?.guidance).toContain("SYNESIS_VERIFICATION_RERUN_HINT");
  });

  it("detects repeated run_test preset reruns", () => {
    const out = detectVerificationRerunLoop([
      { toolName: "run_test", args: { preset: "python.pytest.quick" } },
      { toolName: "run_test", args: { preset: "python.pytest.quick" } },
    ]);
    expect(out).not.toBeNull();
    expect(out?.fingerprint).toBe("run_test:preset=python.pytest.quick");
    expect(out?.repeatCount).toBe(2);
  });

  it("does not detect when verification commands are different", () => {
    const out = detectVerificationRerunLoop([
      { toolName: "bash", args: { command: "go test ./pkg/a" } },
      { toolName: "bash", args: { command: "go test ./pkg/b" } },
      { toolName: "bash", args: { command: "go test ./pkg/c" } },
    ]);
    expect(out).toBeNull();
  });

  it("ignores non-verification shell commands", () => {
    const out = detectVerificationRerunLoop([
      { toolName: "bash", args: { command: "ls -la" } },
      { toolName: "bash", args: { command: "ls -la" } },
      { toolName: "bash", args: { command: "pwd" } },
    ]);
    expect(out).toBeNull();
  });
});
