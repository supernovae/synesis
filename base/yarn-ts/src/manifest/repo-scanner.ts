import {
  ProjectManifestSchema,
  type ProjectManifest,
  type ProjectKind,
  type ExpectedFile,
  type ExpectedDirectory,
  type RecommendedTool,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// File-path based project detection
// ---------------------------------------------------------------------------

interface DetectionRule {
  pattern: RegExp;
  language: string;
  kind: ProjectKind;
  framework?: string;
}

const DETECTION_RULES: readonly DetectionRule[] = [
  { pattern: /\bgo\.mod\b/, language: "go", kind: "go_cli" },
  { pattern: /\bcmd\/.*\/main\.go\b/, language: "go", kind: "go_cli" },
  { pattern: /\binternal\/server\//, language: "go", kind: "go_http_service" },
  { pattern: /\binternal\/http\//, language: "go", kind: "go_http_service" },
  { pattern: /\bpackage\.json\b/, language: "typescript", kind: "typescript_library" },
  { pattern: /\btsconfig\.json\b/, language: "typescript", kind: "typescript_library" },
  { pattern: /\bpyproject\.toml\b/, language: "python", kind: "python_library" },
  { pattern: /\brequirements\.txt\b/, language: "python", kind: "python_library" },
  { pattern: /\bCargo\.toml\b/, language: "rust", kind: "unknown" },
  { pattern: /\b.*\.tf\b/, language: "hcl", kind: "terraform_iac" },
  { pattern: /\bvariables\.tf\b/, language: "hcl", kind: "terraform_iac" },
  { pattern: /\bChart\.ya?ml\b/, language: "yaml", kind: "helm_chart" },
  { pattern: /\bContainerfile\b|\bDockerfile\b/, language: "dockerfile", kind: "container_image" },
  { pattern: /\bMakefile\b/, language: "make", kind: "unknown" },
];

const FRAMEWORK_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/cobra/, "cobra"],
  [/fastify/, "fastify"],
  [/express/, "express"],
  [/fastapi/, "fastapi"],
  [/flask/, "flask"],
  [/django/, "django"],
  [/net\/http/, "net/http"],
  [/gin/, "gin"],
  [/terraform/, "terraform"],
  [/azurerm/, "azurerm"],
];

/**
 * Future (multi-module Go): scan `filePaths` for multiple `go.mod` roots and emit
 * per-module verification hints (e.g. `go test -C services/foo ./...`) or populate
 * `relevantDirectories` on the working frame. `TOOL_HINTS` below use generic `./...`
 * for typical single-module layouts.
 */
const TOOL_HINTS: ReadonlyArray<[RegExp, RecommendedTool]> = [
  [/go test/, { name: "go test", purpose: "Unit tests", command: "go test ./...", required: true }],
  [/go vet/, { name: "go vet", purpose: "Static checks", command: "go vet ./...", required: true }],
  [/golangci-lint/, { name: "golangci-lint", purpose: "Linting", command: "golangci-lint run", required: false }],
  [/pytest/, { name: "pytest", purpose: "Testing", command: "pytest", required: true }],
  [/ruff/, { name: "ruff", purpose: "Linting", command: "ruff check", required: false }],
  [/vitest/, { name: "vitest", purpose: "Testing", command: "vitest run", required: true }],
  [/eslint/, { name: "eslint", purpose: "Linting", command: "eslint .", required: false }],
  [/terraform fmt/, { name: "terraform fmt", purpose: "Formatting", command: "terraform fmt -recursive", required: true }],
  [/terraform validate/, { name: "terraform validate", purpose: "Validation", command: "terraform validate", required: true }],
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface ScanInput {
  filePaths: string[];
  conversationText?: string;
}

export function scanForManifest(input: ScanInput): ProjectManifest {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const tools: RecommendedTool[] = [];
  const seenToolNames = new Set<string>();
  const kindVotes = new Map<ProjectKind, number>();

  const allText = [
    ...input.filePaths,
    input.conversationText ?? "",
  ].join("\n").toLowerCase();

  for (const rule of DETECTION_RULES) {
    for (const fp of input.filePaths) {
      if (rule.pattern.test(fp)) {
        languages.add(rule.language);
        kindVotes.set(rule.kind, (kindVotes.get(rule.kind) ?? 0) + 1);
        if (rule.framework) frameworks.add(rule.framework);
      }
    }
  }

  for (const [re, fw] of FRAMEWORK_HINTS) {
    if (re.test(allText)) frameworks.add(fw);
  }

  for (const [re, tool] of TOOL_HINTS) {
    if (re.test(allText) && !seenToolNames.has(tool.name)) {
      tools.push(tool);
      seenToolNames.add(tool.name);
    }
  }

  let bestKind: ProjectKind = "unknown";
  let bestVotes = 0;
  for (const [kind, votes] of kindVotes) {
    if (votes > bestVotes && kind !== "unknown") {
      bestKind = kind;
      bestVotes = votes;
    }
  }

  // Refine go_cli vs go_http_service based on directory structure
  if (bestKind === "go_cli" && kindVotes.has("go_http_service")) {
    const httpVotes = kindVotes.get("go_http_service") ?? 0;
    if (httpVotes >= bestVotes) bestKind = "go_http_service";
  }

  const observedFiles: ExpectedFile[] = input.filePaths.slice(0, 50).map((p) => ({
    path: p,
    required: false,
    purpose: "",
    status: "present" as const,
  }));

  const dirs = new Set<string>();
  for (const fp of input.filePaths) {
    const parts = fp.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/") + "/");
    }
  }
  const observedDirs: ExpectedDirectory[] = [...dirs].slice(0, 30).map((d) => ({
    path: d,
    required: false,
    purpose: "",
    status: "present" as const,
  }));

  return ProjectManifestSchema.parse({
    projectName: "",
    detectedKind: bestKind,
    confidence: Math.min(1, bestVotes * 0.2),
    languages: [...languages],
    frameworks: [...frameworks],
    summary: "",
    expectedFiles: observedFiles,
    expectedDirectories: observedDirs,
    recommendedTools: tools,
    documentationPatterns: [],
    codingPatterns: [],
    styleRules: [],
    observedStrengths: [],
    observedGaps: [],
    source: "observed",
  });
}
