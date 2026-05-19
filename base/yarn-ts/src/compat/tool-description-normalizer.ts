export const TOOL_DESCRIPTION_MAX_CHARS = 4096;

export interface ToolDescriptionTruncation {
  endpoint: string;
  path: string;
  toolIndex: number;
  toolName?: string;
  originalLength: number;
  maxLength: number;
}

export interface ToolDescriptionNormalizationResult<T = unknown> {
  body: T;
  truncations: ToolDescriptionTruncation[];
}

type ToolShape = "openai" | "claude" | "responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function capDescription(
  value: unknown,
  path: string,
  toolIndex: number,
  toolName: string | undefined,
  endpoint: string,
  truncations: ToolDescriptionTruncation[],
): unknown {
  if (typeof value !== "string" || value.length <= TOOL_DESCRIPTION_MAX_CHARS) {
    return value;
  }
  truncations.push({
    endpoint,
    path,
    toolIndex,
    toolName,
    originalLength: value.length,
    maxLength: TOOL_DESCRIPTION_MAX_CHARS,
  });
  return value.slice(0, TOOL_DESCRIPTION_MAX_CHARS);
}

function normalizeTool(tool: unknown, index: number, shape: ToolShape, endpoint: string, truncations: ToolDescriptionTruncation[]): unknown {
  if (!isRecord(tool)) return tool;

  if (shape === "openai" || (shape === "responses" && isRecord(tool.function))) {
    const fn = tool.function;
    if (!isRecord(fn)) return tool;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    const description = capDescription(
      fn.description,
      `tools.${index}.function.description`,
      index,
      name,
      endpoint,
      truncations,
    );
    if (description === fn.description) return tool;
    return { ...tool, function: { ...fn, description } };
  }

  const name = typeof tool.name === "string" ? tool.name : undefined;
  const description = capDescription(
    tool.description,
    `tools.${index}.description`,
    index,
    name,
    endpoint,
    truncations,
  );
  if (description === tool.description) return tool;
  return { ...tool, description };
}

export function normalizeToolDescriptions<T = unknown>(
  body: T,
  shape: ToolShape,
  endpoint: string,
): ToolDescriptionNormalizationResult<T> {
  if (!isRecord(body) || !Array.isArray(body.tools)) {
    return { body, truncations: [] };
  }

  const truncations: ToolDescriptionTruncation[] = [];
  const normalizedTools = body.tools.map((tool, index) => normalizeTool(tool, index, shape, endpoint, truncations));
  if (truncations.length === 0) {
    return { body, truncations };
  }

  return {
    body: { ...body, tools: normalizedTools } as T,
    truncations,
  };
}
