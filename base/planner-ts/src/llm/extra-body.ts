import { z } from "zod";

export const ProviderExtraBodySchema = z.object({
  top_k: z.number().int().min(0).max(1_000_000).optional(),
  min_p: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().min(0).max(10).optional(),
  enable_thinking: z.boolean().optional(),
  enable_prefix_caching: z.boolean().optional(),
}).strict();

export type ProviderExtraBody = z.infer<typeof ProviderExtraBodySchema>;

export function normalizeProviderExtraBody(value: unknown): ProviderExtraBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProviderExtraBody = {};
  if (typeof raw.top_k === "number" && Number.isInteger(raw.top_k) && raw.top_k >= 0 && raw.top_k <= 1_000_000) {
    out.top_k = raw.top_k;
  }
  if (typeof raw.min_p === "number" && raw.min_p >= 0 && raw.min_p <= 1) {
    out.min_p = raw.min_p;
  }
  if (typeof raw.repetition_penalty === "number" && raw.repetition_penalty >= 0 && raw.repetition_penalty <= 10) {
    out.repetition_penalty = raw.repetition_penalty;
  }
  if (typeof raw.enable_thinking === "boolean") {
    out.enable_thinking = raw.enable_thinking;
  }
  if (typeof raw.enable_prefix_caching === "boolean") {
    out.enable_prefix_caching = raw.enable_prefix_caching;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
