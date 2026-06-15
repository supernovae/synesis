import {
  ProjectManifestSchema,
  type ProjectManifest,
  type ManifestComparison,
  type ExpectedFile,
  type ExpectedDirectory,
  type RecommendedTool,
} from "./schemas.js";

/**
 * Compare an observed manifest against a target manifest.
 * All logic is deterministic set-diff — no LLM calls.
 * Both inputs are parsed through the schema to fill defaults for partial objects.
 */
export function compareManifests(
  targetRaw: ProjectManifest,
  observedRaw: ProjectManifest,
): ManifestComparison {
  const target = ProjectManifestSchema.parse(targetRaw);
  const observed = ProjectManifestSchema.parse(observedRaw);

  const tFiles = target.expectedFiles;
  const oFiles = observed.expectedFiles;
  const tDirs = target.expectedDirectories;
  const oDirs = observed.expectedDirectories;
  const tTools = target.recommendedTools;
  const oTools = observed.recommendedTools;

  const observedPaths = new Set(oFiles.map((f) => normalizePath(f.path)));
  const targetPaths = new Set(tFiles.map((f) => normalizePath(f.path)));

  const missingFiles: ExpectedFile[] = tFiles.filter(
    (f) => !observedPaths.has(normalizePath(f.path)),
  );

  const extraFiles = [...observedPaths].filter((p) => !targetPaths.has(p));

  const observedDirPaths = new Set(oDirs.map((d) => normalizePath(d.path)));
  const missingDirectories: ExpectedDirectory[] = tDirs.filter(
    (d) => !observedDirPaths.has(normalizePath(d.path)),
  );

  const observedToolNames = new Set(oTools.map((t) => t.name.toLowerCase()));
  const missingTools: RecommendedTool[] = tTools.filter(
    (t) => !observedToolNames.has(t.name.toLowerCase()),
  );

  const missingDocSections = findMissingDocSections(target, observed);

  const totalTargetItems = tFiles.length + tDirs.length + tTools.length;
  const missingCount =
    missingFiles.length + missingDirectories.length + missingTools.length;
  const structuralScore =
    totalTargetItems > 0
      ? Math.round(((totalTargetItems - missingCount) / totalTargetItems) * 100) / 100
      : 1;

  const requiredMissing = missingFiles.filter((f) => f.required);
  const optionalMissing = missingFiles.filter((f) => !f.required);

  const gapParts: string[] = [];
  if (requiredMissing.length > 0)
    gapParts.push(`${requiredMissing.length} required file(s) missing`);
  if (optionalMissing.length > 0)
    gapParts.push(`${optionalMissing.length} recommended file(s) missing`);
  if (missingDirectories.length > 0)
    gapParts.push(`${missingDirectories.length} directory(ies) missing`);
  if (missingTools.length > 0)
    gapParts.push(`${missingTools.length} tool(s) not detected`);
  if (missingDocSections.length > 0)
    gapParts.push(`${missingDocSections.length} doc section(s) missing`);

  const strengthParts: string[] = [];
  if (extraFiles.length > 0)
    strengthParts.push(`${extraFiles.length} extra file(s) beyond template`);
  if (observed.frameworks.length > 0)
    strengthParts.push(`Frameworks detected: ${observed.frameworks.join(", ")}`);
  if (observed.recommendedTools.length > 0)
    strengthParts.push(`${observed.recommendedTools.length} tool(s) detected`);

  return {
    target,
    observed,
    missingFiles,
    missingDirectories,
    extraFiles,
    missingTools,
    missingDocSections,
    gapSummary: gapParts.join("; ") || "No gaps detected",
    strengthSummary: strengthParts.join("; ") || "No strengths observed yet",
    structuralScore,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\{[^}]+\}/g, "*").replace(/\/+$/, "").toLowerCase();
}

function findMissingDocSections(
  target: ProjectManifest,
  observed: ProjectManifest,
): string[] {
  const missing: string[] = [];
  for (const pattern of target.documentationPatterns ?? []) {
    if (!pattern.required) continue;
    const obsPattern = (observed.documentationPatterns ?? []).find(
      (p) => p.name.toLowerCase() === pattern.name.toLowerCase(),
    );
    if (!obsPattern) {
      missing.push(...pattern.sections.map((s) => `${pattern.name}:${s}`));
      continue;
    }
    const obsSections = new Set(obsPattern.sections.map((s) => s.toLowerCase()));
    for (const section of pattern.sections) {
      if (!obsSections.has(section.toLowerCase())) {
        missing.push(`${pattern.name}:${section}`);
      }
    }
  }
  return missing;
}
