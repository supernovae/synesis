import { describe, expect, it } from "vitest";
import { enrichItems, isEnrichable, type ParsedItem } from "../src/reduction/enrich-bridge.js";

describe("isEnrichable", () => {
  it("returns true for validator reducer families", () => {
    for (const f of ["pytest", "tsc", "lint", "mypy", "pylint", "cargo", "clippy", "terraform", "jest", "go-build", "shellcheck", "rubocop", "cppcheck"]) {
      expect(isEnrichable(f), `${f} should be enrichable`).toBe(true);
    }
  });

  it("returns false for non-validator families", () => {
    for (const f of ["git", "search", "npm-install", "docker-build", "kubectl", "generic"]) {
      expect(isEnrichable(f), `${f} should not be enrichable`).toBe(false);
    }
  });
});

describe("enrichItems — pytest", () => {
  it("classifies assertion failure", () => {
    const items: ParsedItem[] = [{ message: "test_add: assert 1 == 2" }];
    const result = enrichItems("pytest", items);
    expect(result.items[0].errorFamily).toBe("assertion_failure");
    expect(result.items[0].rootCause).toBeDefined();
    expect(result.items[0].action).toBeDefined();
    expect(result.enrichedLines.length).toBeGreaterThan(0);
  });

  it("classifies import error", () => {
    const items: ParsedItem[] = [{ message: "ModuleNotFoundError: No module named 'foo'" }];
    const result = enrichItems("pytest", items);
    expect(result.items[0].errorFamily).toBe("import_error");
  });

  it("marks bypassEligible when all items classified", () => {
    const items: ParsedItem[] = [
      { message: "test_x: assert True == False" },
      { message: "ImportError: No module named 'bar'" }
    ];
    const result = enrichItems("pytest", items);
    expect(result.bypassEligible).toBe(true);
  });
});

describe("enrichItems — tsc", () => {
  it("classifies type mismatch by message", () => {
    const items: ParsedItem[] = [{ message: "Type 'string' is not assignable to type 'number'.", file: "app.ts", ruleId: "TS2322" }];
    const result = enrichItems("tsc", items);
    expect(result.items[0].errorFamily).toBe("type_mismatch");
    expect(result.items[0].rootCause).toContain("type");
    expect(result.items[0].action).toContain("app.ts");
  });

  it("classifies undeclared name", () => {
    const items: ParsedItem[] = [{ message: "Cannot find name 'foo'.", file: "util.ts" }];
    const result = enrichItems("tsc", items);
    expect(result.items[0].errorFamily).toBe("undeclared_name");
  });
});

describe("enrichItems — lint (ruff subFamily)", () => {
  it("classifies unused import", () => {
    const items: ParsedItem[] = [{ message: "`os` imported but unused", file: "app.py", ruleId: "F401" }];
    const result = enrichItems("lint", items, "ruff");
    expect(result.items[0].errorFamily).toBe("unused_import");
    expect(result.items[0].action).toContain("app.py");
  });
});

describe("enrichItems — lint (eslint subFamily)", () => {
  it("classifies unused variable", () => {
    const items: ParsedItem[] = [{ message: "'x' is defined but never used", file: "app.js", ruleId: "no-unused-vars" }];
    const result = enrichItems("lint", items, "eslint");
    expect(result.items[0].errorFamily).toBe("unused_symbol");
  });
});

describe("enrichItems — mypy", () => {
  it("classifies incompatible types in assignment", () => {
    const items: ParsedItem[] = [{ message: "Incompatible types in assignment", file: "main.py", ruleId: "assignment" }];
    const result = enrichItems("mypy", items);
    expect(result.items[0].errorFamily).toBe("type_mismatch");
  });

  it("classifies attribute access error", () => {
    const items: ParsedItem[] = [{ message: "\"str\" has no attribute \"nonexistent\"", ruleId: "attr-defined" }];
    const result = enrichItems("mypy", items);
    expect(result.items[0].errorFamily).toBe("attribute_access");
  });
});

describe("enrichItems — pylint", () => {
  it("classifies unused import", () => {
    const items: ParsedItem[] = [{ message: "Unused import os", file: "app.py", ruleId: "W0611" }];
    const result = enrichItems("pylint", items);
    expect(result.items[0].errorFamily).toBe("unused_symbol");
  });

  it("classifies convention violation", () => {
    const items: ParsedItem[] = [{ message: "Line too long", ruleId: "C0123" }];
    const result = enrichItems("pylint", items);
    expect(result.items[0].errorFamily).toBe("convention");
  });
});

describe("enrichItems — cargo", () => {
  it("classifies type mismatch", () => {
    const items: ParsedItem[] = [{ message: "mismatched types", ruleId: "E0308" }];
    const result = enrichItems("cargo", items);
    expect(result.items[0].errorFamily).toBe("type_mismatch");
  });

  it("classifies borrow error", () => {
    const items: ParsedItem[] = [{ message: "cannot borrow as mutable", ruleId: "E0502" }];
    const result = enrichItems("cargo", items);
    expect(result.items[0].errorFamily).toBe("borrow_error");
  });
});

describe("enrichItems — clippy (mapped to cargo family)", () => {
  it("classifies unused symbol", () => {
    const items: ParsedItem[] = [{ message: "unused variable: `x`", file: "main.rs" }];
    const result = enrichItems("clippy", items);
    expect(result.items[0].errorFamily).toBe("unused_symbol");
  });
});

