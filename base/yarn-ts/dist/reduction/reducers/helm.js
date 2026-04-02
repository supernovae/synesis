export class HelmReducer {
    family = "helm";
    reduce(input) {
        const lines = input.raw.split("\n");
        const errors = [];
        const resources = [];
        let releaseName = "";
        let status = "";
        let notes = false;
        const noteLines = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^NAME:\s+/.test(trimmed)) {
                releaseName = trimmed;
            }
            else if (/^STATUS:\s+/.test(trimmed)) {
                status = trimmed;
            }
            else if (/^Error:/.test(trimmed) || /^error:/.test(trimmed)) {
                errors.push(trimmed);
            }
            else if (/^==> v1\//.test(trimmed) || /^(deployment|service|configmap|secret|ingress|pod|statefulset)/i.test(trimmed)) {
                resources.push(trimmed);
            }
            else if (/^NOTES:/.test(trimmed)) {
                notes = true;
            }
            else if (notes && trimmed) {
                noteLines.push(trimmed);
            }
        }
        if (!releaseName && errors.length === 0 && resources.length === 0)
            return null;
        const parts = [`<TOOL_REDUCED family="helm">`];
        if (releaseName)
            parts.push(releaseName);
        if (status)
            parts.push(status);
        if (errors.length > 0) {
            parts.push(`errors (${errors.length}):`);
            errors.slice(0, 5).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
        }
        if (resources.length > 0) {
            parts.push(`resources (${resources.length}):`);
            resources.slice(0, 10).forEach((r) => parts.push(`  ${r}`));
        }
        if (noteLines.length > 0) {
            parts.push("notes (first 3 lines):");
            noteLines.slice(0, 3).forEach((n) => parts.push(`  ${n}`));
        }
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.88, actionableCount: errors.length, summary: parts.join("\n") };
    }
}
