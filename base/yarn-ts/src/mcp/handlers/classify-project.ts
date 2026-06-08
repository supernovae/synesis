import { z } from "zod";
import { ClassificationResultSchema, ComplexityAssessmentSchema } from "@synesis/manifest";
import { classify } from "../../manifest/classifier.js";
import type { McpToolDefinition } from "../tool-registry.js";

const InputSchema = z.object({
  task: z.string().min(1).max(16_000).describe("The task or prompt to classify"),
  fileCount: z.number().int().min(0).optional().describe("Number of files in the project (helps complexity assessment)"),
}).strict();

type Input = z.infer<typeof InputSchema>;
type Output = {
  classification: z.infer<typeof ClassificationResultSchema>;
  complexity: z.infer<typeof ComplexityAssessmentSchema>;
};

export const classifyProjectTool: McpToolDefinition<Input, Output> = {
  name: "synesis_classify_project",
  description:
    "Classify a task description into a project kind (go_cli, go_http_service, terraform_iac, etc.) " +
    "and assess its complexity (tiny, small, medium, large). Deterministic, sub-millisecond.",
  inputSchema: InputSchema,
  handler(input) {
    return classify(input.task, input.fileCount);
  },
};
