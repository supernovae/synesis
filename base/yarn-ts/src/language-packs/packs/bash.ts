import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const bashPack: LanguagePackManifest = {
  id: "lang-bash",
  language: "bash",
  displayName: "Bash / Shell",
  version: "1.0.0",
  families: ["shellcheck"],
  toolSignals: [
    { pattern: /\bshellcheck\b/i, family: "shellcheck" },
  ],
  classifiers: {
    shellcheck: (msg, ruleId) => classifyErrorFamily("shellcheck", msg, ruleId),
  },
  reducerFamilies: ["shellcheck"],
  fastPathPatterns: [
    {
      name: "shellcheck_rule",
      regex: /\bSC(\d{4})\b/,
      scope_tags: ["linter-rules"],
      constraint_kind: "guiding",
      queryTransform: (m) => `ShellCheck rule SC${m[1]}`,
    },
    {
      name: "bash_syntax_error",
      regex: /\bsyntax error\b.*?(?:unexpected|near)\s+[`'"](.*?)[`'"]/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Bash syntax error near "${m[1]}"`,
    },
  ],
  verificationCommands: [
    { tool: "shellcheck", command: "shellcheck -x *.sh", description: "Lint shell scripts" },
    { tool: "bash-syntax", command: "bash -n script.sh", description: "Check shell syntax" },
  ],
  fixRecipes: [
    {
      errorFamily: "unquoted_variable",
      template: "Wrap the variable expansion in double quotes: \"$var\" in {file}.",
      description: "Variable expansion not quoted — risks word splitting and globbing",
    },
    {
      errorFamily: "missing_cd_check",
      template: "Add `|| exit` after `cd` to handle directory change failures in {file}.",
      description: "cd command used without checking its exit status",
    },
    {
      errorFamily: "deprecated_syntax",
      template: "Replace with the modern syntax suggested by ShellCheck.",
      description: "Deprecated Bash/POSIX syntax used",
    },
  ],
  corpusPackId: "lang-bash",
};
