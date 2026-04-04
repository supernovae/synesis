import { describe, it, expect } from "vitest";
import { extractDiagnosticLines } from "../src/mcp/handlers/command-diagnostics.js";

describe("extractDiagnosticLines", () => {
  it("prefers stderr and captures file:line patterns", () => {
    const stderr = `main.go:12:9: undefined: Foo
main.go:15:1: other`;
    const stdout = "ok\n";
    const lines = extractDiagnosticLines(stderr, stdout, 10);
    expect(lines.some((l) => l.includes("main.go:12"))).toBe(true);
  });

  it("pulls test failure lines from stdout", () => {
    const stderr = "";
    const stdout = `--- FAIL: TestFoo (0.00s)
    something_test.go:42: wanted 1 got 2`;
    const lines = extractDiagnosticLines(stderr, stdout, 10);
    expect(lines.some((l) => l.includes("FAIL") || l.includes("wanted"))).toBe(true);
  });
});
