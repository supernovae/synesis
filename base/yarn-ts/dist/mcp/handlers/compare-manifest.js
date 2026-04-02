import { z } from "zod";
import { ProjectManifestSchema } from "@synesis/manifest";
import { compareManifests } from "../../manifest/comparator.js";
import { critiquStructure } from "../../manifest/structural-critic.js";
const InputSchema = z.object({
    target: ProjectManifestSchema.describe("The target (ideal) project manifest"),
    observed: ProjectManifestSchema.describe("The observed (actual) project manifest"),
    includeStructuralCritique: z.boolean().default(true).describe("Include deterministic structural critique"),
});
export const compareManifestTool = {
    name: "synesis_compare_manifest",
    description: "Compare an observed project manifest against a target manifest. " +
        "Returns missing files, directories, tools, doc sections, and a structural score.",
    inputSchema: InputSchema,
    handler(input) {
        const comparison = compareManifests(input.target, input.observed);
        const result = { comparison };
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
