/**
 * Deterministic structural critic — no LLM.
 * Checks a ManifestComparison for required and recommended gaps.
 */
export function critiquStructure(comparison) {
    const requirements = [];
    for (const f of comparison.missingFiles) {
        requirements.push({
            path: f.path,
            required: f.required,
            purpose: f.purpose,
            status: "missing",
        });
    }
    for (const d of comparison.missingDirectories) {
        requirements.push({
            path: d.path,
            required: d.required,
            purpose: d.purpose,
            status: "missing",
        });
    }
    for (const tool of comparison.missingTools) {
        if (tool.required) {
            requirements.push({
                path: tool.command || tool.name,
                required: true,
                purpose: `Tool: ${tool.purpose}`,
                status: "missing",
            });
        }
    }
    for (const section of comparison.missingDocSections) {
        requirements.push({
            path: section,
            required: true,
            purpose: "Documentation section",
            status: "missing",
        });
    }
    const requiredMissing = requirements.filter((r) => r.required).length;
    const recommendedMissing = requirements.filter((r) => !r.required).length;
    const passed = requiredMissing === 0;
    const parts = [];
    if (passed) {
        parts.push("All required structural elements present.");
    }
    else {
        parts.push(`${requiredMissing} required element(s) missing.`);
    }
    if (recommendedMissing > 0) {
        parts.push(`${recommendedMissing} recommended element(s) missing.`);
    }
    return {
        passed,
        requirements,
        requiredMissing,
        recommendedMissing,
        score: comparison.structuralScore,
        summary: parts.join(" "),
    };
}
