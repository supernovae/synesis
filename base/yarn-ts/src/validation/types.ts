export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationFamily =
  | "typescript"
  | "eslint"
  | "ruff"
  | "pytest"
  | "mypy"
  | "pylint"
  | "jest"
  | "cargo"
  | "go"
  | "golangci-lint"
  | "terraform"
  | "tfsec"
  | "trivy"
  | "semgrep"
  | "shellcheck"
  | "rubocop"
  | "cppcheck"
  | "java"
  | "dotnet"
  | "sqlfluff"
  | "yamllint"
  | "generic";

export type ValidationOutputFormat = "sarif" | "junit" | "checkstyle" | "json" | "text";

export interface ValidationFinding {
  family: ValidationFamily;
  severity: ValidationSeverity;
  file?: string;
  line?: number;
  column?: number;
  ruleId?: string;
  errorFamily?: string;
  excerpt?: string;
  message: string;
  likelyFix?: string;
  likelyRootCause?: string;
  suggestedNextAction?: string;
  rawFingerprint?: string;
  isRepeat?: boolean;
}

export interface ValidationEnvelope {
  family: ValidationFamily;
  outputFormat: ValidationOutputFormat;
  findings: ValidationFinding[];
  rawChars: number;
  normalizedChars: number;
  truncated: boolean;
  artifactHandle?: string;
  summary: string;
}

export interface ValidationNormalizerInput {
  toolName?: string;
  rawOutput: string;
  maxFindings: number;
  maxExcerptChars: number;
}

export interface AdmissionPolicyConfig {
  maxRawChars: number;
  maxFindings: number;
  includeRaw: boolean;
}

export interface AdmissionPolicyResult {
  contentForModel: string;
  envelope: ValidationEnvelope;
  droppedChars: number;
  usedArtifactHandle: boolean;
}
