import { describe, expect, it } from "vitest";
import { isSarif, parseSarif } from "../src/validation/parsers/sarif.js";

describe("SARIF parser", () => {
  const MINIMAL_SARIF = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "ESLint" } },
        results: [
          {
            ruleId: "no-unused-vars",
            level: "error",
            message: { text: "'x' is defined but never used." },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/index.ts" },
                  region: { startLine: 10, startColumn: 5 }
                }
              }
            ]
          },
          {
            ruleId: "semi",
            level: "warning",
            message: { text: "Missing semicolon." },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/utils.ts" },
                  region: { startLine: 22, startColumn: 1 }
                }
              }
            ]
          }
        ]
      }
    ]
  };

  it("detects valid SARIF via $schema", () => {
    expect(isSarif(MINIMAL_SARIF)).toBe(true);
  });

  it("detects valid SARIF via runs array", () => {
    expect(isSarif({ runs: [] })).toBe(true);
  });

  it("rejects non-SARIF objects", () => {
    expect(isSarif({ foo: "bar" })).toBe(false);
    expect(isSarif(null)).toBe(false);
    expect(isSarif(42)).toBe(false);
    expect(isSarif([{ filePath: "x" }])).toBe(false);
  });

  it("extracts findings with file, line, column, ruleId", () => {
    const findings = parseSarif(MINIMAL_SARIF, "generic", 50);
    expect(findings).toHaveLength(2);

    expect(findings[0].family).toBe("eslint");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].file).toBe("src/index.ts");
    expect(findings[0].line).toBe(10);
    expect(findings[0].column).toBe(5);
    expect(findings[0].ruleId).toBe("no-unused-vars");
    expect(findings[0].message).toBe("'x' is defined but never used.");

    expect(findings[1].severity).toBe("warning");
    expect(findings[1].file).toBe("src/utils.ts");
  });

  it("respects maxFindings", () => {
    const findings = parseSarif(MINIMAL_SARIF, "generic", 1);
    expect(findings).toHaveLength(1);
  });

  it("maps SARIF levels correctly", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { name: "tfsec" } },
          results: [
            { level: "error", message: { text: "err" } },
            { level: "warning", message: { text: "warn" } },
            { level: "note", message: { text: "note" } },
            { level: "none", message: { text: "none" } },
            { message: { text: "default" } }
          ]
        }
      ]
    };
    const findings = parseSarif(sarif, "generic", 10);
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning", "info", "info", "error"]);
  });

  it("infers family from embedded tool name", () => {
    const semgrepSarif = {
      runs: [
        {
          tool: { driver: { name: "semgrep" } },
          results: [{ ruleId: "python.lang.best-practice", message: { text: "Use pathlib" } }]
        }
      ]
    };
    const findings = parseSarif(semgrepSarif, "generic", 10);
    expect(findings[0].family).toBe("semgrep");
  });

  it("falls back to provided family when tool name is unrecognized", () => {
    const unknownSarif = {
      runs: [
        {
          tool: { driver: { name: "custom-linter" } },
          results: [{ message: { text: "issue" } }]
        }
      ]
    };
    const findings = parseSarif(unknownSarif, "generic", 10);
    expect(findings[0].family).toBe("generic");
  });

  it("handles results with no locations", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { name: "trivy" } },
          results: [{ ruleId: "CVE-2024-1234", level: "error", message: { text: "Critical vuln" } }]
        }
      ]
    };
    const findings = parseSarif(sarif, "trivy", 10);
    expect(findings[0].file).toBeUndefined();
    expect(findings[0].line).toBeUndefined();
    expect(findings[0].message).toBe("Critical vuln");
  });

  it("handles multiple runs", () => {
    const sarif = {
      runs: [
        { tool: { driver: { name: "eslint" } }, results: [{ message: { text: "a" } }] },
        { tool: { driver: { name: "ruff" } }, results: [{ message: { text: "b" } }] }
      ]
    };
    const findings = parseSarif(sarif, "generic", 10);
    expect(findings).toHaveLength(2);
    expect(findings[0].family).toBe("eslint");
    expect(findings[1].family).toBe("ruff");
  });

  it("handles empty runs", () => {
    const findings = parseSarif({ runs: [] }, "generic", 10);
    expect(findings).toHaveLength(0);
  });
});
