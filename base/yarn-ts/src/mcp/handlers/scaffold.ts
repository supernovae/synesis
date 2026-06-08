import { z } from "zod";
import { ProjectKind, ProjectTemplateSchema, getTemplate } from "@synesis/manifest";
import type { McpToolDefinition } from "../tool-registry.js";

const InputSchema = z.object({
  projectKind: ProjectKind.describe("The project kind to scaffold"),
  projectName: z.string().min(1).max(128).optional().describe("Name for the project (substituted into file paths)"),
}).strict();

type Input = z.infer<typeof InputSchema>;

interface ScaffoldOutput {
  kind: string;
  found: boolean;
  template?: z.infer<typeof ProjectTemplateSchema>;
  error?: string;
}

export const scaffoldTool: McpToolDefinition<Input, ScaffoldOutput> = {
  name: "synesis_scaffold",
  description:
    "Return the target template for a project kind, including expected files, directories, " +
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
          path: f.path.replace(/\{name\}/g, input.projectName!),
        })),
      };
    }

    return { kind: input.projectKind, found: true, template: result };
  },
};
