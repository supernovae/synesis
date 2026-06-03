import { describe, expect, it, beforeEach } from "vitest";
import { LanguagePackRegistry, resetLanguagePackRegistry, getLanguagePackRegistry } from "../src/language-packs/registry.js";
import { ALL_PACKS } from "../src/language-packs/packs/index.js";
import { loadAllPacks, resetLoader } from "../src/language-packs/loader.js";
import { classifyErrorFamily } from "../src/validation/enrichment.js";
import { detectPattern } from "../src/evidence/fast-path.js";
import type { LanguagePackManifest } from "../src/language-packs/types.js";

/* ── Registry unit tests ──────────────────────────────────────────── */

describe("LanguagePackRegistry", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = new LanguagePackRegistry();
  });

  it("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.getAllPacks()).toHaveLength(0);
    expect(registry.getConformanceMatrix()).toHaveLength(0);
  });

  it("registers and retrieves by language", () => {
    const pack: LanguagePackManifest = {
      id: "test-lang",
      language: "testlang",
      displayName: "Test",
      version: "0.1.0",
      families: ["typescript"],
      toolSignals: [],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    registry.register(pack);
    expect(registry.getByLanguage("testlang")).toBe(pack);
    expect(registry.size).toBe(1);
  });

  it("retrieves by family", () => {
    const pack: LanguagePackManifest = {
      id: "test-fam",
      language: "testfam",
      displayName: "FamTest",
      version: "0.1.0",
      families: ["eslint"],
      toolSignals: [],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    registry.register(pack);
    expect(registry.getByFamily("eslint")).toBe(pack);
  });

  it("rejects duplicate language", () => {
    const pack: LanguagePackManifest = {
      id: "dup-a",
      language: "dup",
      displayName: "Dup",
      version: "0.1.0",
      families: [],
      toolSignals: [],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    registry.register(pack);
    expect(() => registry.register({ ...pack, id: "dup-b" })).toThrow(
      /already registered/
    );
  });

  it("rejects duplicate family claim", () => {
    const packA: LanguagePackManifest = {
      id: "a",
      language: "lang-a",
      displayName: "A",
      version: "0.1.0",
      families: ["typescript"],
      toolSignals: [],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    const packB: LanguagePackManifest = {
      id: "b",
      language: "lang-b",
      displayName: "B",
      version: "0.1.0",
      families: ["typescript"],
      toolSignals: [],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    registry.register(packA);
    expect(() => registry.register(packB)).toThrow(/already claimed/);
  });

  it("returns undefined for unknown language", () => {
    expect(registry.getByLanguage("nope")).toBeUndefined();
  });

  it("returns undefined for unknown family", () => {
    expect(registry.getByFamily("generic")).toBeUndefined();
  });

  it("detectFamilyFromTool matches tool signals", () => {
    const pack: LanguagePackManifest = {
      id: "ts-detect",
      language: "ts-detect",
      displayName: "TS",
      version: "0.1.0",
      families: ["typescript"],
      toolSignals: [{ pattern: /\btsc\b/i, family: "typescript" }],
      classifiers: {},
      reducerFamilies: [],
      fastPathPatterns: [],
      verificationCommands: [],
      fixRecipes: [],
      corpusPackId: "test",
    };
    registry.register(pack);
    expect(registry.detectFamilyFromTool("tsc --noEmit", "")).toBe("typescript");
    expect(registry.detectFamilyFromTool("unknown", "")).toBeUndefined();
  });
});

/* ── Conformance matrix computation ───────────────────────────────── */

describe("ConformanceMatrix", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = new LanguagePackRegistry();
  });

  it("computes correct coverage ratios", () => {
    const pack: LanguagePackManifest = {
      id: "coverage-test",
      language: "covlang",
      displayName: "CovLang",
      version: "1.0.0",
      families: ["typescript", "eslint"],
      toolSignals: [],
      classifiers: { typescript: () => undefined },
      reducerFamilies: ["tsc"],
      fastPathPatterns: [],
      verificationCommands: [{ tool: "t", command: "t", description: "t" }],
      fixRecipes: [{ errorFamily: "x", template: "y", description: "z" }],
      corpusPackId: "test",
    };
    registry.register(pack);
    const [entry] = registry.getConformanceMatrix();
    expect(entry.familyCount).toBe(2);
    expect(entry.classifierCount).toBe(1);
    expect(entry.classifierCoverage).toBe(0.5);
    expect(entry.reducerCount).toBe(1);
    expect(entry.reducerCoverage).toBe(0.5);
    expect(entry.verificationCommandCount).toBe(1);
    expect(entry.fixRecipeCount).toBe(1);
  });
});

/* ── All 10 pack definitions ─────────────────────────────────────── */

