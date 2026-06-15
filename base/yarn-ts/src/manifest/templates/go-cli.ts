import type { ProjectTemplate } from "../schemas.js";

export const goCli: ProjectTemplate = {
  kind: "go_cli",
  description: "Go command-line application with subcommands, config support, and structured terminal output.",
  classificationSignals: [
    { keyword: "cli", weight: 3 },
    { keyword: "command", weight: 2 },
    { keyword: "cobra", weight: 3 },
    { keyword: "flags", weight: 2 },
    { keyword: "subcommands", weight: 3 },
    { keyword: "terminal", weight: 1 },
    { keyword: "single binary", weight: 2 },
    { keyword: "stdout", weight: 1 },
  ],
  manifest: {
    projectName: "",
    detectedKind: "go_cli",
    confidence: 0.95,
    languages: ["go", "markdown"],
    frameworks: ["cobra"],
    summary: "Go command-line application with subcommands, config support, and structured terminal output.",
    expectedFiles: [
      { path: "go.mod", required: true, purpose: "Go module definition", status: "recommended" },
      { path: "cmd/{name}/main.go", required: true, purpose: "CLI entrypoint", status: "recommended" },
      { path: "internal/cli/root.go", required: true, purpose: "Root command wiring", status: "recommended" },
      { path: "internal/cli/version.go", required: false, purpose: "Version command", status: "recommended" },
      { path: "README.md", required: true, purpose: "Usage and installation documentation", status: "recommended" },
      { path: ".gitignore", required: true, purpose: "Git ignore patterns", status: "recommended" },
      { path: "Makefile", required: false, purpose: "Build/test/lint convenience commands", status: "recommended" },
    ],
    expectedDirectories: [
      { path: "cmd/", required: true, purpose: "Entrypoints", status: "recommended" },
      { path: "internal/cli/", required: true, purpose: "Command definitions and CLI logic", status: "recommended" },
      { path: "internal/config/", required: false, purpose: "Configuration loading", status: "recommended" },
      { path: "test/", required: false, purpose: "Integration or end-to-end tests", status: "recommended" },
    ],
    recommendedTools: [
      { name: "go test", purpose: "Unit testing", command: "go test ./...", required: true },
      { name: "go vet", purpose: "Static checks", command: "go vet ./...", required: true },
      { name: "golangci-lint", purpose: "Linting", command: "golangci-lint run", required: false },
    ],
    documentationPatterns: [
      { name: "README", required: true, sections: ["Overview", "Installation", "Usage", "Commands", "Configuration", "Examples", "Development"] },
    ],
    codingPatterns: [
      "Keep command wiring separate from business logic",
      "Prefer explicit flag definitions and help text",
      "Return errors upward instead of calling os.Exit deep in logic",
      "Keep main.go thin",
    ],
    styleRules: [
      "All flags should have clear descriptions",
      "README should include example invocations",
      "Version/build info should be easy to inject at build time",
    ],
    observedStrengths: [],
    observedGaps: [],
    source: "target",
  },
};
