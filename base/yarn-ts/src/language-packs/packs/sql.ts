import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const sqlPack: LanguagePackManifest = {
  id: "lang-sql",
  language: "sql",
  displayName: "SQL",
  version: "1.0.0",
  families: ["sqlfluff"],
  toolSignals: [
    { pattern: /\bsqlfluff\b/i, family: "sqlfluff" },
    { pattern: /\bpsql\b|\bmysql\b|\bsqlite3?\b|\bsqlcmd\b/i, family: "sqlfluff" },
  ],
  classifiers: {
    sqlfluff: (msg, ruleId) => classifyErrorFamily("sqlfluff", msg, ruleId),
  },
  reducerFamilies: ["sql-result"],
  fastPathPatterns: [
    {
      name: "sql_syntax_error",
      regex: /\b(?:syntax error|ERROR)\b.*?(?:at or near|near) "(\w+)"/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `SQL syntax error near "${m[1]}"`,
    },
    {
      name: "postgres_error_code",
      regex: /\b(?:ERROR|SQLSTATE)\s*:?\s*(\d{5})\b/,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `PostgreSQL error code ${m[1]}`,
    },
  ],
  verificationCommands: [
    { tool: "psql", command: "psql -c 'SELECT 1'", description: "Test PostgreSQL connection" },
    { tool: "sqlfluff", command: "sqlfluff lint .", description: "Lint SQL files" },
    { tool: "sqlfluff-fix", command: "sqlfluff fix .", description: "Auto-fix SQL style" },
  ],
  fixRecipes: [
    {
      errorFamily: "syntax_error",
      template: "Fix the SQL syntax — check for unclosed parentheses, missing commas, or invalid keywords.",
      description: "SQL statement contains a syntax error",
    },
    {
      errorFamily: "undeclared_column",
      template: "Verify the column name in {file} — check for typos or missing joins.",
      description: "Referenced column does not exist in the table",
    },
    {
      errorFamily: "undeclared_table",
      template: "Verify the table exists and check the schema qualifier.",
      description: "Referenced table does not exist",
    },
    {
      errorFamily: "permission_error",
      template: "Grant necessary permissions: GRANT SELECT ON {table} TO {role};",
      description: "Insufficient permissions to access resource",
    },
    {
      errorFamily: "type_mismatch",
      template: "Align column types in {file}: verify definitions, add explicit CAST, and match join key types.",
      description: "Column type doesn't match expected type in operation.",
      steps: [
        "Check column types",
        "Add explicit CAST",
        "Verify join conditions match types",
      ],
      constraints: "Prefer CAST over implicit conversion.",
    },
    {
      errorFamily: "constraint_violation",
      template: "Inspect the constraint definition, validate data before insert/update, and consider ON CONFLICT handling.",
      description: "Insert/update violates check/unique/FK constraint.",
      steps: [
        "Check constraint definition",
        "Validate data before insert",
        "Handle conflict with ON CONFLICT",
      ],
      constraints: "Use UPSERT patterns.",
    },
    {
      errorFamily: "deadlock",
      template: "Use consistent lock ordering, narrow transaction scope, and add retry logic for concurrent access.",
      description: "Concurrent transactions deadlocked.",
      steps: [
        "Ensure consistent lock ordering",
        "Reduce transaction scope",
        "Add retry logic",
      ],
      constraints: "Use advisory locks for complex coordination.",
    },
  ],
  corpusPackId: "lang-sql",
};
