import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const yamlK8sPack: LanguagePackManifest = {
  id: "lang-yaml-k8s",
  language: "yaml-k8s",
  displayName: "YAML / Kubernetes",
  version: "1.0.0",
  families: ["yamllint"],
  toolSignals: [
    { pattern: /\byamllint\b/i, family: "yamllint" },
    { pattern: /\bhelm\b|\bkubectl\b|\boc\b|\bansible\b/i, family: "yamllint" },
  ],
  classifiers: {
    yamllint: (msg, ruleId) => classifyErrorFamily("yamllint", msg, ruleId),
  },
  reducerFamilies: ["helm", "kubectl", "oc", "ansible"],
  fastPathPatterns: [
    {
      name: "k8s_api_error",
      regex: /\bError from server\b.*?:\s*(.+)/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Kubernetes API error: ${m[1].slice(0, 80)}`,
    },
    {
      name: "helm_render_error",
      regex: /\bError:\s*(?:template|render|parse)\b.*?:\s*(.+)/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Helm template error: ${m[1].slice(0, 80)}`,
    },
  ],
  verificationCommands: [
    { tool: "kubectl-dry-run", command: "kubectl apply --dry-run=client -f .", description: "Validate K8s manifests" },
    { tool: "helm-lint", command: "helm lint .", description: "Lint Helm chart" },
    { tool: "yamllint", command: "yamllint .", description: "Lint YAML files" },
    { tool: "kubeconform", command: "kubeconform -strict .", description: "Validate K8s schemas" },
  ],
  fixRecipes: [
    {
      errorFamily: "indentation",
      template: "Fix the indentation to use consistent 2-space indent in {file}.",
      description: "YAML indentation does not match expected level",
    },
    {
      errorFamily: "syntax_error",
      template: "Fix the YAML syntax — check for incorrect indentation, unquoted special characters, or unclosed strings.",
      description: "YAML file contains a syntax error",
    },
    {
      errorFamily: "duplicate_key",
      template: "Remove the duplicate mapping key in {file} — only the last value is used.",
      description: "Duplicate key in YAML mapping",
    },
    {
      errorFamily: "truthy_value",
      template: "Quote boolean-like strings or use YAML true/false for booleans in {file}.",
      description: "Unquoted boolean-like value (yes/no/on/off) in YAML.",
      steps: [
        "Quote the value as a string",
        "Use true/false for booleans",
      ],
      constraints: "Always quote strings that look boolean.",
    },
    {
      errorFamily: "line_length",
      template: "Use folded (>) or literal (|) block scalars to wrap long lines in {file}.",
      description: "Line exceeds configured maximum character width.",
      steps: [
        "Use YAML folded (>) or literal (|) block scalars",
        "Break long strings",
      ],
      constraints: "Prefer block scalars for long values.",
    },
    {
      errorFamily: "trailing_spaces",
      template: "Trim trailing whitespace and enable strip-on-save in your editor for {file}.",
      description: "Trailing whitespace detected.",
      steps: [
        "Trim trailing spaces",
        "Configure editor to strip on save",
      ],
      constraints: "Use EditorConfig or yamllint.",
    },
    {
      errorFamily: "document_start",
      template: "Add --- at the beginning of the YAML document in {file}.",
      description: "Missing document start marker (---) at beginning.",
      steps: ["Add --- at the start of the YAML document"],
      constraints: "Always include --- for multi-document files.",
    },
  ],
  corpusPackId: "lang-yaml-k8s",
};
