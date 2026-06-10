import * as z from "zod/v4";
import {
  knowledgeSearchInputSchema,
  resolvePackInputSchema,
  contextBundleInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
  terraformPlanAnalyzeInputSchema,
  ecmaEnvironmentCheckInputSchema,
  ecmaPackageRiskInputSchema,
} from "./knowledge-schemas.js";
import { webSearchInputSchema } from "./web-search-schemas.js";
import { classifyInputSchema, planInputSchema, critiqueInputSchema } from "./planner-tools.js";
import { patchIntegritySchema } from "./cve-license-docs-patch.js";

export interface SynesisPlatformCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CATALOG_JSON_SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "propertyNames",
  "properties",
  "required",
  "type",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closeJsonSchemaMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = closeCatalogJsonSchema(item);
  }
  return out;
}

function closeCatalogJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => closeCatalogJsonSchema(item));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CATALOG_JSON_SCHEMA_KEYS.has(key)) {
      throw new Error(`unsupported_catalog_schema_key:${key}`);
    }
    if (key === "properties" || key === "$defs") {
      out[key] = closeJsonSchemaMap(item);
    } else {
      out[key] = closeCatalogJsonSchema(item);
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error("unsupported_catalog_empty_schema");
  }

  const hasBoundedMapSchema = isRecord(out.propertyNames) && isRecord(out.additionalProperties);
  if ((out.type === "object" || isRecord(out.properties)) && !hasBoundedMapSchema) {
    out.type = "object";
    if (!isRecord(out.properties)) out.properties = {};
    out.additionalProperties = false;
  }

  return out;
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  const jsonSchema = converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as Record<string, unknown>)
    : { type: "object" };
  return closeCatalogJsonSchema(jsonSchema) as Record<string, unknown>;
}

/**
 * Catalog entries for Synesis platform tools.
 *
 * This is the public tool surface exposed to external MCP clients and merged
 * into Yarn's `GET /v1/mcp/tools` response.
 *
 * Yarn-internal aliases (synesis_knowledge_search, search_developer_docs,
 * web_search) are handled by Yarn's own tool registration and dispatch; they
 * are intentionally absent from this catalog.
 */
export function getSynesisPlatformCatalog(): SynesisPlatformCatalogEntry[] {
  const knowledgeDesc =
    "RAG: ranked chunks from the Synesis knowledge catalog (provenance + scores). When to use: Synesis-specific behavior, deployment, conventions, or prior art \u2014 before inventing patterns from memory. When not to use: generic language tutorials available in the user repo; use workspace search_code/read_file first for project-local code.";

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
      name: "synesis_web_search",
      description:
        "Web search with server-owned attribution context. Use when evidence is likely outside the indexed Synesis corpora.",
      inputSchema: zodToJsonSchema(webSearchInputSchema),
    },
    {
      name: "synesis_code_search",
      description:
        "RAG over Synesis's indexed code corpus. When to use: find how Synesis implements a pattern. When not to use: the user's current workspace \u2014 use search_code there instead.",
      inputSchema: zodToJsonSchema(codeSearchInputSchema),
    },
    {
      name: "synesis_docs_search",
      description:
        "RAG over Synesis documentation. When to use: deployment, configuration, operational docs. Not a substitute for workspace inspection on the user's app.",
      inputSchema: zodToJsonSchema(docsSearchInputSchema),
    },
    {
      name: "synesis_patch_integrity",
      description:
        "Deterministic safety checks on code/patches (secrets, egress, path traversal, dangerous commands).",
      inputSchema: zodToJsonSchema(patchIntegritySchema),
    },
    {
      name: "synesis_config_search",
      description:
        "RAG over configs (YAML, JSON, K8s, \u2026). When to use: cluster/manifest patterns in Synesis. When not to use: editing the user's repo without reading it \u2014 inspect_repo/read_file first.",
      inputSchema: zodToJsonSchema(configSearchInputSchema),
    },
    {
      name: "synesis_terraform_plan_analyze",
      description:
        "Read-only Terraform plan JSON analyzer. Flags delete/replacement actions, joins Terraform SynPack metadata when available, and returns an approval-ready hard-gate bundle. Never runs terraform or mutates state.",
      inputSchema: zodToJsonSchema(terraformPlanAnalyzeInputSchema),
    },
    {
      name: "synesis_ecma_environment_check",
      description:
        "Read-only JS/TS environment analyzer. Detects package manager, runtime, module system, TypeScript strictness, and recommended EcmaPack search filters. Never installs dependencies or edits files.",
      inputSchema: zodToJsonSchema(ecmaEnvironmentCheckInputSchema),
    },
    {
      name: "synesis_ecma_package_risk_analyze",
      description:
        "Read-only package.json risk analyzer. Flags install lifecycle scripts and legacy/heavy dependencies so the harness can require approval or steer toward native APIs.",
      inputSchema: zodToJsonSchema(ecmaPackageRiskInputSchema),
    },
    {
      name: "synesis_classify",
      description:
        "Planner entry classifier (intent, difficulty, taxonomy). When to use: ambiguous or multi-step tasks to choose strategy.",
      inputSchema: zodToJsonSchema(classifyInputSchema),
    },
    {
      name: "synesis_plan",
      description:
        "Planner-generated execution plan (chat completions). When to use: complex features, cross-cutting changes, or unclear sequencing.",
      inputSchema: zodToJsonSchema(planInputSchema),
    },
    {
      name: "synesis_critique",
      description:
        "Critic model review of code. When to use: after tests/build pass for risk/quality pass.",
      inputSchema: zodToJsonSchema(critiqueInputSchema),
    },
  ];
}
