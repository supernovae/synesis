import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const csharpPack: LanguagePackManifest = {
  id: "lang-csharp",
  language: "csharp",
  displayName: "C#",
  version: "1.0.0",
  families: ["dotnet"],
  toolSignals: [
    { pattern: /\bdotnet\b|\bmsbuild\b|\bnuget\b/i, family: "dotnet" },
  ],
  classifiers: {
    dotnet: (msg, ruleId) => classifyErrorFamily("dotnet", msg, ruleId),
  },
  reducerFamilies: ["dotnet"],
  fastPathPatterns: [
    {
      name: "csharp_compiler_error",
      regex: /\bCS(\d{4})\b/,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `C# compiler error CS${m[1]}`,
    },
  ],
  verificationCommands: [
    { tool: "dotnet-build", command: "dotnet build --no-restore", description: "Compile with dotnet" },
    { tool: "dotnet-test", command: "dotnet test --no-build", description: "Run tests" },
    { tool: "dotnet-format", command: "dotnet format --verify-no-changes", description: "Check formatting" },
  ],
  fixRecipes: [
    {
      errorFamily: "undeclared_name",
      template: "Add a using directive or declare the name in {file}.",
      description: "Name does not exist in the current context",
    },
    {
      errorFamily: "type_mismatch",
      template: "Add an explicit cast or change the target type in {file}.",
      description: "Cannot implicitly convert between types",
    },
    {
      errorFamily: "import_error",
      template: "Add the missing using directive or install the NuGet package.",
      description: "Type or namespace could not be found",
    },
    {
      errorFamily: "null_check",
      template: "Add a null check or use the null-conditional operator (?.) in {file}.",
      description: "Possible null reference assignment",
    },
    {
      errorFamily: "missing_member",
      template: "Check the type definition — add the member or use an extension method.",
      description: "Type does not contain the accessed definition",
    },
    {
      errorFamily: "namespace_error",
      template: "Add the correct using directive, verify NuGet package references, and confirm target framework in {file}.",
      description: "Type does not exist in the specified namespace.",
      steps: [
        "Add correct using directive",
        "Check NuGet package reference",
        "Verify target framework",
      ],
      constraints: "Prefer global usings for common namespaces.",
    },
    {
      errorFamily: "unused_variable",
      template: "Remove the unused variable, prefix with _ if intentionally unused, or check for assignment side effects in {file}.",
      description: "Variable declared but never used.",
      steps: [
        "Remove unused variable",
        "Prefix with _ if intentionally unused",
        "Check for assignment side effects",
      ],
      constraints: "Use discard pattern for intent.",
    },
    {
      errorFamily: "unreachable_code",
      template: "Remove dead code, restructure control flow, or verify early returns in {file}.",
      description: "Code unreachable and will never execute.",
      steps: [
        "Remove dead code",
        "Restructure control flow",
        "Check for early returns",
      ],
      constraints: "Verify the early return is intentional.",
    },
    {
      errorFamily: "override_mismatch",
      template: "Match the base method signature exactly; choose new vs override correctly; verify virtual/abstract in {file}.",
      description: "Method override signature incompatible with base.",
      steps: [
        "Match base method signature exactly",
        "Check for new vs override",
        "Verify virtual/abstract",
      ],
      constraints: "Prefer override over new.",
    },
  ],
  corpusPackId: "lang-csharp",
};
