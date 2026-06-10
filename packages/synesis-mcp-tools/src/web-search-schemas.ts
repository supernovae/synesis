import * as z from "zod/v4";
import { LIMITS } from "./tool-utils.js";

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(LIMITS.queryChars),
  top_k: z.number().int().min(1).max(20).optional(),
  profile: z.enum(["web", "code"]).optional(),
  fetch_pages: z.boolean().optional(),
  max_fetch_pages: z.number().int().min(0).max(10).optional(),
  min_relevance: z.number().min(0).max(1).optional(),
  preferred_domains: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxStringArrayItems).optional(),
}).strict();