describe("ALL_PACKS", () => {
  it("contains exactly 10 packs", () => {
    expect(ALL_PACKS).toHaveLength(10);
  });

  it("has unique language ids", () => {
    const ids = ALL_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique language names", () => {
    const langs = ALL_PACKS.map((p) => p.language);
    expect(new Set(langs).size).toBe(langs.length);
  });

  it("every pack has a version", () => {
    for (const pack of ALL_PACKS) {
      expect(pack.version).toBeTruthy();
    }
  });

  it("every pack has a corpusPackId", () => {
    for (const pack of ALL_PACKS) {
      expect(pack.corpusPackId).toBeTruthy();
    }
  });
});

/* ── Loader integration tests ─────────────────────────────────────── */

describe("loadAllPacks", () => {
  beforeEach(() => {
    resetLoader();
    resetLanguagePackRegistry();
  });

  it("loads all 10 packs into the singleton registry", () => {
    loadAllPacks();
    const registry = getLanguagePackRegistry();
    expect(registry.size).toBe(10);
  });

  it("is idempotent", () => {
    loadAllPacks();
    loadAllPacks();
    expect(getLanguagePackRegistry().size).toBe(10);
  });

  it("conformance matrix has 10 entries after loading", () => {
    loadAllPacks();
    const matrix = getLanguagePackRegistry().getConformanceMatrix();
    expect(matrix).toHaveLength(10);
  });
});

/* ── Pack classifier integration tests ────────────────────────────── */

describe("Pack classifiers produce expected families", () => {
  beforeEach(() => {
    resetLoader();
    resetLanguagePackRegistry();
    loadAllPacks();
  });

  it("typescript: classifies type_mismatch", () => {
    expect(classifyErrorFamily("typescript", "Type 'string' is not assignable to type 'number'.")).toBe("type_mismatch");
  });

  it("eslint: classifies unused_symbol", () => {
    expect(classifyErrorFamily("eslint", "'x' is defined but never used", "no-unused-vars")).toBe("unused_symbol");
  });

  it("ruff: classifies unused_import", () => {
    expect(classifyErrorFamily("ruff", "Unused import", "F401")).toBe("unused_import");
  });

  it("pytest: classifies assertion_failure", () => {
    expect(classifyErrorFamily("pytest", "assert 1 == 2")).toBe("assertion_failure");
  });

  it("mypy: classifies type_mismatch", () => {
    expect(classifyErrorFamily("mypy", "Incompatible types in assignment", "assignment")).toBe("type_mismatch");
  });

  it("cargo: classifies ownership", () => {
    expect(classifyErrorFamily("cargo", "value used after being moved: moved value")).toBe("ownership");
  });

  it("go: classifies unused_import", () => {
    expect(classifyErrorFamily("go", '"fmt" imported and not used')).toBe("unused_import");
  });

  it("golangci-lint: classifies unchecked_error", () => {
    expect(classifyErrorFamily("golangci-lint", "Error return value is not checked", "errcheck")).toBe("unchecked_error");
  });

  it("shellcheck: classifies unquoted_variable", () => {
    expect(classifyErrorFamily("shellcheck", "Double quote to prevent globbing", "SC2086")).toBe("unquoted_variable");
  });

  it("java: classifies undeclared_name", () => {
    expect(classifyErrorFamily("java", "error: cannot find symbol")).toBe("undeclared_name");
  });

  it("java: classifies unchecked_exception", () => {
    expect(classifyErrorFamily("java", "unreported exception IOException; must be caught or declared to be thrown")).toBe("unchecked_exception");
  });

  it("dotnet: classifies undeclared_name via CS code", () => {
    expect(classifyErrorFamily("dotnet", "The name 'foo' does not exist in the current context", "CS0103")).toBe("undeclared_name");
  });

  it("dotnet: classifies type_mismatch", () => {
    expect(classifyErrorFamily("dotnet", "Cannot implicitly convert type 'int' to 'string'", "CS0029")).toBe("type_mismatch");
  });

  it("sqlfluff: classifies syntax_error", () => {
    expect(classifyErrorFamily("sqlfluff", "syntax error at or near SELECT")).toBe("syntax_error");
  });

  it("sqlfluff: classifies undeclared_column", () => {
    expect(classifyErrorFamily("sqlfluff", "Unknown column 'email' in field list")).toBe("undeclared_column");
  });

  it("yamllint: classifies indentation", () => {
    expect(classifyErrorFamily("yamllint", "wrong indentation: expected 2 but found 4", "indentation")).toBe("indentation");
  });

  it("yamllint: classifies duplicate_key", () => {
    expect(classifyErrorFamily("yamllint", "duplication of key 'name' in mapping")).toBe("duplicate_key");
  });
});

/* ── Fast-path pattern detection via registry ─────────────────────── */

