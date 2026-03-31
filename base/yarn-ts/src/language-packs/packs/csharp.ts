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
  ],
  corpusPackId: "lang-csharp",
};
