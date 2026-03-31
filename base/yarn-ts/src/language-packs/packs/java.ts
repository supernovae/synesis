import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const javaPack: LanguagePackManifest = {
  id: "lang-java",
  language: "java",
  displayName: "Java",
  version: "1.0.0",
  families: ["java"],
  toolSignals: [
    { pattern: /\bjavac\b|\bmvn\b|\bgradle\b/i, family: "java" },
  ],
  classifiers: {
    java: (msg, ruleId) => classifyErrorFamily("java", msg, ruleId),
  },
  reducerFamilies: ["java-build", "gradle"],
  fastPathPatterns: [
    {
      name: "java_compiler_error",
      regex: /\bjava:\s*(?:\[\d+,\d+\])?\s*error:\s*(.+)/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Java compiler error: ${m[1].slice(0, 80)}`,
    },
    {
      name: "maven_dependency_error",
      regex: /\bCould not resolve dependencies\b.*?:\s*(.+)/i,
      scope_tags: ["dependency-management"],
      constraint_kind: "hard",
      queryTransform: (m) => `Maven dependency resolution error: ${m[1].slice(0, 80)}`,
    },
  ],
  verificationCommands: [
    { tool: "maven", command: "mvn compile", description: "Compile with Maven" },
    { tool: "gradle", command: "./gradlew build", description: "Build with Gradle" },
    { tool: "maven-test", command: "mvn test", description: "Run Maven tests" },
    { tool: "checkstyle", command: "mvn checkstyle:check", description: "Check style" },
  ],
  fixRecipes: [
    {
      errorFamily: "undeclared_name",
      template: "Add the missing import or declare the symbol in {file}.",
      description: "Symbol is referenced but not declared or imported",
    },
    {
      errorFamily: "type_mismatch",
      template: "Fix the type — check assignments, casts, and generic parameters in {file}.",
      description: "Incompatible types in assignment or method call",
    },
    {
      errorFamily: "import_error",
      template: "Add the correct import or ensure the dependency is in pom.xml / build.gradle.",
      description: "Package or class cannot be resolved",
    },
    {
      errorFamily: "unchecked_exception",
      template: "Add try-catch or declare the exception in the throws clause.",
      description: "Checked exception not handled or declared",
    },
    {
      errorFamily: "null_dereference",
      template: "Add a null check before dereferencing: if (obj != null) {{ ... }}",
      description: "Possible NullPointerException",
    },
  ],
  corpusPackId: "lang-java",
};
