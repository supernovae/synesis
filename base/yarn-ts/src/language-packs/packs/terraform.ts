import { classifyErrorFamily } from "../../validation/enrichment.js";
import type { LanguagePackManifest } from "../types.js";

export const terraformPack: LanguagePackManifest = {
  id: "lang-terraform",
  language: "terraform",
  displayName: "Terraform / HCL",
  version: "1.0.0",
  families: ["terraform", "tfsec"],
  toolSignals: [
    { pattern: /\bterraform\b|\btofu\b|\btf_validate\b/i, family: "terraform" },
    { pattern: /\btfsec\b/i, family: "tfsec" },
  ],
  classifiers: {
    terraform: (msg, ruleId) => classifyErrorFamily("terraform", msg, ruleId),
    tfsec: (msg, ruleId) => classifyErrorFamily("tfsec", msg, ruleId),
  },
  reducerFamilies: ["terraform"],
  fastPathPatterns: [
    {
      name: "terraform_error",
      regex: /\bError:\s*(.*(?:undeclared|unsupported|missing required|invalid).*)/i,
      scope_tags: ["error-catalog"],
      constraint_kind: "hard",
      queryTransform: (m) => `Terraform error: ${m[1].slice(0, 80)}`,
    },
  ],
  verificationCommands: [
    { tool: "terraform-validate", command: "terraform validate", description: "Validate configuration" },
    { tool: "terraform-plan", command: "terraform plan -no-color", description: "Preview changes" },
    { tool: "terraform-fmt", command: "terraform fmt -check -recursive", description: "Check formatting" },
    { tool: "tfsec", command: "tfsec .", description: "Security scan" },
  ],
  fixRecipes: [
    {
      errorFamily: "undeclared_variable",
      template: "Add the variable declaration to variables.tf: variable \"{name}\" {{ type = string }}",
      description: "Input variable referenced but not declared",
    },
    {
      errorFamily: "missing_required_argument",
      template: "Add the missing required argument to the block in {file}.",
      description: "A required attribute or module input is missing",
    },
    {
      errorFamily: "type_mismatch",
      template: "Check the attribute value type against the provider schema in {file}.",
      description: "Value type does not match resource/variable expectation",
    },
    {
      errorFamily: "provider_configuration",
      template: "Check the provider block and required_providers — ensure credentials and region are set.",
      description: "Provider settings or required inputs are incomplete",
    },
    {
      errorFamily: "dependency_cycle",
      template: "Break the circular dependency — use depends_on explicitly or restructure modules.",
      description: "Resources form a circular dependency",
    },
  ],
  corpusPackId: "lang-terraform",
};
