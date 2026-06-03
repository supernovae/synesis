import { describe, expect, it } from "vitest";
import { classifyErrorFamily, enrichFindings, getNextAction, getRootCause } from "../src/validation/enrichment.js";
import type { ValidationFinding } from "../src/validation/types.js";

/* ── TypeScript classifier ─────────────────────────────────────── */

describe("classifyErrorFamily — TypeScript", () => {
  it("classifies type mismatch", () => {
    expect(classifyErrorFamily("typescript", "Type 'string' is not assignable to type 'number'.", undefined)).toBe("type_mismatch");
  });
  it("classifies undeclared name", () => {
    expect(classifyErrorFamily("typescript", "Cannot find name 'foo'.", undefined)).toBe("undeclared_name");
  });
  it("classifies missing property", () => {
    expect(classifyErrorFamily("typescript", "Property 'bar' does not exist on type 'Foo'.", undefined)).toBe("missing_property");
  });
  it("classifies argument error", () => {
    expect(classifyErrorFamily("typescript", "Expected 2 arguments, but got 1.", undefined)).toBe("argument_error");
  });
  it("classifies missing return", () => {
    expect(classifyErrorFamily("typescript", "Function lacks ending return statement and return type does not include 'undefined'. Not all code paths return a value.", undefined)).toBe("missing_return");
  });
  it("classifies import error", () => {
    expect(classifyErrorFamily("typescript", "Cannot find module 'express'.", undefined)).toBe("import_error");
  });
  it("classifies readonly violation", () => {
    expect(classifyErrorFamily("typescript", "Cannot assign to 'x' because it is a read-only property.", undefined)).toBe("readonly_violation");
  });
  it("classifies null check", () => {
    expect(classifyErrorFamily("typescript", "Object is possibly 'null'.", undefined)).toBe("null_check");
    expect(classifyErrorFamily("typescript", "Object is possibly 'undefined'.", undefined)).toBe("null_check");
  });
  it("returns undefined for unknown message", () => {
    expect(classifyErrorFamily("typescript", "Some unknown compiler message.", undefined)).toBeUndefined();
  });
});

/* ── ESLint classifier ─────────────────────────────────────────── */

describe("classifyErrorFamily — ESLint", () => {
  it("classifies unused symbol by ruleId", () => {
    expect(classifyErrorFamily("eslint", "'x' is defined but never used", "no-unused-vars")).toBe("unused_symbol");
  });
  it("classifies unused symbol by message fallback", () => {
    expect(classifyErrorFamily("eslint", "'x' is defined but never used", undefined)).toBe("unused_symbol");
  });
  it("classifies undeclared name", () => {
    expect(classifyErrorFamily("eslint", "'foo' is not defined", "no-undef")).toBe("undeclared_name");
  });
  it("classifies import issue", () => {
    expect(classifyErrorFamily("eslint", "unable to resolve", "import/no-unresolved")).toBe("import_issue");
  });
  it("classifies style", () => {
    expect(classifyErrorFamily("eslint", "Missing semicolon", "semi")).toBe("style");
  });
  it("classifies type safety", () => {
    expect(classifyErrorFamily("eslint", "Unexpected any", "@typescript-eslint/no-explicit-any")).toBe("type_safety");
  });
  it("classifies best practice", () => {
    expect(classifyErrorFamily("eslint", "Use const", "prefer-const")).toBe("best_practice");
  });
});

/* ── Ruff classifier ───────────────────────────────────────────── */

