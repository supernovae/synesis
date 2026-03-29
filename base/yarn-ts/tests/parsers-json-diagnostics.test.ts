import { describe, expect, it } from "vitest";
import { parseJsonDiagnostics } from "../src/validation/parsers/json-diagnostics.js";

describe("JSON diagnostics parser", () => {
  describe("ESLint JSON", () => {
    const ESLINT_JSON = JSON.stringify([
      {
        filePath: "/project/src/index.ts",
        messages: [
          { ruleId: "no-unused-vars", severity: 2, message: "'x' is defined but never used.", line: 10, column: 5 },
          { ruleId: "semi", severity: 1, message: "Missing semicolon.", line: 10, column: 20 }
        ],
        errorCount: 1,
        warningCount: 1
      },
      {
        filePath: "/project/src/utils.ts",
        messages: [
          { ruleId: "@typescript-eslint/no-explicit-any", severity: 2, message: "Unexpected any.", line: 3, column: 12 }
        ],
        errorCount: 1,
        warningCount: 0
      }
    ]);

    it("parses ESLint JSON output", () => {
      const findings = parseJsonDiagnostics(ESLINT_JSON, "eslint", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(3);

      expect(findings![0].family).toBe("eslint");
      expect(findings![0].file).toBe("/project/src/index.ts");
      expect(findings![0].line).toBe(10);
      expect(findings![0].column).toBe(5);
      expect(findings![0].ruleId).toBe("no-unused-vars");
      expect(findings![0].severity).toBe("error");

      expect(findings![1].severity).toBe("warning");
      expect(findings![2].file).toBe("/project/src/utils.ts");
    });

    it("respects maxFindings for ESLint JSON", () => {
      const findings = parseJsonDiagnostics(ESLINT_JSON, "eslint", 1);
      expect(findings).toHaveLength(1);
    });
  });

  describe("Ruff JSON", () => {
    const RUFF_JSON = JSON.stringify([
      {
        code: "F401",
        message: "`os` imported but unused",
        filename: "app/main.py",
        location: { row: 8, column: 1 },
        fix: { message: "Remove unused import: `os`" }
      },
      {
        code: "E501",
        message: "Line too long (120 > 88)",
        filename: "app/main.py",
        location: { row: 15, column: 89 }
      }
    ]);

    it("parses Ruff JSON output", () => {
      const findings = parseJsonDiagnostics(RUFF_JSON, "ruff", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(2);

      expect(findings![0].family).toBe("ruff");
      expect(findings![0].ruleId).toBe("F401");
      expect(findings![0].file).toBe("app/main.py");
      expect(findings![0].line).toBe(8);
      expect(findings![0].column).toBe(1);
      expect(findings![0].likelyFix).toContain("Remove unused import");

      expect(findings![1].ruleId).toBe("E501");
      expect(findings![1].likelyFix).toBeUndefined();
    });
  });

  describe("mypy JSON", () => {
    const MYPY_JSON = JSON.stringify([
      { file: "app/models.py", line: 42, column: 10, severity: "error", message: "Incompatible types in assignment", code: "assignment" },
      { file: "app/utils.py", line: 7, column: 1, severity: "warning", message: "Unused type: ignore comment", code: "unused-ignore" },
      { file: "app/utils.py", line: 10, column: 1, severity: "note", message: "See docs for details" }
    ]);

    it("parses mypy JSON output", () => {
      const findings = parseJsonDiagnostics(MYPY_JSON, "mypy", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(3);

      expect(findings![0].family).toBe("mypy");
      expect(findings![0].severity).toBe("error");
      expect(findings![0].ruleId).toBe("assignment");

      expect(findings![1].severity).toBe("warning");
      expect(findings![2].severity).toBe("info");
    });
  });

  describe("pylint JSON", () => {
    const PYLINT_JSON = JSON.stringify([
      { path: "app/main.py", line: 1, column: 0, type: "convention", message: "Missing module docstring", "message-id": "C0114", symbol: "missing-module-docstring" },
      { path: "app/main.py", line: 5, column: 4, type: "error", message: "Undefined variable 'x'", "message-id": "E0602", symbol: "undefined-variable" },
      { path: "app/utils.py", line: 10, column: 0, type: "refactor", message: "Too many branches", "message-id": "R0912", symbol: "too-many-branches" }
    ]);

    it("parses pylint JSON output", () => {
      const findings = parseJsonDiagnostics(PYLINT_JSON, "pylint", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(3);

      expect(findings![0].family).toBe("pylint");
      expect(findings![0].severity).toBe("info");
      expect(findings![0].ruleId).toBe("C0114");

      expect(findings![1].severity).toBe("error");
      expect(findings![1].ruleId).toBe("E0602");

      expect(findings![2].severity).toBe("info");
    });
  });

  describe("cargo clippy JSON", () => {
    const CARGO_LINES = [
      JSON.stringify({ reason: "compiler-artifact", target: { name: "mylib" } }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "warning",
          message: "unused variable: `x`",
          code: { code: "unused_variables" },
          spans: [{ file_name: "src/main.rs", line_start: 10, column_start: 9, label: "unused" }]
        }
      }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          level: "error",
          message: "cannot find value `y` in this scope",
          code: { code: "E0425" },
          spans: [{ file_name: "src/lib.rs", line_start: 22, column_start: 5 }]
        }
      }),
      JSON.stringify({ reason: "compiler-message", message: { level: "help", message: "consider importing" } }),
      JSON.stringify({ reason: "build-finished", success: false })
    ].join("\n");

    it("parses cargo clippy newline-delimited JSON", () => {
      const findings = parseJsonDiagnostics(CARGO_LINES, "cargo", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(2);

      expect(findings![0].family).toBe("cargo");
      expect(findings![0].severity).toBe("warning");
      expect(findings![0].file).toBe("src/main.rs");
      expect(findings![0].line).toBe(10);
      expect(findings![0].ruleId).toBe("unused_variables");

      expect(findings![1].severity).toBe("error");
      expect(findings![1].ruleId).toBe("E0425");
    });
  });

  describe("golangci-lint JSON", () => {
    const GOLANGCI_JSON = JSON.stringify({
      Issues: [
        { FromLinter: "ineffassign", Text: "ineffectual assignment to x", Severity: "warning", Pos: { Filename: "main.go", Line: 42, Column: 10 } },
        { FromLinter: "govet", Text: "printf: non-constant format string", Severity: "error", Pos: { Filename: "cmd/serve.go", Line: 88, Column: 3 } }
      ]
    });

    it("parses golangci-lint JSON output", () => {
      const findings = parseJsonDiagnostics(GOLANGCI_JSON, "golangci-lint", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(2);

      expect(findings![0].family).toBe("golangci-lint");
      expect(findings![0].severity).toBe("warning");
      expect(findings![0].file).toBe("main.go");
      expect(findings![0].ruleId).toBe("ineffassign");

      expect(findings![1].severity).toBe("error");
    });
  });

  describe("tfsec JSON", () => {
    const TFSEC_JSON = JSON.stringify({
      results: [
        {
          rule_id: "aws-s3-enable-versioning",
          rule_description: "S3 bucket versioning",
          description: "Bucket does not have versioning enabled",
          severity: "MEDIUM",
          location: { filename: "main.tf", start_line: 15 }
        },
        {
          rule_id: "aws-iam-no-policy-wildcards",
          description: "IAM policy should not use wildcards",
          severity: "HIGH",
          location: { filename: "iam.tf", start_line: 8 }
        }
      ]
    });

    it("parses tfsec JSON output", () => {
      const findings = parseJsonDiagnostics(TFSEC_JSON, "tfsec", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(2);

      expect(findings![0].family).toBe("tfsec");
      expect(findings![0].severity).toBe("warning");
      expect(findings![0].file).toBe("main.tf");
      expect(findings![0].ruleId).toBe("aws-s3-enable-versioning");

      expect(findings![1].severity).toBe("error");
    });
  });

  describe("trivy JSON", () => {
    const TRIVY_JSON = JSON.stringify({
      Results: [
        {
          Target: "requirements.txt",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-2024-1234",
              Severity: "CRITICAL",
              Title: "Remote code execution in requests",
              PkgName: "requests",
              InstalledVersion: "2.28.0",
              FixedVersion: "2.31.0"
            },
            {
              VulnerabilityID: "CVE-2024-5678",
              Severity: "LOW",
              Title: "Minor info leak",
              PkgName: "urllib3",
              InstalledVersion: "1.26.0"
            }
          ]
        }
      ]
    });

    it("parses trivy JSON output", () => {
      const findings = parseJsonDiagnostics(TRIVY_JSON, "trivy", 50);
      expect(findings).not.toBeNull();
      expect(findings).toHaveLength(2);

      expect(findings![0].family).toBe("trivy");
      expect(findings![0].severity).toBe("error");
      expect(findings![0].file).toBe("requirements.txt");
      expect(findings![0].ruleId).toBe("CVE-2024-1234");
      expect(findings![0].message).toContain("requests");
      expect(findings![0].likelyFix).toContain("2.31.0");

      expect(findings![1].severity).toBe("warning");
      expect(findings![1].likelyFix).toBeUndefined();
    });
  });

  describe("unrecognized JSON", () => {
    it("returns null for arbitrary JSON objects", () => {
      expect(parseJsonDiagnostics('{"foo": "bar"}', "generic", 50)).toBeNull();
    });

    it("returns null for arbitrary JSON arrays", () => {
      expect(parseJsonDiagnostics('[1, 2, 3]', "generic", 50)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseJsonDiagnostics("not json at all", "generic", 50)).toBeNull();
    });
  });
});
