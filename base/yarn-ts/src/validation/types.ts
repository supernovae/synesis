export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationFamily =
  | "typescript"
  | "eslint"
  | "ruff"
  | "pytest"
  | "generic";

export interface ValidationFinding {
  family: ValidationFamily;
  severity: ValidationSeverity;
  file?: string;
  line?: number;
  excerpt?: string;
  message: string;
  likelyFix?: string;
}

export interface ValidationEnvelope {
  family: ValidationFamily;
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
