import * as z from "zod/v4";
import { LIMITS } from "./tool-utils.js";

/** Shared search filters (synesis_search and synesis_knowledge_search). */
export const knowledgeSearchInputSchema = z.object({
  query: z.string().min(1).max(LIMITS.queryChars),
  top_k: z.number().int().min(1).max(LIMITS.maxTopK).optional(),
  pack_id: z.string().max(LIMITS.shortStringChars).optional(),
  pack_ids: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxStringArrayItems).optional(),
  pack_version: z.string().max(LIMITS.shortStringChars).optional(),
  pack_partition: z.string().max(LIMITS.shortStringChars).optional(),
  version: z.string().max(LIMITS.shortStringChars).optional(),
  commit: z.string().max(LIMITS.shortStringChars).optional(),
  branch: z.string().max(LIMITS.shortStringChars).optional(),
  temporal_at: z.string().max(LIMITS.shortStringChars).optional(),
  graph_depth: z.number().int().min(0).max(3).optional(),
  edge_types: z
    .array(z.enum(["CONTAINS", "DEFINES", "CALLS", "IMPORTS", "REFERENCES", "OVERRIDES", "IMPLEMENTS", "DOCUMENTS"]))
    .optional(),
  symbol_kind: z.string().max(LIMITS.shortStringChars).optional(),
  symbol_fqn: z.string().max(LIMITS.mediumStringChars).optional(),
  package_name: z.string().max(LIMITS.shortStringChars).optional(),
  perf_tier: z.string().max(LIMITS.shortStringChars).optional(),
  language: z.string().max(LIMITS.shortStringChars).optional(),
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
      "class_reference",
      "engine_manual",
      "engine_proposal",
      "shader_language",
      "node_lifecycle",
      "provider_docs",
      "provider_schema",
      "terraform_guide",
      "opentofu_feature",
      "iac_policy_rule",
      "terraform_plan",
      "live_state",
      "ecma_spec",
      "tc39_proposal",
      "temporal_api",
      "typescript_handbook",
      "runtime_api",
      "web_api",
      "runtime_config",
      "package_policy",
    ])
    .optional(),
  domain: z.string().max(LIMITS.shortStringChars).optional(),
  corpus_class: z.string().max(LIMITS.shortStringChars).optional(),
  constraint_kind: z.string().max(LIMITS.shortStringChars).optional(),
  scope_tags: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxStringArrayItems).optional(),
  tags: z.string().max(LIMITS.mediumStringChars).optional(),
  content_format: z.string().max(LIMITS.shortStringChars).optional(),
  repo_path: z.string().max(LIMITS.mediumStringChars).optional(),
  module_path: z.string().max(LIMITS.mediumStringChars).optional(),
  symbol_name: z.string().max(LIMITS.shortStringChars).optional(),
  has_code: z.boolean().optional(),
  code_language: z.string().max(LIMITS.shortStringChars).optional(),
  content_profile: z.string().max(LIMITS.shortStringChars).optional(),
  constraint_source: z.string().max(LIMITS.shortStringChars).optional(),
  golden_path_id: z.string().max(LIMITS.shortStringChars).optional(),
});

export const codeSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const docsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const configSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const devDocsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });

export const terraformPlanAnalyzeInputSchema = z.object({
  plan_json: z.unknown(),
  pack_id: z.string().max(LIMITS.shortStringChars).optional(),
  top_k: z.number().int().min(1).max(LIMITS.maxTopK).optional(),
  synpack_metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ecmaEnvironmentCheckInputSchema = z.object({
  package_json: z.unknown().optional(),
  tsconfig_json: z.unknown().optional(),
  jsconfig_json: z.unknown().optional(),
  deno_json: z.unknown().optional(),
  bunfig_toml: z.string().max(LIMITS.contextChars).optional(),
  lockfiles: z.array(z.string().max(LIMITS.mediumStringChars)).max(LIMITS.maxStringArrayItems).optional(),
});

export const ecmaPackageRiskInputSchema = z.object({
  dependencies_added: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxPackageItems).optional(),
  dependencies_removed: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxPackageItems).optional(),
  scripts_added: z.record(z.string(), z.string().max(LIMITS.mediumStringChars)).optional(),
  scripts_changed: z.record(z.string(), z.string().max(LIMITS.mediumStringChars)).optional(),
  package_json_before: z.unknown().optional(),
  package_json_after: z.unknown().optional(),
});
