import { z } from "zod";
import { ProjectKind, getTemplate } from "@synesis/manifest";
const InputSchema = z.object({
    projectKind: ProjectKind.describe("The project kind to scaffold"),
    projectName: z.string().optional().describe("Name for the project (substituted into file paths)"),
});
export const scaffoldTool = {
    name: "synesis_scaffold",
    description: "Return the target template for a project kind, including expected files, directories, " +
        "tools, documentation patterns, and coding conventions.",
    inputSchema: InputSchema,
    handler(input) {
        const template = getTemplate(input.projectKind);
        if (!template) {
            return {
                kind: input.projectKind,
                found: false,
                error: `No template found for project kind: ${input.projectKind}`,
            };
        }
        const result = { ...template };
        if (input.projectName) {
            result.manifest = {
                ...result.manifest,
                projectName: input.projectName,
                expectedFiles: result.manifest.expectedFiles.map((f) => ({
                    ...f,
                    path: f.path.replace(/\{name\}/g, input.projectName),
                })),
            };
        }
        return { kind: input.projectKind, found: true, template: result };
    },
};
