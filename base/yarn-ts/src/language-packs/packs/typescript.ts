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
    {
      errorFamily: "missing_property",
      template: "Check the type in {file}; add the missing property to the interface or narrow with optional chaining/assertion.",
      description: "Property does not exist on target type — add the property to the interface or use type assertion.",
      steps: [
        "Check type definition",
        "Add missing property to interface",
        "Or use optional chaining/assertion",
      ],
      constraints: "Prefer extending the type over assertion.",
    },
    {
      errorFamily: "argument_error",
      template: "Align the call in {file} with the function signature: fix argument count/types and add annotations.",
      description: "Function call has wrong number or types of arguments.",
      steps: [
        "Check function signature",
        "Adjust arguments",
        "Add type annotations",
      ],
      constraints: "Avoid `as any` cast.",
    },
    {
      errorFamily: "missing_return",
      template: "Ensure every branch in {file} returns a value, or declare undefined in the return type.",
      description: "Not all code paths return a value.",
      steps: [
        "Add return statement or undefined return type",
        "Check branch logic",
      ],
      constraints: "Prefer explicit returns.",
    },
    {
      errorFamily: "readonly_violation",
      template: "Respect readonly in {file}: make the field mutable, use Readonly<>, or clone before mutating.",
      description: "Attempted assignment to a readonly property.",
      steps: [
        "Check if property should be mutable",
        "Use Readonly utility type",
        "Or clone before mutating",
      ],
      constraints: "Respect immutability intent.",
    },
    {
      errorFamily: "duplicate_identifier",
      template: "Resolve the duplicate name in {file}: rename, fix re-exports, or use a namespace.",
      description: "Same identifier declared more than once in the same scope.",
      steps: ["Rename one declaration", "Check re-exports", "Use namespace"],
      constraints: "Avoid shadowing.",
    },
    {
      errorFamily: "unreachable_code",
      template: "Remove or restructure dead code after return/throw/break in {file}.",
      description: "Code after return/throw/break can never execute.",
      steps: ["Remove dead code or restructure control flow"],
      constraints: "Verify the return/throw is intentional.",
    },
    {
      errorFamily: "snapshot_mismatch",
      template: "Review the snapshot diff for the test in {file}; update only if the change is intentional.",
      description: "Rendered output no longer matches stored snapshot.",
      steps: [
        "Review visual diff",
        "Update snapshot if change is intentional",
        "Check for unintended side effects",
      ],
      constraints: "Never blindly update snapshots.",
    },
  ],
  corpusPackId: "lang-typescript",
};
