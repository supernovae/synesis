import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const goPack: LanguagePackManifest = {
  id: "lang-go",
  language: "go",
  displayName: "Go",
  version: "1.0.0",
  families: ["go", "golangci-lint"],
  toolSignals: [
    { pattern: /\bgo\s+(?:build|test|vet|run)\b/i, family: "go" },
    { pattern: /\bgolangci-lint\b/i, family: "golangci-lint" },
  ],
  classifiers: {
    go: (msg, ruleId) => classifyErrorFamily("go", msg, ruleId),
    "golangci-lint": (msg, ruleId) => classifyErrorFamily("golangci-lint", msg, ruleId),
  },
  reducerFamilies: ["go-build"],
  fastPathPatterns: [
    {
      name: "go_vet_error",
      regex: /\b(?:go\s+vet|govet)\b.*?:\s*(.+)/i,
      scope_tags: ["error-catalog", "linter-rules"],
      constraint_kind: "hard",
    },
    {
      name: "golangci_lint",
      regex: /\bgolangci-lint\b.*?\b(\w+)\b/i,
      scope_tags: ["linter-rules"],
      constraint_kind: "guiding",
    },
  ],
  verificationCommands: [
    { tool: "go-build", command: "go build ./...", description: "Compile all packages" },
    { tool: "go-vet", command: "go vet ./...", description: "Run go vet checks" },
    { tool: "go-test", command: "go test ./...", description: "Run tests" },
    { tool: "golangci-lint", command: "golangci-lint run", description: "Lint with golangci-lint" },
  ],
  fixRecipes: [
    {
      errorFamily: "undeclared_name",
      template: "Add the missing import or declare the identifier in {file}.",
      description: "An identifier is used but not declared or imported",
    },
    {
      errorFamily: "unused_import",
      template: "Remove the unused import from {file}.",
      description: "A package is imported but not used (Go requires all imports to be used)",
    },
    {
      errorFamily: "unused_variable",
      template: "Use or remove the declared variable in {file} (Go requires all variables to be used).",
      description: "A variable is declared but never read",
    },
    {
      errorFamily: "type_mismatch",
      template: "Fix the type — check assignments and function signatures in {file}.",
      description: "Value type does not match expected type",
    },
    {
      errorFamily: "unchecked_error",
      template: "Handle the returned error — check and propagate or log it in {file}.",
      description: "A function returns an error that is not checked (golangci-lint).",
      steps: [
        "Handle the error",
        "Use _ explicitly if intentionally ignoring",
        "Add error wrapping",
      ],
      constraints: "Prefer wrapping with fmt.Errorf %w.",
    },
    {
      errorFamily: "type_conversion",
      template: "Fix the conversion in {file}: use explicit casts, type assertions with ok, or adjust types.",
      description: "Value cannot be converted to the target type.",
      steps: [
        "Check type compatibility",
        "Use explicit conversion",
        "Add type assertion with ok check",
      ],
      constraints: "Prefer comma-ok idiom.",
    },
    {
      errorFamily: "argument_error",
      template: "Match the call in {file} to the function signature; fix variadic usage and named returns if needed.",
      description: "Function called with wrong number of arguments.",
      steps: [
        "Check function signature",
        "Verify variadic args",
        "Use named return values",
      ],
      constraints: "Don't add unused parameters.",
    },
    {
      errorFamily: "syntax_error",
      template: "Fix Go syntax in {file}: run gofmt, fix braces/imports, then rebuild.",
      description: "Source file contains Go syntax error.",
      steps: [
        "Run gofmt",
        "Check for missing braces/semicolons",
        "Verify import paths",
      ],
      constraints: "Always gofmt before committing.",
    },
    {
      errorFamily: "import_cycle",
      template: "Break the cycle in {file}: extract shared types, introduce interfaces, or split packages.",
      description: "Packages form circular import dependency.",
      steps: [
        "Extract shared types to a new package",
        "Use interfaces for decoupling",
        "Restructure package boundaries",
      ],
      constraints: "Avoid god packages.",
    },
  ],
  corpusPackId: "lang-go",
};
