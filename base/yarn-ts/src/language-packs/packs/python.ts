import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const pythonPack: LanguagePackManifest = {
  id: "lang-python",
  language: "python",
  displayName: "Python",
  version: "1.0.0",
  families: ["ruff", "pytest", "mypy", "pylint"],
  toolSignals: [
    { pattern: /\bruff\b/i, family: "ruff" },
    { pattern: /\bpytest\b|\bpy\.test\b/i, family: "pytest" },
    { pattern: /\bmypy\b/i, family: "mypy" },
    { pattern: /\bpylint\b/i, family: "pylint" },
  ],
  classifiers: {
    ruff: (msg, ruleId) => classifyErrorFamily("ruff", msg, ruleId),
    pytest: (msg, ruleId) => classifyErrorFamily("pytest", msg, ruleId),
    mypy: (msg, ruleId) => classifyErrorFamily("mypy", msg, ruleId),
    pylint: (msg, ruleId) => classifyErrorFamily("pylint", msg, ruleId),
  },
  reducerFamilies: ["pytest", "lint", "mypy", "pylint", "python-unittest", "coverage"],
  fastPathPatterns: [
    {
      name: "python_traceback",
      regex: /(?:Traceback \(most recent call last\)|(\w+Error): .+)/,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
    },
    {
      name: "ruff_rule",
      regex: /\bruff\s+([A-Z]\d{3,4})\b/i,
      scope_tags: ["linter-rules"],
      constraint_kind: "guiding",
      queryTransform: (m) => `Ruff linter rule ${m[1]}`,
    },
  ],
  verificationCommands: [
    { tool: "ruff", command: "ruff check .", description: "Lint with Ruff" },
    { tool: "ruff-format", command: "ruff format --check .", description: "Check formatting with Ruff" },
    { tool: "mypy", command: "mypy .", description: "Type-check with mypy" },
    { tool: "pytest", command: "pytest --tb=short", description: "Run pytest" },
  ],
  fixRecipes: [
    {
      errorFamily: "unused_import",
      template: "Remove the unused import from {file} or add it to __all__ if re-exported.",
      description: "An import brings in a name that is never used",
    },
    {
      errorFamily: "type_mismatch",
      template: "Fix the assignment in {file} to match the declared type, or add an explicit cast.",
      description: "Assigned value type incompatible with declared variable type",
    },
    {
      errorFamily: "import_error",
      template: "Verify the module path and ensure the package is installed: pip show {module}",
      description: "Module required by code or test cannot be imported",
    },
    {
      errorFamily: "assertion_failure",
      template: "Check the expected value in the assertion — update the test or fix the implementation.",
      description: "Test assertion evaluated to False",
    },
    {
      errorFamily: "unused_variable",
      template: "Remove the variable or prefix with _ if intentionally unused in {file}.",
      description: "Variable is assigned but never read",
    },
  ],
  corpusPackId: "lang-python",
};
