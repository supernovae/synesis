import { describe, expect, it } from "vitest";
import { isJunit, parseJunit } from "../src/validation/parsers/junit.js";

describe("JUnit XML parser", () => {
  const PYTEST_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="3" failures="2" errors="0" time="1.234">
    <testcase classname="tests.test_math" name="test_add" time="0.01">
      <failure message="assert 2 == 3">
tests/test_math.py:5: AssertionError
assert 2 == 3
      </failure>
    </testcase>
    <testcase classname="tests.test_math" name="test_sub" time="0.01">
      <failure message="assert 5 == 4">
tests/test_math.py:10: AssertionError
      </failure>
    </testcase>
    <testcase classname="tests.test_math" name="test_mul" time="0.01"/>
  </testsuite>
</testsuites>`;

  const JEST_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="2" failures="1" time="3.456">
  <testsuite name="src/utils.test.ts" tests="2" failures="1">
    <testcase classname="src.utils.test.ts" name="adds numbers" time="0.005"/>
    <testcase classname="src.utils.test.ts" name="handles null" time="0.003">
      <failure message="Expected null to equal 0">
TypeError: Cannot read property 'value' of null
    at Object.&lt;anonymous&gt; (src/utils.test.ts:15)
      </failure>
    </testcase>
  </testsuite>
</testsuites>`;

  it("detects JUnit XML with xml declaration", () => {
    expect(isJunit(PYTEST_JUNIT)).toBe(true);
  });

  it("detects JUnit XML starting with <testsuites", () => {
    expect(isJunit("<testsuites><testsuite/></testsuites>")).toBe(true);
  });

  it("detects JUnit XML starting with <testsuite", () => {
    expect(isJunit("<testsuite name='x'></testsuite>")).toBe(true);
  });

  it("rejects non-JUnit content", () => {
    expect(isJunit("<checkstyle></checkstyle>")).toBe(false);
    expect(isJunit("not xml")).toBe(false);
    expect(isJunit('{"json": true}')).toBe(false);
  });

  it("parses pytest JUnit output: only failures, not passes", () => {
    const findings = parseJunit(PYTEST_JUNIT, "pytest", 50);
    expect(findings).toHaveLength(2);

    expect(findings[0].message).toContain("test_add");
    expect(findings[0].message).toContain("assert 2 == 3");
    expect(findings[0].file).toBe("tests/test_math");
    expect(findings[0].severity).toBe("error");

    expect(findings[1].message).toContain("test_sub");
  });

  it("parses Jest JUnit output", () => {
    const findings = parseJunit(JEST_JUNIT, "jest", 50);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("handles null");
    expect(findings[0].message).toContain("Expected null to equal 0");
  });

  it("extracts line numbers from stack traces", () => {
    const findings = parseJunit(JEST_JUNIT, "jest", 50);
    expect(findings[0].line).toBe(15);
  });

  it("respects maxFindings", () => {
    const findings = parseJunit(PYTEST_JUNIT, "pytest", 1);
    expect(findings).toHaveLength(1);
  });

  it("returns empty array for all-pass suite", () => {
    const allPass = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="suite" tests="1" failures="0">
    <testcase classname="a.b" name="test_ok" time="0.01"/>
  </testsuite>
</testsuites>`;
    const findings = parseJunit(allPass, "pytest", 50);
    expect(findings).toHaveLength(0);
  });

  it("handles <error> tags (JUnit errors vs failures)", () => {
    const withError = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="suite" tests="1" errors="1">
    <testcase classname="pkg.Test" name="test_crash" time="0.1">
      <error message="RuntimeError: boom">
pkg/test.py:42: RuntimeError
      </error>
    </testcase>
  </testsuite>
</testsuites>`;
    const findings = parseJunit(withError, "pytest", 50);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("RuntimeError: boom");
    expect(findings[0].line).toBe(42);
  });
});
