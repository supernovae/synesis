import { describe, expect, it } from "vitest";

import { detectPythonRuntimeDiscoveryLoop } from "../src/governance/python-runtime-discovery-loop.js";

describe("python-runtime-discovery-loop", () => {
  it("detects python runtime probing loops across variants", () => {
    const out = detectPythonRuntimeDiscoveryLoop([
      { toolName: "bash", args: { command: "python -m pytest tests/unit/test_auth.py -q" } },
      { toolName: "bash", args: { command: "python3 -m pytest tests/unit/test_auth.py -q" } },
      { toolName: "bash", args: { command: "uv run pytest tests/unit/test_auth.py -q" } },
    ]);
    expect(out).not.toBeNull();
    expect(out?.detected).toBe(true);
    expect(out?.attempts).toBe(3);
    expect(out?.runtimeVariants).toContain("python");
    expect(out?.runtimeVariants).toContain("python3");
    expect(out?.runtimeVariants).toContain("uv_run");
    expect(out?.guidance).toContain("SYNESIS_PYTHON_RUNTIME_HINT");
  });

  it("does not trigger for single-runtime repeated usage", () => {
    const out = detectPythonRuntimeDiscoveryLoop([
      { toolName: "bash", args: { command: "python3 -m pytest tests/unit/test_auth.py -q" } },
      { toolName: "bash", args: { command: "python3 -m pytest tests/unit/test_auth.py -q" } },
      { toolName: "bash", args: { command: "python3 -m pytest tests/unit/test_auth.py -q" } },
    ]);
    expect(out).toBeNull();
  });

  it("ignores non-python shell commands", () => {
    const out = detectPythonRuntimeDiscoveryLoop([
      { toolName: "bash", args: { command: "go test ./..." } },
      { toolName: "bash", args: { command: "npm test -- src/foo.test.ts" } },
      { toolName: "bash", args: { command: "rg -n auth src" } },
    ]);
    expect(out).toBeNull();
  });
});
