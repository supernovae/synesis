import { ToolChoiceSchema, ToolDefinitionSchema } from "../api-schemas.js";
import { normalizeProviderExtraBody } from "./extra-body.js";

export interface NormalizedGenerationParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  enable_thinking?: boolean;
  reasoning_effort?: "low" | "medium" | "high";
  stop?: string | string[];
  seed?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  tools?: unknown[];
  tool_choice?: "none" | "auto" | "required" | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  extra_body?: Record<string, unknown>;
}

const MAX_OUTPUT_TOKENS = 2_000_000;
const MAX_STOP_SEQUENCES = 16;
const MAX_STOP_SEQUENCE_CHARS = 4096;
const MAX_LOGIT_BIAS_KEYS = 2048;
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function numberParam(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
  return num != null && Number.isFinite(num) ? num : undefined;
}

function boundedInt(raw: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = numberParam(raw, key);
  if (value == null || value < min || value > max) return undefined;
  return Math.trunc(value);
}

function boundedNumber(raw: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = numberParam(raw, key);
  return value != null && value >= min && value <= max ? value : undefined;
}

export function normalizeGenerationStop(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value.length <= MAX_STOP_SEQUENCE_CHARS ? value : undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_STOP_SEQUENCES) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length <= MAX_STOP_SEQUENCE_CHARS)) return undefined;
  return value;
}

export function normalizeGenerationLogitBias(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_LOGIT_BIAS_KEYS) break;
    if (!/^-?\d{1,12}$/.test(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= -100 && raw <= 100) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeGenerationParamsFromRecord(
  raw: Record<string, unknown> | null | undefined,
): NormalizedGenerationParams | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: NormalizedGenerationParams = {};
  const maxTokens = boundedInt(raw, "max_tokens", 1, MAX_OUTPUT_TOKENS);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const temperature = boundedNumber(raw, "temperature", 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = boundedNumber(raw, "top_p", 0, 1);
  if (topP !== undefined) out.top_p = topP;
  const topK = boundedInt(raw, "top_k", 0, 1_000_000);
  if (topK !== undefined) out.top_k = topK;
  const minP = boundedNumber(raw, "min_p", 0, 1);
  if (minP !== undefined) out.min_p = minP;
  const presencePenalty = boundedNumber(raw, "presence_penalty", -2, 2);
  if (presencePenalty !== undefined) out.presence_penalty = presencePenalty;
  const frequencyPenalty = boundedNumber(raw, "frequency_penalty", -2, 2);
  if (frequencyPenalty !== undefined) out.frequency_penalty = frequencyPenalty;
  const repetitionPenalty = boundedNumber(raw, "repetition_penalty", 0, 10);
  if (repetitionPenalty !== undefined) out.repetition_penalty = repetitionPenalty;
  if (typeof raw.enable_thinking === "boolean") out.enable_thinking = raw.enable_thinking;
  if (typeof raw.reasoning_effort === "string") {
    const effort = raw.reasoning_effort.trim().toLowerCase();
    if (REASONING_EFFORTS.has(effort)) out.reasoning_effort = effort as NormalizedGenerationParams["reasoning_effort"];
  }
  const stop = normalizeGenerationStop(raw.stop);
  if (stop !== undefined) out.stop = stop;
  const seed = numberParam(raw, "seed");
  if (seed != null && Number.isInteger(seed)) out.seed = seed;
  const logitBias = normalizeGenerationLogitBias(raw.logit_bias);
  if (logitBias) out.logit_bias = logitBias;
  if (typeof raw.logprobs === "boolean") out.logprobs = raw.logprobs;
  const topLogprobs = boundedInt(raw, "top_logprobs", 0, 20);
  if (topLogprobs !== undefined) out.top_logprobs = topLogprobs;
  const n = boundedInt(raw, "n", 1, 128);
  if (n !== undefined) out.n = n;
  const tools = ToolDefinitionSchema.array().max(128).safeParse(raw.tools);
  if (tools.success) out.tools = tools.data;
  const toolChoice = ToolChoiceSchema.safeParse(raw.tool_choice);
  if (toolChoice.success) out.tool_choice = toolChoice.data;
  if (typeof raw.parallel_tool_calls === "boolean") out.parallel_tool_calls = raw.parallel_tool_calls;
  const extraBody = normalizeProviderExtraBody(raw.extra_body);
  if (extraBody) out.extra_body = extraBody;
  return Object.keys(out).length > 0 ? out : undefined;
}
