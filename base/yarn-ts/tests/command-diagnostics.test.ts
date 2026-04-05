import { describe, it, expect } from "vitest";
import { extractDiagnosticLines, extractStructuredErrors } from "../src/mcp/handlers/command-diagnostics.js";

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

  it("extracts structured tsc errors", () => {
    const stderr = "src/app.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.";
    const rows = extractStructuredErrors(stderr, "", 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].kind).toBe("compile");
    expect(rows[0].file).toBe("src/app.ts");
    expect(rows[0].line).toBe(12);
  });

  it("extracts structured go test errors", () => {
    const stdout = "--- FAIL: TestFoo (0.00s)\ninternal/users/service_test.go:42: expected 1 got 2";
    const rows = extractStructuredErrors("", stdout, 10);
    expect(rows.some((r) => r.kind === "test" && r.file?.includes("service_test.go"))).toBe(true);
  });

  it("extracts structured python traceback errors", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/repo/app/main.py", line 27, in <module>',
      "    run()",
      "ValueError: invalid state transition",
    ].join("\n");
    const rows = extractStructuredErrors(stderr, "", 10);
    expect(rows.some((r) => r.kind === "runtime" && r.file?.includes("main.py") && r.line === 27)).toBe(true);
  });

  it("extracts structured pytest assertion failures", () => {
    const stdout = "tests/test_service.py:41: AssertionError: expected 200 got 500";
    const rows = extractStructuredErrors("", stdout, 10);
    expect(rows.some((r) => r.kind === "test" && r.file?.includes("test_service.py") && r.line === 41)).toBe(true);
  });

  it("extracts structured rust errors", () => {
    const stderr = [
      "error[E0432]: unresolved import `crate::missing`",
      " --> src/main.rs:12:5",
    ].join("\n");
    const rows = extractStructuredErrors(stderr, "", 10);
    expect(rows.some((r) => r.kind === "compile" && r.file === "src/main.rs" && r.line === 12 && r.column === 5)).toBe(true);
  });
});
