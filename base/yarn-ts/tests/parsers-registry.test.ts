import { describe, expect, it } from "vitest";
import { tryStructuredParse } from "../src/validation/parsers/index.js";

describe("tryStructuredParse — format detection + routing", () => {
  it("detects and routes SARIF JSON", () => {
    const sarif = JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "eslint" } }, results: [{ ruleId: "semi", message: { text: "Missing semicolon." } }] }]
    });
    const result = tryStructuredParse(sarif, "generic", 50);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("sarif");
    expect(result!.findings).toHaveLength(1);
  });

  it("detects and routes ESLint JSON (non-SARIF)", () => {
    const eslint = JSON.stringify([
      { filePath: "src/a.ts", messages: [{ ruleId: "no-var", severity: 2, message: "Use let/const", line: 1, column: 1 }] }
    ]);
    const result = tryStructuredParse(eslint, "eslint", 50);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("json");
    expect(result!.findings[0].family).toBe("eslint");
  });

  it("detects and routes JUnit XML", () => {
    const junit = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="tests" tests="1" failures="1">
    <testcase classname="tests.test_a" name="test_fail">
      <failure message="assert False">assert False</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const result = tryStructuredParse(junit, "pytest", 50);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("junit");
    expect(result!.findings).toHaveLength(1);
  });

  it("detects and routes Checkstyle XML", () => {
    const checkstyle = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="4.3">
  <file name="src/index.ts">
    <error line="10" severity="error" message="oops" source="rule"/>
  </file>
</checkstyle>`;
    const result = tryStructuredParse(checkstyle, "eslint", 50);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("checkstyle");
    expect(result!.findings).toHaveLength(1);
  });

  it("detects cargo newline-delimited JSON", () => {
    const cargo = [
      JSON.stringify({ reason: "compiler-message", message: { level: "error", message: "mismatched types", code: { code: "E0308" }, spans: [{ file_name: "src/main.rs", line_start: 5, column_start: 1 }] } }),
      JSON.stringify({ reason: "build-finished", success: false })
    ].join("\n");
    const result = tryStructuredParse(cargo, "cargo", 50);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("json");
    expect(result!.findings[0].family).toBe("cargo");
  });

  it("returns null for plain text (line-regex territory)", () => {
    const text = "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(tryStructuredParse(text, "typescript", 50)).toBeNull();
  });

  it("returns null for unrecognized JSON schema", () => {
    expect(tryStructuredParse('{"foo": "bar"}', "generic", 50)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(tryStructuredParse("", "generic", 50)).toBeNull();
  });

  it("prefers SARIF over generic JSON when both could match", () => {
    const sarif = JSON.stringify({
      runs: [{ tool: { driver: { name: "semgrep" } }, results: [{ ruleId: "r1", message: { text: "issue" } }] }]
    });
    const result = tryStructuredParse(sarif, "generic", 50);
    expect(result!.format).toBe("sarif");
  });
});
