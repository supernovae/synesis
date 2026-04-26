import * as z from "zod/v4";

/** Shared search filters (synesis_search and synesis_knowledge_search). */
export const knowledgeSearchInputSchema = z.object({
  query: z.string(),
  top_k: z.number().optional(),
  pack_id: z.string().optional(),
  pack_ids: z.array(z.string()).optional(),
  pack_version: z.string().optional(),
  pack_partition: z.string().optional(),
  symbol_kind: z.string().optional(),
  symbol_fqn: z.string().optional(),
  package_name: z.string().optional(),
  perf_tier: z.string().optional(),
  language: z.string().optional(),
  artifact_kind: z
    .enum([
      "code",
      "docs",
      "config",
      "api_spec",
      "architecture",
      "compiler_error",
      "language_spec",
      "unsafe_guidance",
      "async_guidance",
      "config_reference",
      "cli_command",
      "platform_bom",
      "pep",
      "packaging_spec",
      "tool_docs",
      "type_stub",
      "repo_map",
    ])
    .optional(),
  domain: z.string().optional(),
  corpus_class: z.string().optional(),
  constraint_kind: z.string().optional(),
  scope_tags: z.array(z.string()).optional(),
  tags: z.string().optional(),
  content_format: z.string().optional(),
  repo_path: z.string().optional(),
  content_profile: z.string().optional(),
  constraint_source: z.string().optional(),
  golden_path_id: z.string().optional(),
});

export const codeSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const docsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const configSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const devDocsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
