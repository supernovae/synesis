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
      description: "A function returns an error that is not checked",
    },
  ],
  corpusPackId: "lang-go",
};