describe("enrichItems — terraform", () => {
  it("classifies undeclared variable", () => {
    const items: ParsedItem[] = [{ message: "Reference to undeclared input variable" }];
    const result = enrichItems("terraform", items);
    expect(result.items[0].errorFamily).toBe("undeclared_variable");
    expect(result.items[0].action).toContain("variables.tf");
  });

  it("classifies unsupported argument", () => {
    const items: ParsedItem[] = [{ message: "An argument named \"foo\" is not expected here. unsupported argument" }];
    const result = enrichItems("terraform", items);
    expect(result.items[0].errorFamily).toBe("unsupported_argument");
  });
});

describe("enrichItems — jest", () => {
  it("classifies assertion failure with expect/received", () => {
    const items: ParsedItem[] = [{ message: "src/app.test.ts: Expected 1 but Received 2" }];
    const result = enrichItems("jest", items);
    expect(result.items[0].errorFamily).toBe("assertion_failure");
  });

  it("classifies module not found", () => {
    const items: ParsedItem[] = [{ message: "Cannot find module './missing'" }];
    const result = enrichItems("jest", items);
    expect(result.items[0].errorFamily).toBe("import_error");
  });
});

describe("enrichItems — go-build", () => {
  it("classifies undefined name", () => {
    const items: ParsedItem[] = [{ message: "undefined: someFunc", file: "./main.go" }];
    const result = enrichItems("go-build", items);
    expect(result.items[0].errorFamily).toBe("undeclared_name");
    expect(result.items[0].action).toContain("main.go");
  });

  it("classifies unused import", () => {
    const items: ParsedItem[] = [{ message: "\"fmt\" imported and not used", file: "./util.go" }];
    const result = enrichItems("go-build", items);
    expect(result.items[0].errorFamily).toBe("unused_import");
  });
});

describe("enrichItems — shellcheck", () => {
  it("classifies unquoted variable (SC2086)", () => {
    const items: ParsedItem[] = [{ message: "Double quote to prevent globbing", file: "script.sh", ruleId: "SC2086" }];
    const result = enrichItems("shellcheck", items);
    expect(result.items[0].errorFamily).toBe("unquoted_variable");
    expect(result.items[0].action).toContain("double quotes");
  });

  it("classifies missing cd check (SC2164)", () => {
    const items: ParsedItem[] = [{ message: "Use cd ... || exit in case cd fails", ruleId: "SC2164" }];
    const result = enrichItems("shellcheck", items);
    expect(result.items[0].errorFamily).toBe("missing_cd_check");
  });
});

describe("enrichItems — rubocop", () => {
  it("classifies style offense", () => {
    const items: ParsedItem[] = [{ message: "Use snake_case for method names", file: "app.rb", ruleId: "Style/MethodName" }];
    const result = enrichItems("rubocop", items);
    expect(result.items[0].errorFamily).toBe("style");
  });

  it("classifies complexity offense", () => {
    const items: ParsedItem[] = [{ message: "Method has too many lines", ruleId: "Metrics/MethodLength" }];
    const result = enrichItems("rubocop", items);
    expect(result.items[0].errorFamily).toBe("complexity");
  });
});

describe("enrichItems — cppcheck", () => {
  it("classifies null pointer dereference", () => {
    const items: ParsedItem[] = [{ message: "Null pointer dereference: ptr", file: "main.cpp", ruleId: "nullPointer" }];
    const result = enrichItems("cppcheck", items);
    expect(result.items[0].errorFamily).toBe("null_dereference");
    expect(result.items[0].action).toContain("main.cpp");
  });

  it("classifies memory leak", () => {
    const items: ParsedItem[] = [{ message: "Memory leak: buf", ruleId: "memleak" }];
    const result = enrichItems("cppcheck", items);
    expect(result.items[0].errorFamily).toBe("memory_leak");
  });

  it("classifies unused variable", () => {
    const items: ParsedItem[] = [{ message: "unused variable x", ruleId: "unusedVariable" }];
    const result = enrichItems("cppcheck", items);
    expect(result.items[0].errorFamily).toBe("unused_symbol");
  });
});

describe("enrichItems — non-enrichable family", () => {
  it("returns unenriched items for unknown families", () => {
    const items: ParsedItem[] = [{ message: "some output" }];
    const result = enrichItems("git", items);
    expect(result.items[0].errorFamily).toBeUndefined();
    expect(result.bypassEligible).toBe(false);
    expect(result.enrichedLines).toEqual([]);
  });
});

describe("enrichItems — enrichedLines format", () => {
  it("includes numbered items with Root cause and Action", () => {
    const items: ParsedItem[] = [
      { message: "Type 'string' is not assignable to type 'number'.", file: "app.ts" }
    ];
    const result = enrichItems("tsc", items);
    expect(result.enrichedLines[0]).toMatch(/^\s+1\./);
    expect(result.enrichedLines.some((l) => l.includes("Root cause:"))).toBe(true);
    expect(result.enrichedLines.some((l) => l.includes("Action:"))).toBe(true);
  });
});

describe("enrichItems — bypassEligible", () => {
  it("is false when some items are not classified", () => {
    const items: ParsedItem[] = [
      { message: "assert 1 == 2" },
      { message: "completely unknown error pattern xyz123" }
    ];
    const result = enrichItems("pytest", items);
    expect(result.bypassEligible).toBe(false);
  });

  it("is false for empty items", () => {
    const result = enrichItems("pytest", []);
    expect(result.bypassEligible).toBe(false);
  });
});
