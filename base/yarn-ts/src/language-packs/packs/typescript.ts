import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const typescriptPack: LanguagePackManifest = {
  id: "lang-typescript",
  language: "typescript",
  displayName: "TypeScript / JavaScript",
  version: "1.0.0",
  families: ["typescript", "eslint", "jest"],
  toolSignals: [
    { pattern: /\btsc\b|error TS\d/i, family: "typescript" },
    { pattern: /\beslint\b/i, family: "eslint" },
    { pattern: /\b(?:jest|vitest)\b/i, family: "jest" },
  ],
  classifiers: {
    typescript: (msg, ruleId) => classifyErrorFamily("typescript", msg, ruleId),
    eslint: (msg, ruleId) => classifyErrorFamily("eslint", msg, ruleId),
    jest: (msg, ruleId) => classifyErrorFamily("jest", msg, ruleId),
  },
  reducerFamilies: ["tsc", "lint", "jest", "mocha"],
  fastPathPatterns: [
    {
      name: "typescript_error",
      regex: /\bTS(\d{4,5})\b/,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `TypeScript error TS${m[1]}`,
    },
    {
      name: "eslint_rule",
      regex: /\b(?:eslint|@typescript-eslint)[/-](\S+)/i,
      scope_tags: ["linter-rules"],
      constraint_kind: "guiding",
      queryTransform: (m) => `ESLint rule ${m[0]}`,
    },
  ],
  verificationCommands: [
    { tool: "tsc", command: "npx tsc --noEmit", description: "Type-check without emitting" },
    { tool: "eslint", command: "npx eslint .", description: "Lint with ESLint" },
    { tool: "jest", command: "npx jest --passWithNoTests", description: "Run Jest tests" },
    { tool: "prettier", command: "npx prettier --check .", description: "Check formatting" },
  ],
  fixRecipes: [
    {
      errorFamily: "type_mismatch",
      template: "Check the assignment in {file} and align the types, or add an explicit cast.",
      description: "Value type does not match the declared or inferred type",
    },
    {
      errorFamily: "undeclared_name",
      template: "Add the missing import or declare the identifier in {file}.",
      description: "An identifier is referenced but not declared in scope",
    },
    {
      errorFamily: "import_error",
      template: "Verify the module path exists and the package is installed: npm ls {module}",
      description: "Module or package cannot be resolved",
    },
    {
      errorFamily: "unused_symbol",
      template: "Remove the unused declaration or prefix with underscore in {file}.",
      description: "Variable, import, or parameter is declared but never referenced",
    },
    {
      errorFamily: "null_check",
      template: "Add optional chaining (?.) or nullish coalescing (??) in {file}.",
      description: "Value may be null or undefined and strict checks require handling",
    },
  ],
  corpusPackId: "lang-typescript",
};