describe("classifyErrorFamily — Ruff", () => {
  it("classifies unused import F401", () => {
    expect(classifyErrorFamily("ruff", "os imported but unused", "F401")).toBe("unused_import");
  });
  it("classifies unused variable F841", () => {
    expect(classifyErrorFamily("ruff", "local variable x is assigned but never used", "F841")).toBe("unused_variable");
  });
  it("classifies line length E501", () => {
    expect(classifyErrorFamily("ruff", "Line too long", "E501")).toBe("line_length");
  });
  it("classifies style", () => {
    expect(classifyErrorFamily("ruff", "whitespace before ':'", "E203")).toBe("style");
  });
  it("classifies type annotation", () => {
    expect(classifyErrorFamily("ruff", "Missing type annotation for function argument", "ANN001")).toBe("type_annotation");
  });
  it("classifies complexity", () => {
    expect(classifyErrorFamily("ruff", "Too complex", "C901")).toBe("complexity");
  });
  it("classifies security", () => {
    expect(classifyErrorFamily("ruff", "Possible hardcoded password", "S105")).toBe("security");
  });
  it("classifies bugbear", () => {
    expect(classifyErrorFamily("ruff", "Do not use mutable default arguments", "B006")).toBe("bugbear");
  });
  it("classifies import order", () => {
    expect(classifyErrorFamily("ruff", "Import block is un-sorted", "I001")).toBe("import_order");
  });
});

/* ── pytest classifier ─────────────────────────────────────────── */

describe("classifyErrorFamily — pytest", () => {
  it("classifies assertion failure", () => {
    expect(classifyErrorFamily("pytest", "assert 2 == 3", undefined)).toBe("assertion_failure");
  });
  it("classifies fixture error", () => {
    expect(classifyErrorFamily("pytest", "fixture 'db' not found", undefined)).toBe("fixture_error");
  });
  it("classifies import error", () => {
    expect(classifyErrorFamily("pytest", "ModuleNotFoundError: No module named 'foo'", undefined)).toBe("import_error");
  });
  it("classifies timeout", () => {
    expect(classifyErrorFamily("pytest", "Test timed out after 30s", undefined)).toBe("timeout");
  });
  it("classifies type error", () => {
    expect(classifyErrorFamily("pytest", "TypeError: unsupported operand type(s)", undefined)).toBe("type_error");
  });
  it("classifies attribute error", () => {
    expect(classifyErrorFamily("pytest", "AttributeError: 'NoneType' has no attribute 'foo'", undefined)).toBe("attribute_error");
  });
  it("classifies key error", () => {
    expect(classifyErrorFamily("pytest", "KeyError: 'missing_key'", undefined)).toBe("key_error");
  });
  it("classifies value error", () => {
    expect(classifyErrorFamily("pytest", "ValueError: invalid literal for int()", undefined)).toBe("value_error");
  });
});

/* ── mypy classifier ───────────────────────────────────────────── */

describe("classifyErrorFamily — mypy", () => {
  it("classifies type mismatch by code", () => {
    expect(classifyErrorFamily("mypy", "Incompatible types in assignment", "assignment")).toBe("type_mismatch");
  });
  it("classifies argument type", () => {
    expect(classifyErrorFamily("mypy", 'Argument 1 has incompatible type "str"; expected "int"', "arg-type")).toBe("argument_type");
  });
  it("classifies return type", () => {
    expect(classifyErrorFamily("mypy", "Incompatible return value type", "return-value")).toBe("return_type");
  });
  it("classifies attribute access", () => {
    expect(classifyErrorFamily("mypy", '"Foo" has no attribute "bar"', "attr-defined")).toBe("attribute_access");
  });
  it("classifies import error", () => {
    expect(classifyErrorFamily("mypy", "Cannot find implementation or library stub for module", "import")).toBe("import_error");
  });
  it("classifies unused ignore", () => {
    expect(classifyErrorFamily("mypy", "Unused 'type: ignore' comment", "unused-ignore")).toBe("unused_ignore");
  });
});

/* ── pylint classifier ─────────────────────────────────────────── */

describe("classifyErrorFamily — pylint", () => {
  it("classifies undeclared name", () => {
    expect(classifyErrorFamily("pylint", "Undefined variable 'x'", "E0602")).toBe("undeclared_name");
  });
  it("classifies convention", () => {
    expect(classifyErrorFamily("pylint", "Missing module docstring", "C0114")).toBe("convention");
  });
  it("classifies unused symbol", () => {
    expect(classifyErrorFamily("pylint", "Unused variable 'x'", "W0612")).toBe("unused_symbol");
  });
  it("classifies complexity", () => {
    expect(classifyErrorFamily("pylint", "Too many branches", "R0912")).toBe("complexity");
  });
});

