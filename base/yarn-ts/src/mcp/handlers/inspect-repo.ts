import { z } from "zod";
import { ProjectManifestSchema } from "@synesis/manifest";
import { scanForManifest } from "../../manifest/repo-scanner.js";
import type { McpToolDefinition } from "../tool-registry.js";

const InputSchema = z.object({
  filePaths: z.array(z.string()).min(1).describe("List of file paths in the repository"),
  conversationText: z.string().optional().describe("Additional context from conversation"),
});

type Input = z.infer<typeof InputSchema>;

export const inspectRepoTool: McpToolDefinition<Input, z.infer<typeof ProjectManifestSchema>> = {
  name: "synesis_inspect_repo",
  description:
    "Generate an observed project manifest from a list of file paths. " +
    "Detects language, project kind, frameworks, and tools from file structure.",
  inputSchema: InputSchema,
  handler(input) {
    return scanForManifest(input);
  },
};
