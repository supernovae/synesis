import { classifyErrorFamily } from "../../validation/enrichment.js";
export const terraformPack = {
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
        {
            errorFamily: "undeclared_resource",
            template: "Define the resource, wire module outputs, or configure the provider for the reference in {file}.",
            description: "Resource referenced but not defined.",
            steps: [
                "Verify resource block exists",
                "Check module outputs",
                "Verify provider is configured",
            ],
            constraints: "Use data sources for external resources.",
        },
        {
            errorFamily: "unsupported_argument",
            template: "In {file}: align arguments with the provider schema — remove or rename invalid attributes.",
            description: "Block contains an argument the resource doesn't accept.",
            steps: [
                "Check provider docs for valid arguments",
                "Verify provider version",
                "Remove invalid argument",
            ],
            constraints: "Pin provider versions.",
        },
        {
            errorFamily: "invalid_reference",
            template: "Fix the expression in {file}: correct typos, ensure the resource or data source exists, and review depends_on.",
            description: "Expression references something that cannot be resolved.",
            steps: [
                "Check for typos",
                "Verify resource/data source exists",
                "Check depends_on",
            ],
            constraints: "Prefer implicit over explicit depends_on.",
        },
        {
            errorFamily: "syntax_error",
            template: "Run terraform fmt, fix missing quotes/braces in {file}, then terraform validate.",
            description: "HCL syntax error in configuration file.",
            steps: [
                "Run terraform fmt",
                "Check for missing quotes/braces",
                "Validate with terraform validate",
            ],
            constraints: "Always fmt before commit.",
        },
        {
            errorFamily: "duplicate_resource",
            template: "Rename one resource in {file}, use for_each for repeated shapes, or resolve module naming conflicts.",
            description: "Two resources share the same type and name.",
            steps: [
                "Rename one resource",
                "Use for_each for similar resources",
                "Check modules for conflicts",
            ],
            constraints: "Use descriptive names.",
        },
    ],
    corpusPackId: "lang-terraform",
};
