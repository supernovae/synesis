import * as z from "zod/v4";
import {
  knowledgeSearchInputSchema,
  resolvePackInputSchema,
  contextBundleInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
  devDocsSearchInputSchema,
  terraformPlanAnalyzeInputSchema,
  ecmaEnvironmentCheckInputSchema,
  ecmaPackageRiskInputSchema,
} from "./knowledge-schemas.js";
import { webSearchInputSchema } from "./web-search-schemas.js";
import { classifyInputSchema, planInputSchema, critiqueInputSchema } from "./planner-tools.js";
import {
  cvePackagesSchema,
  licensePackagesSchema,
  docsLookupSchema,
  patchIntegritySchema,
} from "./cve-license-docs-patch.js";

export interface SynesisPlatformCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as Record<string, unknown>)
    : { type: "object" };
}

/**
 * Catalog entries for Synesis platform tools (same surface as synesis-mcp-ts `registerSynesisMcpTools`).
 * Yarn merges this into `GET /v1/mcp/tools` so clients see one list with workspace + platform tools.
 */
export function getSynesisPlatformCatalog(): SynesisPlatformCatalogEntry[] {
  const knowledgeDesc =
    "RAG: ranked chunks from the Synesis knowledge catalog (provenance + scores). When to use: Synesis-specific behavior, deployment, conventions, or prior art — before inventing patterns from memory. When not to use: generic language tutorials available in the user repo; use workspace search_code/read_file first for project-local code.";
  const knowledgeYarnDesc =
    "Same as synesis_search. Prefer this for documentation-style queries: examples, error catalogs, style, architecture. For Rust, use language=rust, symbol_fqn=E0xxx for compiler errors, and scope_tags like edition-2024/async/unsafe. For Quarkus, use language=quarkus with artifact_kind=config_reference or cli_command and inspect build_time_config/event_loop_safety/native_image_note/agent_advice in agent_enrichment_json. For Python, use artifact_kind=repo_map before broad search in large repos, type_stub for type ambiguity, and uv/tool_docs for environment management. For Godot, use artifact_kind=class_reference for exact Node/API XML, engine_manual for scene-tree patterns, shader_language for Godot shader syntax, and engine_proposal for Godot 4 migration rationale; inspect signal_contract/node_compatibility/lifecycle_order/legacy_3x_warning. For Terraform, use artifact_kind=provider_schema for hard provider constraints, provider_docs for resource docs, opentofu_feature for state features, and call synesis_terraform_plan_analyze on plan JSON before apply. For Ecma/JS/TS, call synesis_ecma_environment_check first, then search language=ecma with artifact_kind=temporal_api/typescript_handbook/runtime_api/web_api and inspect runtime_compatibility, ts_safety, module_system, bundle_impact, and hidden_warnings. Pair with workspace tools: search_code → read_file for user code; synesis_* for platform knowledge.";

  return [
    {
      name: "synesis_search",
      description: knowledgeDesc,
      inputSchema: zodToJsonSchema(knowledgeSearchInputSchema),
    },
    {
      name: "synesis_resolve_pack",
      description:
        "Resolve an installed SynPack v2 by library, language, package, symbol, topic, or version. Returns candidate packs with source version, trust/quality/freshness, and graph node/example/card counts.",
      inputSchema: zodToJsonSchema(resolvePackInputSchema),
    },
    {
      name: "synesis_context_bundle",
      description:
        "Preferred SynPack v2 retrieval tool for coding and rich content tasks. Returns answer-ready context cards, examples, anti-patterns, related APIs, source chunks, freshness warnings, and quality signals.",
      inputSchema: zodToJsonSchema(contextBundleInputSchema),
    },
    {
      name: "synesis_knowledge_search",
      description: knowledgeYarnDesc,
      inputSchema: zodToJsonSchema(knowledgeSearchInputSchema),
    },
    {
      name: "synesis_web_search",
      description:
        "Web search via planner-backed SearXNG retrieval with attribution context. Use when evidence is likely outside the indexed Synesis corpora.",
      inputSchema: zodToJsonSchema(webSearchInputSchema),
    },
    {
      name: "web_search",
      description:
        "Alias for synesis_web_search. Returns the same planner-backed web search results and attribution envelope.",
      inputSchema: zodToJsonSchema(webSearchInputSchema),
    },
    {
      name: "synesis_code_search",
      description:
        "RAG over Synesis’s indexed code corpus. When to use: find how Synesis implements a pattern. When not to use: the user’s current workspace — use search_code there instead.",
      inputSchema: zodToJsonSchema(codeSearchInputSchema),
    },
    {
      name: "synesis_docs_search",
      description:
        "RAG over Synesis documentation. When to use: deployment, configuration, operational docs. Not a substitute for workspace inspection on the user’s app.",
      inputSchema: zodToJsonSchema(docsSearchInputSchema),
    },
    {
      name: "synesis_config_search",
      description:
        "RAG over configs (YAML, JSON, K8s, …). When to use: cluster/manifest patterns in Synesis. When not to use: editing the user’s repo without reading it — inspect_repo/read_file first.",
      inputSchema: zodToJsonSchema(configSearchInputSchema),
    },
    {
      name: "search_developer_docs",
      description:
        "RAG over official developer documentation and installed SynPacks for programming languages and frameworks (e.g., Python, React, Go, Rust, Quarkus, Godot, Terraform, Ecma/JS/TS). Use pack_id/package_name/symbol_kind filters when available; for Rust, prefer edition-aware rows and E0xxx compiler-error rows; for Quarkus, prefer CLI/config/native/build-time rows; for Python, prefer repo_map, type_stub, PEP, and uv/tooling rows; for Godot, prefer class_reference, engine_manual, shader_language, and engine_proposal rows; for Terraform, prefer provider_schema, provider_docs, opentofu_feature, and iac_policy_rule rows; for JS/TS, prefer EcmaPack rows with artifact_kind=temporal_api, typescript_handbook, runtime_api, or web_api before falling back to web search.",
      inputSchema: zodToJsonSchema(devDocsSearchInputSchema),
    },
    {
      name: "synesis_terraform_plan_analyze",
      description:
        "Read-only Terraform plan JSON analyzer. Use after terraform plan -out=tfplan and terraform show -json tfplan. It flags delete/replacement actions, joins Terraform SynPack metadata when available, and returns an approval-ready hard-gate bundle. It never runs terraform or mutates state.",
      inputSchema: zodToJsonSchema(terraformPlanAnalyzeInputSchema),
    },
    {
      name: "synesis_ecma_environment_check",
      description:
        "Read-only JS/TS environment analyzer. Use before suggesting JS/TS code to detect package manager, runtime, module system, TypeScript strictness, and recommended EcmaPack search filters. It never installs dependencies or edits files.",
      inputSchema: zodToJsonSchema(ecmaEnvironmentCheckInputSchema),
    },
    {
      name: "synesis_ecma_package_risk_analyze",
      description:
        "Read-only package.json risk analyzer. Use before dependency/script changes; flags install lifecycle scripts and legacy/heavy dependencies so the harness can require approval or steer toward native APIs like Temporal.",
      inputSchema: zodToJsonSchema(ecmaPackageRiskInputSchema),
    },
    {
      name: "synesis_classify",
      description:
        "Planner entry classifier (intent, difficulty, taxonomy). When to use: ambiguous or multi-step tasks to choose strategy. When not to use: trivial one-file edits with clear scope.",
      inputSchema: zodToJsonSchema(classifyInputSchema),
    },
    {
      name: "synesis_plan",
      description:
        "Planner-generated execution plan (chat completions). When to use: complex features, cross-cutting changes, or unclear sequencing. When not to use: after you already have a test-driven checklist and only need implementation.",
      inputSchema: zodToJsonSchema(planInputSchema),
    },
    {
      name: "synesis_critique",
      description:
        "Critic model review of code. When to use: after tests/build pass for risk/quality pass. Not a substitute for run_lint/run_build/run_test.",
      inputSchema: zodToJsonSchema(critiqueInputSchema),
    },
    {
      name: "synesis_cve_check",
      description: "Check packages for CVEs via OSV.dev API.",
      inputSchema: zodToJsonSchema(cvePackagesSchema),
    },
    {
      name: "synesis_license_check",
      description: "Check SPDX license compatibility against a target license.",
      inputSchema: zodToJsonSchema(licensePackagesSchema),
    },
    {
      name: "synesis_docs_lookup",
      description: "Curated documentation URLs for known frameworks (fastapi, langchain, vllm, …).",
      inputSchema: zodToJsonSchema(docsLookupSchema),
    },
    {
      name: "synesis_patch_integrity",
      description:
        "Deterministic safety checks on code/patches (secrets, egress, path traversal, dangerous commands).",
      inputSchema: zodToJsonSchema(patchIntegritySchema),
    },
  ];
}
