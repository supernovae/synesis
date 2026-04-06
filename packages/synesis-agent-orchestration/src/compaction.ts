import type { ExecutionContextSummary, ProjectInstructionSet } from "./types.js";
import { PROJECT_INSTRUCTION_SOURCES } from "./constants.js";

interface NormalizeInputs {
  agentsMd?: string;
  claudeMd?: string;
  internalInstructions?: string[];
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function normalizeProjectInstructions(inputs: NormalizeInputs): ProjectInstructionSet {
  const sections: Array<{ source: string; content: string }> = [];
  if (inputs.agentsMd?.trim()) {
    sections.push({ source: PROJECT_INSTRUCTION_SOURCES.agents, content: normalizeText(inputs.agentsMd) });
  }
  if (inputs.claudeMd?.trim()) {
    sections.push({ source: PROJECT_INSTRUCTION_SOURCES.claude, content: normalizeText(inputs.claudeMd) });
  }
  for (const item of inputs.internalInstructions ?? []) {
    if (item.trim().length === 0) continue;
    sections.push({ source: PROJECT_INSTRUCTION_SOURCES.internal, content: normalizeText(item) });
  }
  const normalized = sections.map((s) => `## ${s.source}\n${s.content}`).join("\n\n");
  return { normalized, sections };
}

export function buildCachedPromptPrefix(args: {
  stableSystemPolicy: string;
  schemas: string;
  toolSemantics: string;
  instructionSet: ProjectInstructionSet;
}): string {
  return [
    "<stable_policy>",
    args.stableSystemPolicy.trim(),
    "</stable_policy>",
    "<schemas>",
    args.schemas.trim(),
    "</schemas>",
    "<tool_semantics>",
    args.toolSemantics.trim(),
    "</tool_semantics>",
    "<project_instructions>",
    args.instructionSet.normalized,
    "</project_instructions>",
  ].join("\n");
}

export function compactExecutionContext(input: {
  objective: string;
  assumptions: string[];
  unresolvedQuestions: string[];
  artifactRefs: string[];
  maxLength?: number;
}): ExecutionContextSummary {
  const maxLength = input.maxLength ?? 1_200;
  const summaryRaw = [
    `Objective: ${input.objective}`,
    input.assumptions.length > 0 ? `Assumptions: ${input.assumptions.join("; ")}` : "",
    input.unresolvedQuestions.length > 0 ? `Open: ${input.unresolvedQuestions.join("; ")}` : "",
    input.artifactRefs.length > 0 ? `Artifacts: ${input.artifactRefs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  const summary = summaryRaw.length > maxLength ? `${summaryRaw.slice(0, maxLength - 3)}...` : summaryRaw;
  return {
    summary,
    assumptions: input.assumptions,
    unresolvedQuestions: input.unresolvedQuestions,
    artifactRefs: input.artifactRefs,
  };
}
