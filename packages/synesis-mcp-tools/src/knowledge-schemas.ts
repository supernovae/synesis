import * as z from "zod/v4";
import { LIMITS } from "./tool-utils.js";

/** Shared search filters (synesis_search and synesis_knowledge_search). */
export const knowledgeSearchInputSchema = z.object({
  query: z.string().min(1).max(LIMITS.queryChars),
  mode: z.enum(["bundle", "cards"]).optional(),
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
    .array(z.enum([
      "CONTAINS",
      "DEFINES",
      "CALLS",
      "IMPORTS",
      "REFERENCES",
      "OVERRIDES",
      "IMPLEMENTS",
      "DOCUMENTS",
      "HAS_CONSTRAINT",
      "HAS_EXAMPLE",
      "HAS_PATTERN",
      "HAS_CONTEXT_CARD",
      "HAS_PACK_CARD",
      "APPLIES_TO",
      "DEPRECATED_BY",
      "REPLACED_BY",
      "RELATED_TO",
      "WARNS_ABOUT",
      "HAS_FIELD",
      "REQUIRES",
      "VALIDATED_BY",
      "MANAGED_BY",
      "OWNS",
      "CONFLICTS_WITH",
    ]))
    .optional(),
  topic: z.string().max(LIMITS.mediumStringChars).optional(),
  symbol: z.string().max(LIMITS.mediumStringChars).optional(),
  task: z.string().max(LIMITS.mediumStringChars).optional(),
  content_type: z.string().max(LIMITS.shortStringChars).optional(),
  version_preference: z.string().max(LIMITS.shortStringChars).optional(),
  include_examples: z.boolean().optional(),
  include_antipatterns: z.boolean().optional(),
  include_context_cards: z.boolean().optional(),
  include_pack_cards: z.boolean().optional(),
  routing_mode: z.enum(["auto", "local", "hosted", "hybrid"]).optional(),
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
}).strict();

export const resolvePackInputSchema = z.object({
  query: z.string().max(LIMITS.queryChars).optional(),
  domain: z.string().max(LIMITS.shortStringChars).optional(),
  content_type: z.string().max(LIMITS.shortStringChars).optional(),
  language: z.string().max(LIMITS.shortStringChars).optional(),
  package_name: z.string().max(LIMITS.shortStringChars).optional(),
  symbol: z.string().max(LIMITS.mediumStringChars).optional(),
  version: z.string().max(LIMITS.shortStringChars).optional(),
  top_k: z.number().int().min(1).max(LIMITS.maxTopK).optional(),
}).strict();

export const contextBundleInputSchema = knowledgeSearchInputSchema.extend({
  mode: z.enum(["bundle", "cards"]).optional().default("bundle"),
});

export const codeSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const docsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const configSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });
export const devDocsSearchInputSchema = knowledgeSearchInputSchema.omit({ artifact_kind: true });

function parseBoundedJsonString(maxChars: number) {
  return (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    if (value.length > maxChars) return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  };
}

const TerraformPlanChangeSchema = z.object({
  actions: z.array(z.enum(["no-op", "create", "read", "update", "delete"])).max(5).optional(),
}).strict();

const TerraformPlanResourceChangeSchema = z.object({
  address: z.string().max(LIMITS.mediumStringChars).optional(),
  type: z.string().max(LIMITS.shortStringChars).optional(),
  provider_name: z.string().max(LIMITS.shortStringChars).optional(),
  change: TerraformPlanChangeSchema.optional(),
}).strict();

const TerraformPlanJsonSchema = z.preprocess(
  parseBoundedJsonString(LIMITS.maxTerraformPlanChars),
  z.object({
    format_version: z.string().max(LIMITS.shortStringChars).optional(),
    terraform_version: z.string().max(LIMITS.shortStringChars).optional(),
    resource_changes: z.array(TerraformPlanResourceChangeSchema).max(LIMITS.maxTerraformResources).optional(),
  }).strict(),
);

const StringValueMapSchema = z.record(
  z.string().max(LIMITS.shortStringChars),
  z.string().max(LIMITS.mediumStringChars),
);

const EcmaCompilerOptionsSchema = z.object({
  module: z.string().max(LIMITS.shortStringChars).optional(),
  moduleResolution: z.string().max(LIMITS.shortStringChars).optional(),
  strict: z.boolean().optional(),
  noImplicitAny: z.boolean().optional(),
}).strict();

const EcmaPackageJsonSchema = z.preprocess(
  parseBoundedJsonString(LIMITS.contextChars),
  z.object({
    name: z.string().max(LIMITS.shortStringChars).optional(),
    version: z.string().max(LIMITS.shortStringChars).optional(),
    type: z.enum(["module", "commonjs"]).optional(),
    engines: StringValueMapSchema.optional(),
    dependencies: StringValueMapSchema.optional(),
    devDependencies: StringValueMapSchema.optional(),
    optionalDependencies: StringValueMapSchema.optional(),
    peerDependencies: StringValueMapSchema.optional(),
    scripts: StringValueMapSchema.optional(),
  }).strict(),
);

const EcmaTsConfigSchema = z.preprocess(
  parseBoundedJsonString(LIMITS.contextChars),
  z.object({
    compilerOptions: EcmaCompilerOptionsSchema.optional(),
  }).strict(),
);

const EcmaDenoJsonSchema = z.preprocess(
  parseBoundedJsonString(LIMITS.contextChars),
  z.object({
    imports: StringValueMapSchema.optional(),
    tasks: StringValueMapSchema.optional(),
    compilerOptions: EcmaCompilerOptionsSchema.optional(),
  }).strict(),
);

export const terraformPlanAnalyzeInputSchema = z.object({
  plan_json: TerraformPlanJsonSchema,
  pack_id: z.string().max(LIMITS.shortStringChars).optional(),
  top_k: z.number().int().min(1).max(LIMITS.maxTopK).optional(),
  synpack_metadata: z.object({
    resources: z.array(z.object({
      resource_type: z.string().min(1).max(LIMITS.shortStringChars),
      core_safety: z.enum(["0", "1", "2"]).optional(),
      risk_notes: z.string().max(LIMITS.mediumStringChars).optional(),
      policy_reference: z.string().max(LIMITS.mediumStringChars).optional(),
      provider: z.string().max(LIMITS.shortStringChars).optional(),
    }).strict()).max(LIMITS.maxTerraformResources).optional(),
  }).strict().optional(),
}).strict();

export const ecmaEnvironmentCheckInputSchema = z.object({
  package_json: EcmaPackageJsonSchema.optional(),
  tsconfig_json: EcmaTsConfigSchema.optional(),
  jsconfig_json: EcmaTsConfigSchema.optional(),
  deno_json: EcmaDenoJsonSchema.optional(),
  bunfig_toml: z.string().max(LIMITS.contextChars).optional(),
  lockfiles: z.array(z.string().max(LIMITS.mediumStringChars)).max(LIMITS.maxStringArrayItems).optional(),
}).strict();

export const ecmaPackageRiskInputSchema = z.object({
  dependencies_added: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxPackageItems).optional(),
  dependencies_removed: z.array(z.string().max(LIMITS.shortStringChars)).max(LIMITS.maxPackageItems).optional(),
  scripts_added: z.record(z.string(), z.string().max(LIMITS.mediumStringChars)).optional(),
  scripts_changed: z.record(z.string(), z.string().max(LIMITS.mediumStringChars)).optional(),
  package_json_before: EcmaPackageJsonSchema.optional(),
  package_json_after: EcmaPackageJsonSchema.optional(),
}).strict();