describe("Fast-path patterns from registry packs", () => {
  beforeEach(() => {
    resetLoader();
    resetLanguagePackRegistry();
    loadAllPacks();
  });

  it("detects TypeScript error code TS2345", () => {
    const match = detectPattern("error TS2345: Argument of type");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("typescript_error");
    expect(match!.language).toBe("typescript");
    expect(match!.constraint_kind).toBe("hard");
  });

  it("detects Rust error code E0308", () => {
    const match = detectPattern("error[E0308]: mismatched types in rustc");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("rust_error");
    expect(match!.language).toBe("rust");
  });

  it("detects Cargo manifest syntax errors", () => {
    const match = detectPattern("error: key with no value, expected `=` --> core/Cargo.toml:1:4");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("cargo_manifest_syntax");
    expect(match!.language).toBe("rust");
    expect(match!.constraint_kind).toBe("hard");
  });

  it("detects Python traceback", () => {
    const match = detectPattern("Traceback (most recent call last)");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("python_traceback");
    expect(match!.language).toBe("python");
  });

  it("detects ESLint rule reference", () => {
    const match = detectPattern("eslint/no-unused-vars is failing");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("eslint_rule");
    expect(match!.constraint_kind).toBe("guiding");
  });

  it("detects Ruff rule reference", () => {
    const match = detectPattern("ruff F401 unused import");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("ruff_rule");
    expect(match!.language).toBe("python");
  });

  it("detects ShellCheck rule SC2086", () => {
    const match = detectPattern("ShellCheck warns about SC2086");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("shellcheck_rule");
    expect(match!.language).toBe("bash");
  });

  it("detects C# compiler error CS0103", () => {
    const match = detectPattern("error CS0103: The name does not exist");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("csharp_compiler_error");
    expect(match!.language).toBe("csharp");
  });

  it("returns null for unmatched text", () => {
    const match = detectPattern("just a regular sentence about coding");
    expect(match).toBeNull();
  });
});

/* ── Conformance snapshot regression test ─────────────────────────── */

describe("Conformance matrix snapshot", () => {
  beforeEach(() => {
    resetLoader();
    resetLanguagePackRegistry();
    loadAllPacks();
  });

  it("matches expected conformance matrix", () => {
    const matrix = getLanguagePackRegistry().getConformanceMatrix();
    const summary = matrix.map((e) => ({
      language: e.language,
      familyCount: e.familyCount,
      classifierCount: e.classifierCount,
      reducerCount: e.reducerCount,
      fastPathPatternCount: e.fastPathPatternCount,
      fixRecipeCount: e.fixRecipeCount,
    }));

    expect(summary).toEqual([
      { language: "typescript", familyCount: 3, classifierCount: 3, reducerCount: 4, fastPathPatternCount: 2, fixRecipeCount: 12 },
      { language: "python", familyCount: 4, classifierCount: 4, reducerCount: 6, fastPathPatternCount: 2, fixRecipeCount: 12 },
      { language: "go", familyCount: 2, classifierCount: 2, reducerCount: 1, fastPathPatternCount: 2, fixRecipeCount: 9 },
      { language: "rust", familyCount: 1, classifierCount: 1, reducerCount: 2, fastPathPatternCount: 3, fixRecipeCount: 10 },
      { language: "terraform", familyCount: 2, classifierCount: 2, reducerCount: 1, fastPathPatternCount: 1, fixRecipeCount: 10 },
      { language: "java", familyCount: 1, classifierCount: 1, reducerCount: 2, fastPathPatternCount: 2, fixRecipeCount: 9 },
      { language: "csharp", familyCount: 1, classifierCount: 1, reducerCount: 1, fastPathPatternCount: 1, fixRecipeCount: 9 },
      { language: "sql", familyCount: 1, classifierCount: 1, reducerCount: 1, fastPathPatternCount: 2, fixRecipeCount: 7 },
      { language: "bash", familyCount: 1, classifierCount: 1, reducerCount: 1, fastPathPatternCount: 2, fixRecipeCount: 8 },
      { language: "yaml-k8s", familyCount: 1, classifierCount: 1, reducerCount: 4, fastPathPatternCount: 2, fixRecipeCount: 7 },
    ]);
  });

  it("all packs have classifierCoverage >= 0", () => {
    const matrix = getLanguagePackRegistry().getConformanceMatrix();
    for (const entry of matrix) {
      expect(entry.classifierCoverage).toBeGreaterThanOrEqual(0);
      expect(entry.classifierCoverage).toBeLessThanOrEqual(1);
    }
  });

  it("strong languages (TS, Python, Go, Rust) have 100% classifier coverage", () => {
    const matrix = getLanguagePackRegistry().getConformanceMatrix();
    const strong = matrix.filter((e) =>
      ["typescript", "python", "go", "rust"].includes(e.language)
    );
    for (const entry of strong) {
      expect(entry.classifierCoverage).toBe(1);
    }
  });
});
