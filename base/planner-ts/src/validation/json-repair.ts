import { z } from "zod";

function fixInvalidEscapes(input: string): string {
  return input.replace(/\\\\|\\(?!["\\/bfnrtu])/g, (match) => {
    if (match === "\\\\") return "\\\\";
    return `\\\\${match[1] ?? ""}`;
  });
}

function repairJson(candidate: string): string {
  let text = fixInvalidEscapes(candidate.trim());
  text = text.replace(/,\s*([}\]])/g, "$1");

  if (text.includes("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (end > start) text = text.slice(start, end + 1);
  }

  if ((text.match(/"/g) ?? []).length % 2 !== 0) {
    text = `${text}"`;
  }
  return text;
}

function extractJson(raw: string): string {
  const content = raw.trim();
  try {
    JSON.parse(content);
    return content;
  } catch {
    // continue
  }

  const start = content.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in response");

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < content.length; i += 1) {
    const c = content[i] ?? "";
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") {
      inString = true;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end >= 0) {
    const sliced = content.slice(start, end + 1);
    try {
      JSON.parse(sliced);
      return sliced;
    } catch {
      const repaired = repairJson(sliced);
      JSON.parse(repaired);
      return repaired;
    }
  }

  const trailing = content.slice(start);
  const repaired = repairJson(trailing);
  JSON.parse(repaired);
  return repaired;
}

export function validateWithRepair<T>(raw: string, schema: z.ZodType<T>): T {
  let extracted: string;
  try {
    extracted = extractJson(raw);
  } catch {
    extracted = repairJson(raw);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const candidate = attempt === 0 ? extracted : repairJson(extracted);
      const parsed = JSON.parse(candidate);
      return schema.parse(parsed);
    } catch (error) {
      if (attempt === 2) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Schema validation failed after repair: ${reason}`, { cause: error });
      }
    }
  }
  throw new Error("Schema validation failed");
}
