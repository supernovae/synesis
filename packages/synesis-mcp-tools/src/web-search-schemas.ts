import * as z from "zod/v4";

export const webSearchInputSchema = z.object({
  query: z.string(),
  top_k: z.number().int().min(1).max(20).optional(),
  profile: z.enum(["web", "code"]).optional(),
  fetch_pages: z.boolean().optional(),
  max_fetch_pages: z.number().int().min(0).max(10).optional(),
  min_relevance: z.number().min(0).max(1).optional(),
  preferred_domains: z.array(z.string()).optional(),
  source_surface: z.string().optional(),
  tool_name: z.string().optional(),
  request_id: z.string().optional(),
  session_key: z.string().optional(),
  conversation_id: z.string().optional(),
  trace_id: z.string().optional(),
  caller_org_id: z.string().optional(),
  caller_user_id: z.string().optional(),
  caller_tenant_ids: z.array(z.string()).optional(),
  caller_acl_groups: z.array(z.string()).optional(),
});

