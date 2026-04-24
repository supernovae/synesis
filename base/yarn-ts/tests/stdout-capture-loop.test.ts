import { describe, expect, it } from "vitest";

import { detectStdoutCaptureLoop } from "../src/governance/stdout-capture-loop.js";

describe("stdout-capture-loop", () => {
  it("detects reruns with different capture wrappers", () => {
    const out = detectStdoutCaptureLoop([
      { toolName: "bash", args: { command: "go test ./pkg/worker" } },
      { toolName: "bash", args: { command: "go test ./pkg/worker 2>&1 | cat" } },
      { toolName: "bash", args: { command: "go test ./pkg/worker > /tmp/out.txt 2>&1; tail -80 /tmp/out.txt" } },
    ]);
    expect(out).not.toBeNull();
    expect(out?.detected).toBe(true);
    expect(out?.baseCommand).toBe("go test ./pkg/worker");
    expect(out?.retryCount).toBe(3);
    expect(out?.guidance).toContain("SYNESIS_OUTPUT_CAPTURE_HINT");
    expect(out?.guidance).toContain("always capture once to a stable file");
  });

  it("detects newer wrapper variants (tee+tail, sed/rg extraction)", () => {
    const out = detectStdoutCaptureLoop([
      { toolName: "bash", args: { command: "pytest -q tests/unit/test_auth.py" } },
      { toolName: "bash", args: { command: "pytest -q tests/unit/test_auth.py 2>&1 | tee /tmp/py.txt | tail -100" } },
      { toolName: "bash", args: { command: "pytest -q tests/unit/test_auth.py > /tmp/py.txt 2>&1; sed -n '1,120p' /tmp/py.txt" } },
      { toolName: "bash", args: { command: "pytest -q tests/unit/test_auth.py > /tmp/py.txt 2>&1; rg -n 'error|failed' /tmp/py.txt" } },
    ]);
    expect(out).not.toBeNull();
    expect(out?.baseCommand).toBe("pytest -q tests/unit/test_auth.py");
    expect(out?.retryCount).toBeGreaterThanOrEqual(3);
    expect(out?.guidance).toContain("rg -n \"error|fail|panic|exception|traceback\"");
  });

  it("does not fire when commands are different", () => {
    const out = detectStdoutCaptureLoop([
      { toolName: "bash", args: { command: "go test ./pkg/a" } },
      { toolName: "bash", args: { command: "go test ./pkg/b" } },
      { toolName: "bash", args: { command: "go test ./pkg/c" } },
    ]);
    expect(out).toBeNull();
  });
});