/* ── Terraform classifier ──────────────────────────────────────── */

describe("classifyErrorFamily — Terraform", () => {
  it("classifies undeclared variable", () => {
    expect(classifyErrorFamily("terraform", "Reference to undeclared input variable", undefined)).toBe("undeclared_variable");
  });
  it("classifies undeclared resource", () => {
    expect(classifyErrorFamily("terraform", "Reference to undeclared resource", undefined)).toBe("undeclared_resource");
  });
  it("classifies unsupported argument", () => {
    expect(classifyErrorFamily("terraform", "Unsupported argument: an argument named 'foo' is not expected here", undefined)).toBe("unsupported_argument");
  });
  it("classifies missing required argument", () => {
    expect(classifyErrorFamily("terraform", "Missing required argument: 'region' is required", undefined)).toBe("missing_required_argument");
  });
  it("classifies provider configuration", () => {
    expect(classifyErrorFamily("terraform", "Invalid provider configuration: provider credentials not set", undefined)).toBe("provider_configuration");
  });
  it("classifies type mismatch", () => {
    expect(classifyErrorFamily("terraform", "Incorrect attribute value type: a list of string is required", undefined)).toBe("type_mismatch");
  });
  it("classifies dependency cycle", () => {
    expect(classifyErrorFamily("terraform", "Cycle: module.a -> module.b -> module.a", undefined)).toBe("dependency_cycle");
  });
  it("classifies syntax error", () => {
    expect(classifyErrorFamily("terraform", "Error: unexpected token", undefined)).toBe("syntax_error");
  });
  it("returns undefined for unknown terraform message", () => {
    expect(classifyErrorFamily("terraform", "Some completely unknown terraform message", undefined)).toBeUndefined();
  });
});

/* ── Cargo / rustc classifier ──────────────────────────────────── */

describe("classifyErrorFamily — Cargo", () => {
  it("classifies type mismatch E0308", () => {
    expect(classifyErrorFamily("cargo", "mismatched types", "E0308")).toBe("type_mismatch");
  });
  it("classifies undeclared name E0425", () => {
    expect(classifyErrorFamily("cargo", "cannot find value `y`", "E0425")).toBe("undeclared_name");
  });
  it("classifies import error E0433", () => {
    expect(classifyErrorFamily("cargo", "unresolved import", "E0433")).toBe("import_error");
  });
  it("classifies trait bound E0277", () => {
    expect(classifyErrorFamily("cargo", "the trait bound is not satisfied", "E0277")).toBe("trait_bound");
  });
  it("classifies ownership E0382", () => {
    expect(classifyErrorFamily("cargo", "value used after being moved", "E0382")).toBe("ownership");
  });
  it("classifies borrow error E0502", () => {
    expect(classifyErrorFamily("cargo", "cannot borrow as mutable", "E0502")).toBe("borrow_error");
  });
  it("classifies Cargo manifest TOML syntax errors", () => {
    expect(classifyErrorFamily("cargo", "error: key with no value, expected `=` --> core/Cargo.toml:1:4", undefined)).toBe("manifest_syntax");
    expect(classifyErrorFamily("cargo", "error: failed to load manifest for workspace member `/repo/core`", undefined)).toBe("manifest_syntax");
  });
});

/* ── golangci-lint classifier ──────────────────────────────────── */

describe("classifyErrorFamily — golangci-lint", () => {
  it("classifies ineffectual assignment", () => {
    expect(classifyErrorFamily("golangci-lint", "ineffectual assignment to x", "ineffassign")).toBe("unused_assignment");
  });
  it("classifies vet error", () => {
    expect(classifyErrorFamily("golangci-lint", "printf format error", "govet")).toBe("vet_error");
  });
  it("classifies unchecked error", () => {
    expect(classifyErrorFamily("golangci-lint", "error return value not checked", "errcheck")).toBe("unchecked_error");
  });
  it("classifies static analysis", () => {
    expect(classifyErrorFamily("golangci-lint", "unreachable code", "staticcheck")).toBe("static_analysis");
  });
});

