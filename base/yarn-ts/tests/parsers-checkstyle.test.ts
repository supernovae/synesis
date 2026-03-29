import { describe, expect, it } from "vitest";
import { isCheckstyle, parseCheckstyle } from "../src/validation/parsers/checkstyle.js";

describe("Checkstyle XML parser", () => {
  const ESLINT_CHECKSTYLE = `<?xml version="1.0" encoding="utf-8"?>
<checkstyle version="4.3">
  <file name="src/index.ts">
    <error line="10" column="5" severity="error" message="&apos;x&apos; is defined but never used." source="eslint.rules.no-unused-vars"/>
    <error line="15" column="1" severity="warning" message="Missing semicolon." source="eslint.rules.semi"/>
  </file>
  <file name="src/utils.ts">
    <error line="3" column="12" severity="error" message="Unexpected any." source="eslint.rules.@typescript-eslint/no-explicit-any"/>
  </file>
</checkstyle>`;

  const GOLANGCI_CHECKSTYLE = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="5.0">
  <file name="main.go">
    <error line="42" column="10" severity="error" message="ineffectual assignment to x" source="ineffassign"/>
  </file>
</checkstyle>`;

  it("detects checkstyle XML", () => {
    expect(isCheckstyle(ESLINT_CHECKSTYLE)).toBe(true);
    expect(isCheckstyle(GOLANGCI_CHECKSTYLE)).toBe(true);
  });

  it("rejects non-checkstyle XML", () => {
    expect(isCheckstyle("<testsuites></testsuites>")).toBe(false);
    expect(isCheckstyle("just text")).toBe(false);
    expect(isCheckstyle('{"json": true}')).toBe(false);
  });

  it("parses ESLint checkstyle output with multiple files", () => {
    const findings = parseCheckstyle(ESLINT_CHECKSTYLE, "eslint", 50);
    expect(findings).toHaveLength(3);

    expect(findings[0].file).toBe("src/index.ts");
    expect(findings[0].line).toBe(10);
    expect(findings[0].column).toBe(5);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].ruleId).toBe("eslint.rules.no-unused-vars");

    expect(findings[1].severity).toBe("warning");
    expect(findings[1].line).toBe(15);

    expect(findings[2].file).toBe("src/utils.ts");
    expect(findings[2].message).toContain("Unexpected any");
  });

  it("parses golangci-lint checkstyle output", () => {
    const findings = parseCheckstyle(GOLANGCI_CHECKSTYLE, "golangci-lint", 50);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("main.go");
    expect(findings[0].ruleId).toBe("ineffassign");
    expect(findings[0].message).toContain("ineffectual assignment");
  });

  it("maps severity correctly", () => {
    const xml = `<checkstyle>
  <file name="f.py">
    <error severity="error" message="a"/>
    <error severity="warning" message="b"/>
    <error severity="info" message="c"/>
    <error severity="ignore" message="d"/>
    <error message="e"/>
  </file>
</checkstyle>`;
    const findings = parseCheckstyle(xml, "generic", 50);
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning", "info", "info", "error"]);
  });

  it("respects maxFindings across multiple files", () => {
    const findings = parseCheckstyle(ESLINT_CHECKSTYLE, "eslint", 2);
    expect(findings).toHaveLength(2);
  });

  it("returns empty for checkstyle with no errors", () => {
    const clean = `<?xml version="1.0"?><checkstyle version="4.3"><file name="clean.ts"></file></checkstyle>`;
    const findings = parseCheckstyle(clean, "eslint", 50);
    expect(findings).toHaveLength(0);
  });
});
