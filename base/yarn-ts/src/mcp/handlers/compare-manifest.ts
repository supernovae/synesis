import { z } from "zod";
import { ProjectManifestSchema, ManifestComparisonSchema } from "../../manifest/schemas.js";
import { compareManifests } from "../../manifest/comparator.js";
import { critiquStructure } from "../../manifest/structural-critic.js";
import type { McpToolDefinition } from "../tool-registry.js";

const InputSchema = z.object({
  target: ProjectManifestSchema.describe("The target (ideal) project manifest"),
  observed: ProjectManifestSchema.describe("The observed (actual) project manifest"),
  includeStructuralCritique: z.boolean().default(true).describe("Include deterministic structural critique"),
}).strict();

type Input = z.infer<typeof InputSchema>;

interface CompareOutput {
  comparison: z.infer<typeof ManifestComparisonSchema>;
  critique?: {
    passed: boolean;
    requiredMissing: number;
    recommendedMissing: number;
    score: number;
    summary: string;
  };
}

export const compareManifestTool: McpToolDefinition<Input, CompareOutput> = {
  name: "synesis_compare_manifest",
  description:
    "Compare an observed project manifest against a target manifest. " +
    "Returns missing files, directories, tools, doc sections, and a structural score.",
  inputSchema: InputSchema,
  handler(input) {
    const comparison = compareManifests(input.target, input.observed);
    const result: CompareOutput = { comparison };

    if (input.includeStructuralCritique) {
      const critique = critiquStructure(comparison);
      result.critique = {
        passed: critique.passed,
        requiredMissing: critique.requiredMissing,
        recommendedMissing: critique.recommendedMissing,
        score: critique.score,
        summary: critique.summary,
      };
    }

    return result;
  },
};
