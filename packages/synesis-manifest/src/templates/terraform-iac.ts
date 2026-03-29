import type { ProjectTemplate } from "../schemas.js";

export const terraformIac: ProjectTemplate = {
  kind: "terraform_iac",
  description: "Terraform project with parameterized inputs, reusable modules, and validation-friendly structure.",
  classificationSignals: [
    { keyword: "terraform", weight: 4 },
    { keyword: "hcl", weight: 3 },
    { keyword: "infrastructure", weight: 2 },
    { keyword: "iac", weight: 3 },
    { keyword: "azurerm", weight: 2 },
    { keyword: "aws", weight: 1 },
    { keyword: "provider", weight: 1 },
    { keyword: "module", weight: 1 },
    { keyword: "tfvars", weight: 3 },
    { keyword: "openshift", weight: 1 },
    { keyword: "aro", weight: 2 },
  ],
  manifest: {
    projectName: "",
    detectedKind: "terraform_iac",
    confidence: 0.97,
    languages: ["hcl", "markdown"],
    frameworks: ["terraform"],
    summary: "Terraform project with parameterized inputs, reusable modules, and validation-friendly structure.",
    expectedFiles: [
      { path: "versions.tf", required: true, purpose: "Terraform and provider version constraints", status: "recommended" },
      { path: "providers.tf", required: true, purpose: "Provider definitions", status: "recommended" },
      { path: "main.tf", required: true, purpose: "Root module composition", status: "recommended" },
      { path: "variables.tf", required: true, purpose: "Input variable declarations", status: "recommended" },
      { path: "outputs.tf", required: true, purpose: "Output values", status: "recommended" },
      { path: "README.md", required: true, purpose: "Project overview and usage", status: "recommended" },
      { path: "terraform.tfvars.example", required: false, purpose: "Example input values", status: "recommended" },
    ],
    expectedDirectories: [
      { path: "modules/", required: false, purpose: "Reusable sub-modules", status: "recommended" },
      { path: "examples/", required: false, purpose: "Example configurations", status: "recommended" },
    ],
    recommendedTools: [
      { name: "terraform fmt", purpose: "Formatting", command: "terraform fmt -recursive", required: true },
      { name: "terraform validate", purpose: "Validation", command: "terraform validate", required: true },
      { name: "tflint", purpose: "Linting", command: "tflint", required: false },
    ],
    documentationPatterns: [
      { name: "README", required: true, sections: ["Overview", "Architecture", "Requirements", "Inputs", "Outputs", "Usage", "Validation", "Notes"] },
    ],
    codingPatterns: [
      "Keep provider/version constraints explicit",
      "Describe all input variables",
      "Prefer parameterization over hard-coded values",
      "Keep root module readable and move complexity into modules where appropriate",
    ],
    styleRules: [
      "All variables should include descriptions",
      "README should explain validation and usage",
      "Examples should be easy to copy and adapt",
    ],
    observedStrengths: [],
    observedGaps: [],
    source: "target",
  },
};
