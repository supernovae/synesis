import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums and primitives
// ---------------------------------------------------------------------------

export const ProjectKind = z.enum([
  "go_cli",
  "go_http_service",
  "go_library",
  "python_service",
  "python_cli",
  "python_library",
  "typescript_service",
  "typescript_cli",
  "typescript_library",
  "terraform_iac",
  "ansible_iac",
  "helm_chart",
  "container_image",
  "unknown",
]);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const Complexity = z.enum(["tiny", "small", "medium", "large"]);
export type Complexity = z.infer<typeof Complexity>;

export const ManifestSource = z.enum(["target", "observed", "compared"]);
export type ManifestSource = z.infer<typeof ManifestSource>;

export const TaskPhase = z.enum(["plan", "implement", "validate", "repair"]);
export type TaskPhase = z.infer<typeof TaskPhase>;

export const TaskType = z.enum([
  "scaffold_project",
  "add_feature",
  "fix_bug",
  "refactor",
  "write_tests",
  "write_docs",
  "explain",
  "review",
  "general",
]);
export type TaskType = z.infer<typeof TaskType>;

export const FileStatus = z.enum(["present", "missing", "misplaced", "recommended"]);
export type FileStatus = z.infer<typeof FileStatus>;

// ---------------------------------------------------------------------------
// Structural building blocks
// ---------------------------------------------------------------------------

export const ExpectedFileSchema = z.object({
  path: z.string().min(1),
  required: z.boolean(),
  purpose: z.string().default(""),
  status: FileStatus.default("recommended"),
});
export type ExpectedFile = z.infer<typeof ExpectedFileSchema>;

export const ExpectedDirectorySchema = z.object({
  path: z.string().min(1),
  required: z.boolean(),
  purpose: z.string().default(""),
  status: FileStatus.default("recommended"),
});
export type ExpectedDirectory = z.infer<typeof ExpectedDirectorySchema>;

export const RecommendedToolSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().default(""),
  command: z.string().default(""),
  required: z.boolean().default(false),
});
export type RecommendedTool = z.infer<typeof RecommendedToolSchema>;

export const DocumentationPatternSchema = z.object({
  name: z.string().min(1),
  required: z.boolean().default(true),
  sections: z.array(z.string()).default([]),
});
export type DocumentationPattern = z.infer<typeof DocumentationPatternSchema>;

export const StructuralRequirementSchema = z.object({
  path: z.string().min(1),
  required: z.boolean(),
  purpose: z.string().default(""),
  status: FileStatus,
});
export type StructuralRequirement = z.infer<typeof StructuralRequirementSchema>;

// ---------------------------------------------------------------------------
// ProjectManifest — "what this project is, or should be"
// ---------------------------------------------------------------------------

export const ProjectManifestSchema = z.object({
  projectName: z.string().default(""),
  detectedKind: ProjectKind.default("unknown"),
  confidence: z.number().min(0).max(1).default(0),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  summary: z.string().default(""),
  expectedFiles: z.array(ExpectedFileSchema).default([]),
  expectedDirectories: z.array(ExpectedDirectorySchema).default([]),
  recommendedTools: z.array(RecommendedToolSchema).default([]),
  documentationPatterns: z.array(DocumentationPatternSchema).default([]),
  codingPatterns: z.array(z.string()).default([]),
  styleRules: z.array(z.string()).default([]),
  observedStrengths: z.array(z.string()).default([]),
  observedGaps: z.array(z.string()).default([]),
  source: ManifestSource.default("observed"),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

// ---------------------------------------------------------------------------
// WorkingFrame — "what we are doing right now"
// ---------------------------------------------------------------------------

export const WorkingFrameSchema = z.object({
  taskId: z.string().default(""),
  userIntent: z.string().default(""),
  taskType: TaskType.default("general"),
  phase: TaskPhase.default("implement"),
  domain: z.string().default(""),
  subdomain: z.string().default(""),
  currentGoal: z.string().default(""),
  nextStep: z.string().default(""),
  relevantFiles: z.array(z.string()).default([]),
  relevantDirectories: z.array(z.string()).default([]),
  relevantManifestFacts: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  validationFocus: z.array(z.string()).default([]),
  doneCriteria: z.array(z.string()).default([]),
  complexity: Complexity.default("small"),
  planRequired: z.boolean().default(false),
});
export type WorkingFrame = z.infer<typeof WorkingFrameSchema>;

// ---------------------------------------------------------------------------
// ClassificationResult — classifier output
// ---------------------------------------------------------------------------

export const ClassificationSignalSchema = z.object({
  keyword: z.string(),
  weight: z.number().default(1),
});
export type ClassificationSignal = z.infer<typeof ClassificationSignalSchema>;

export const ClassificationResultSchema = z.object({
  language: z.string().default("unknown"),
  projectKind: ProjectKind.default("unknown"),
  confidence: z.number().min(0).max(1).default(0),
  signals: z.array(z.string()).default([]),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export const ComplexityAssessmentSchema = z.object({
  complexity: Complexity,
  planRequired: z.boolean(),
  signals: z.array(z.string()).default([]),
});
export type ComplexityAssessment = z.infer<typeof ComplexityAssessmentSchema>;

// ---------------------------------------------------------------------------
// ProjectTemplate — target template for a project kind
// ---------------------------------------------------------------------------

export const ProjectTemplateSchema = z.object({
  kind: ProjectKind,
  description: z.string(),
  classificationSignals: z.array(ClassificationSignalSchema).default([]),
  manifest: ProjectManifestSchema,
});
export type ProjectTemplate = z.infer<typeof ProjectTemplateSchema>;

// ---------------------------------------------------------------------------
// ManifestComparison — observed vs target diff
// ---------------------------------------------------------------------------

export const ManifestComparisonSchema = z.object({
  target: ProjectManifestSchema,
  observed: ProjectManifestSchema,
  missingFiles: z.array(ExpectedFileSchema).default([]),
  missingDirectories: z.array(ExpectedDirectorySchema).default([]),
  extraFiles: z.array(z.string()).default([]),
  missingTools: z.array(RecommendedToolSchema).default([]),
  missingDocSections: z.array(z.string()).default([]),
  gapSummary: z.string().default(""),
  strengthSummary: z.string().default(""),
  structuralScore: z.number().min(0).max(1).default(0),
});
export type ManifestComparison = z.infer<typeof ManifestComparisonSchema>;
