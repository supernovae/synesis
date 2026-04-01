import { describe, expect, it } from "vitest";
import {
  normalizeValidationOutput,
  normalizeValidationOutputWithTierC,
} from "../src/validation/normalizer.js";

describe("normalizeValidationOutput", () => {
  /* ── Tier B: line-regex parsers ─────────────────────────────── */

  it("normalizes TypeScript compiler output with enrichment", () => {
    const raw = "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const out = normalizeValidationOutput({
      toolName: "tsc",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("typescript");
    expect(out.outputFormat).toBe("text");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].file).toBe("src/foo.ts");
    expect(out.findings[0].line).toBe(12);
    expect(out.findings[0].column).toBe(5);
    expect(out.findings[0].errorFamily).toBe("type_mismatch");
    expect(out.findings[0].likelyRootCause).toContain("does not match");
    expect(out.findings[0].suggestedNextAction).toContain("src/foo.ts");
    expect(out.findings[0].rawFingerprint).toHaveLength(12);
    expect(out.summary).toContain("Root cause:");
    expect(out.summary).toContain("Action:");
  });

  it("normalizes ruff output with enrichment", () => {
    const raw = "app/main.py:8:1: F401 `os` imported but unused";
    const out = normalizeValidationOutput({
      toolName: "ruff",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("ruff");
    expect(out.findings[0].ruleId).toBe("F401");
    expect(out.findings[0].errorFamily).toBe("unused_import");
    expect(out.findings[0].likelyRootCause).toContain("never used");
    expect(out.findings[0].suggestedNextAction).toContain("Remove");
  });

  it("normalizes ESLint text output with enrichment", () => {
    const raw = "/project/src/index.ts:10:5: error 'x' is defined but never used  no-unused-vars";
    const out = normalizeValidationOutput({
      toolName: "eslint",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 300
    });
    expect(out.family).toBe("eslint");
    expect(out.findings[0].errorFamily).toBe("unused_symbol");
    expect(out.findings[0].likelyRootCause).toContain("never referenced");
    expect(out.findings[0].suggestedNextAction).toContain("Remove");
  });

  it("normalizes pytest assertion lines with enrichment", () => {
    const raw = [
      "________________________ test_add ________________________",
      "E       assert 2 == 3"
    ].join("\n");
    const out = normalizeValidationOutput({
      toolName: "pytest",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("pytest");
    expect(out.findings[0].message).toContain("test_add");
    expect(out.findings[0].errorFamily).toBe("assertion_failure");
    expect(out.findings[0].likelyRootCause).toContain("False");
  });

  it("normalizes mypy text output with enrichment", () => {
    const raw = "app/models.py:42: error: Incompatible types in assignment [assignment]";
    const out = normalizeValidationOutput({
      toolName: "mypy",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("mypy");
    expect(out.findings[0].errorFamily).toBe("type_mismatch");
    expect(out.findings[0].likelyRootCause).toContain("incompatible");
    expect(out.findings[0].suggestedNextAction).toContain("app/models.py");
  });

  /* ── Terraform parser ────────────────────────────────────────── */

  it("normalizes terraform validate text output", () => {
    const raw = [
      "Error: Reference to undeclared input variable",
      "",
      '  on main.tf line 15, in resource "aws_instance" "web":',
      '  15:   ami = var.ami_id',
      "",
      'An input variable with the name "ami_id" has not been declared.'
    ].join("\n");
    const out = normalizeValidationOutput({
      toolName: "terraform_validate",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 500
    });
    expect(out.family).toBe("terraform");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].file).toBe("main.tf");
    expect(out.findings[0].line).toBe(15);
    expect(out.findings[0].message).toContain("undeclared input variable");
    expect(out.findings[0].errorFamily).toBe("undeclared_variable");
    expect(out.findings[0].likelyRootCause).toContain("not declared");
    expect(out.findings[0].suggestedNextAction).toContain("main.tf");
    expect(out.findings[0].suggestedNextAction).toContain("variables.tf");
  });

  it("normalizes multiple terraform errors", () => {
    const raw = [
      "Error: Unsupported argument",
      "",
      '  on main.tf line 8, in resource "aws_instance" "web":',
      '  8:   foo = "bar"',
      "",
      'An argument named "foo" is not expected here.',
      "",
      "Error: Missing required argument",
      "",
      '  on iam.tf line 3, in resource "aws_iam_role" "role":',
      '  3:   assume_role_policy = "..."',
      "",
      'The argument "name" is required, but no definition was found.'
    ].join("\n");
    const out = normalizeValidationOutput({
      toolName: "terraform_validate",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 500
    });
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0].errorFamily).toBe("unsupported_argument");
    expect(out.findings[0].file).toBe("main.tf");
    expect(out.findings[1].errorFamily).toBe("missing_required_argument");
    expect(out.findings[1].file).toBe("iam.tf");
  });

  it("detects terraform by content heuristic when toolName is generic", () => {
    const raw = "Error: Reference to undeclared resource\n\n  on main.tf line 5";
    const out = normalizeValidationOutput({
      toolName: "run_command",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 500
    });
    expect(out.family).toBe("terraform");
    expect(out.findings[0].errorFamily).toBe("undeclared_resource");
  });

  /* ── Generic fallback ────────────────────────────────────────── */

  it("generic fallback extracts first line when no patterns match", () => {
    const raw = "Something went wrong: connection refused\nmore details here";
    const out = normalizeValidationOutput({
      toolName: "unknown",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("generic");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].message).toContain("Something went wrong");
    expect(out.findings[0].rawFingerprint).toHaveLength(12);
  });

  it("respects maxFindings for line parsers", () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x'.`
    ).join("\n");
    const out = normalizeValidationOutput({
      toolName: "tsc",
      rawOutput: lines,
      maxFindings: 5,
      maxExcerptChars: 200
    });
    expect(out.findings).toHaveLength(5);
  });

  /* ── Tier A: structured format parsers take precedence ──────── */

  it("prefers SARIF over line parsing and enriches findings", () => {
    const sarif = JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "ESLint" } },
        results: [{
          ruleId: "no-unused-vars",
          level: "error",
          message: { text: "'x' is defined but never used." },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 3, startColumn: 1 } } }]
        }]
      }]
    });
    const out = normalizeValidationOutput({
      toolName: "eslint",
      rawOutput: sarif,
      maxFindings: 50,
      maxExcerptChars: 280
    });
    expect(out.outputFormat).toBe("sarif");
    expect(out.findings[0].errorFamily).toBe("unused_symbol");
    expect(out.findings[0].likelyRootCause).toBeDefined();
    expect(out.findings[0].suggestedNextAction).toBeDefined();
    expect(out.findings[0].rawFingerprint).toHaveLength(12);
  });

  it("prefers ESLint JSON over line parsing", () => {
    const json = JSON.stringify([
      { filePath: "src/b.ts", messages: [{ ruleId: "semi", severity: 1, message: "Missing semicolon.", line: 5, column: 22 }] }
    ]);
    const out = normalizeValidationOutput({
      toolName: "eslint",
      rawOutput: json,
      maxFindings: 50,
      maxExcerptChars: 280
    });
    expect(out.outputFormat).toBe("json");
    expect(out.findings[0].ruleId).toBe("semi");
    expect(out.findings[0].errorFamily).toBe("style");
  });

  it("prefers JUnit XML over line parsing for pytest", () => {
    const junit = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1">
    <testcase classname="tests.test_a" name="test_fail">
      <failure message="assert False">tests/test_a.py:5: AssertionError</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const out = normalizeValidationOutput({
      toolName: "pytest",
      rawOutput: junit,
      maxFindings: 50,
      maxExcerptChars: 280
    });
    expect(out.outputFormat).toBe("junit");
    expect(out.findings).toHaveLength(1);
  });

  it("prefers Checkstyle XML over line parsing", () => {
    const checkstyle = `<?xml version="1.0"?>
<checkstyle version="4.3">
  <file name="src/index.ts">
    <error line="10" severity="error" message="Unexpected any." source="no-explicit-any"/>
  </file>
</checkstyle>`;
    const out = normalizeValidationOutput({
      toolName: "eslint",
      rawOutput: checkstyle,
      maxFindings: 50,
      maxExcerptChars: 280
    });
    expect(out.outputFormat).toBe("checkstyle");
    expect(out.findings).toHaveLength(1);
  });

  /* ── Summary format ─────────────────────────────────────────── */

  it("includes format, family, and enrichment lines in summary", () => {
    const raw = "src/foo.ts(1,1): error TS2304: Cannot find name 'x'.";
    const out = normalizeValidationOutput({
      toolName: "tsc",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.summary).toContain('format="text"');
    expect(out.summary).toContain('family="typescript"');
    expect(out.summary).toContain('findings="1"');
    expect(out.summary).toContain("Root cause:");
    expect(out.summary).toContain("Action:");
  });

  it("uses Tier C fallback when deterministic output is generic", async () => {
    const out = await normalizeValidationOutputWithTierC(
      {
        toolName: "unknown",
        rawOutput: "Validation failed for src/foo.ts at line 9: expected ';'",
        maxFindings: 5,
        maxExcerptChars: 200,
      },
      {
        enabled: true,
        fallback: async () => ({
          findings: [
            {
              family: "generic",
              severity: "error",
              file: "src/foo.ts",
              line: 9,
              message: "Expected semicolon",
            },
          ],
        }),
      },
    );
    expect(out.findings[0].file).toBe("src/foo.ts");
    expect(out.findings[0].line).toBe(9);
    expect(out.summary).toContain("src/foo.ts:9");
  });
});