/* ── Security tools (tfsec, trivy, semgrep) ────────────────────── */

describe("classifyErrorFamily — security tools", () => {
  it("classifies critical vulnerability", () => {
    expect(classifyErrorFamily("tfsec", "remote code execution possible", undefined)).toBe("critical_vulnerability");
  });
  it("classifies injection", () => {
    expect(classifyErrorFamily("semgrep", "possible SQL injection in query builder", undefined)).toBe("injection");
  });
  it("classifies secret exposure", () => {
    expect(classifyErrorFamily("trivy", "hardcoded API key found in source", undefined)).toBe("secret_exposure");
  });
  it("classifies weak encryption", () => {
    expect(classifyErrorFamily("tfsec", "S3 bucket uses unencrypted storage", undefined)).toBe("weak_encryption");
  });
  it("classifies excessive permissions", () => {
    expect(classifyErrorFamily("tfsec", "IAM policy uses wildcard permissions", undefined)).toBe("excessive_permissions");
  });
  it("classifies known CVE by ruleId", () => {
    expect(classifyErrorFamily("trivy", "Some vulnerability", "CVE-2024-1234")).toBe("known_cve");
  });
});

/* ── Root cause + action tables ────────────────────────────────── */

describe("getRootCause", () => {
  it("returns root cause for known typescript error family", () => {
    const rc = getRootCause("typescript", "type_mismatch");
    expect(rc).toContain("does not match");
  });
  it("returns root cause for terraform undeclared_variable", () => {
    const rc = getRootCause("terraform", "undeclared_variable");
    expect(rc).toContain("not declared");
  });
  it("returns root cause for cargo ownership", () => {
    const rc = getRootCause("cargo", "ownership");
    expect(rc).toContain("moved");
  });
  it("returns undefined for unknown error family", () => {
    expect(getRootCause("typescript", "nonexistent_family")).toBeUndefined();
  });
  it("returns undefined for unknown tool family", () => {
    expect(getRootCause("generic", "type_mismatch")).toBeUndefined();
  });
});

describe("getNextAction", () => {
  it("returns action with file interpolation for typescript", () => {
    const action = getNextAction("typescript", "type_mismatch", "src/foo.ts");
    expect(action).toContain("src/foo.ts");
    expect(action).toContain("align the types");
  });
  it("returns action with fallback text when no file", () => {
    const action = getNextAction("typescript", "type_mismatch", undefined);
    expect(action).toContain("the affected file");
  });
  it("returns action for terraform undeclared_variable", () => {
    const action = getNextAction("terraform", "undeclared_variable", "main.tf");
    expect(action).toContain("main.tf");
    expect(action).toContain("variables.tf");
  });
  it("returns action for eslint unused_symbol", () => {
    const action = getNextAction("eslint", "unused_symbol");
    expect(action).toContain("Remove");
  });
  it("returns undefined for unknown error family", () => {
    expect(getNextAction("typescript", "nonexistent_family")).toBeUndefined();
  });
});

/* ── enrichFindings ────────────────────────────────────────────── */

describe("enrichFindings", () => {
  it("adds errorFamily, rootCause, action, and fingerprint to a TypeScript finding", () => {
    const findings: ValidationFinding[] = [{
      family: "typescript",
      severity: "error",
      file: "src/foo.ts",
      line: 12,
      message: "Type 'string' is not assignable to type 'number'."
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBe("type_mismatch");
    expect(enriched[0].likelyRootCause).toContain("does not match");
    expect(enriched[0].suggestedNextAction).toContain("src/foo.ts");
    expect(enriched[0].rawFingerprint).toHaveLength(12);
    expect(enriched[0].isRepeat).toBeUndefined();
  });

  it("adds enrichment to terraform findings", () => {
    const findings: ValidationFinding[] = [{
      family: "terraform",
      severity: "error",
      file: "main.tf",
      line: 15,
      message: "Reference to undeclared input variable"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBe("undeclared_variable");
    expect(enriched[0].likelyRootCause).toContain("not declared");
    expect(enriched[0].suggestedNextAction).toContain("main.tf");
    expect(enriched[0].suggestedNextAction).toContain("variables.tf");
  });

  it("marks repeat findings", () => {
    const findings: ValidationFinding[] = [
      { family: "ruff", severity: "error", file: "a.py", line: 1, ruleId: "F401", message: "os imported but unused" },
      { family: "ruff", severity: "error", file: "a.py", line: 5, ruleId: "F401", message: "os imported but unused" }
    ];
    const enriched = enrichFindings(findings);
    expect(enriched[0].isRepeat).toBeUndefined();
    expect(enriched[1].isRepeat).toBe(true);
  });

  it("computes stable fingerprints", () => {
    const findings: ValidationFinding[] = [{
      family: "eslint",
      severity: "error",
      file: "src/a.ts",
      line: 10,
      message: "'x' is defined but never used"
    }];
    const a = enrichFindings(findings);
    const b = enrichFindings(findings);
    expect(a[0].rawFingerprint).toBe(b[0].rawFingerprint);
  });

  it("preserves existing likelyFix when no action available", () => {
    const findings: ValidationFinding[] = [{
      family: "generic",
      severity: "error",
      message: "something broke",
      likelyFix: "try turning it off and on again"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].likelyFix).toBe("try turning it off and on again");
  });

  it("overrides likelyFix with suggestedNextAction when available", () => {
    const findings: ValidationFinding[] = [{
      family: "typescript",
      severity: "error",
      file: "src/foo.ts",
      line: 1,
      message: "Cannot find name 'bar'.",
      likelyFix: "old fix text"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].likelyFix).toContain("import");
    expect(enriched[0].likelyFix).not.toBe("old fix text");
  });

  it("handles findings with no classifiable pattern", () => {
    const findings: ValidationFinding[] = [{
      family: "generic",
      severity: "error",
      message: "Unknown error occurred"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBeUndefined();
    expect(enriched[0].likelyRootCause).toBeUndefined();
    expect(enriched[0].suggestedNextAction).toBeUndefined();
    expect(enriched[0].rawFingerprint).toHaveLength(12);
  });

  it("enriches security tool findings", () => {
    const findings: ValidationFinding[] = [{
      family: "trivy",
      severity: "error",
      file: "requirements.txt",
      ruleId: "CVE-2024-1234",
      message: "Critical remote code execution in requests"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBe("critical_vulnerability");
    expect(enriched[0].likelyRootCause).toContain("critical");
    expect(enriched[0].suggestedNextAction).toContain("Upgrade");
  });

  it("enriches cargo borrow error findings", () => {
    const findings: ValidationFinding[] = [{
      family: "cargo",
      severity: "error",
      file: "src/main.rs",
      line: 10,
      ruleId: "E0502",
      message: "cannot borrow `x` as mutable because it is also borrowed as immutable"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBe("borrow_error");
    expect(enriched[0].likelyRootCause).toContain("borrow");
    expect(enriched[0].suggestedNextAction).toContain("Restructure");
  });

  it("enriches Cargo manifest syntax findings", () => {
    const findings: ValidationFinding[] = [{
      family: "cargo",
      severity: "error",
      file: "core/Cargo.toml",
      line: 1,
      message: "key with no value, expected `=`"
    }];
    const enriched = enrichFindings(findings);
    expect(enriched[0].errorFamily).toBe("manifest_syntax");
    expect(enriched[0].suggestedNextAction).toContain("TOML");
    expect(enriched[0].suggestedNextAction).toContain("#");
  });
});
