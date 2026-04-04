import type { ZodType } from "zod/v4";
import * as z from "zod/v4";
import {
  knowledgeSearchInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
} from "./knowledge-schemas.js";
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

/**
 * Minimal Zod-to-JSON-Schema for MCP tool discovery (subset: object, string, number, boolean, array, enum).
 */
function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (schema as z.core.$ZodType)._zod;
  if (!def) return { type: "object" };

  const typeName = def.def?.type;

  if (typeName === "object") {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (shape && typeof shape === "object") {
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as ZodType);
        const innerDef = (value as z.core.$ZodType)?._zod?.def;
        if (innerDef?.type !== "optional" && innerDef?.type !== "default") {
          required.push(key);
        }
      }
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  if (typeName === "string") return { type: "string" };
  if (typeName === "number") return { type: "number" };
  if (typeName === "boolean") return { type: "boolean" };
  if (typeName === "array") return { type: "array", items: zodToJsonSchema((schema as z.ZodArray<ZodType>).element) };
  if (typeName === "enum") {
    const values = (def.def as { values?: readonly string[] })?.values;
    return { type: "string", enum: values ? [...values] : [] };
  }
  if (typeName === "optional" || typeName === "default") {
    const inner = (def.def as { innerType?: ZodType })?.innerType;
    if (inner) return zodToJsonSchema(inner);
  }
  return {};
}

/**
 * Catalog entries for Synesis platform tools (same surface as synesis-mcp-ts `registerSynesisMcpTools`).
 * Yarn merges this into `GET /v1/mcp/tools` so clients see one list with workspace + platform tools.
 */
export function getSynesisPlatformCatalog(): SynesisPlatformCatalogEntry[] {
  const knowledgeDesc =
    "RAG retrieval against the Synesis knowledge catalog. Returns ranked chunks with provenance and scores. Uses planner /v1/knowledge/search with your PAT scope.";
  const knowledgeYarnDesc =
    "Search the Synesis knowledge catalog for relevant documentation, code examples, language specifications, error catalogs, linter rules, style guides, and architecture patterns. Same behavior as synesis_search.";

  return [
    {
      name: "synesis_search",
      description: knowledgeDesc,
      inputSchema: zodToJsonSchema(knowledgeSearchInputSchema),
    },
    {
      name: "synesis_knowledge_search",
      description: knowledgeYarnDesc,
      inputSchema: zodToJsonSchema(knowledgeSearchInputSchema),
    },
    {
      name: "synesis_code_search",
      description: "Search the Synesis code corpus (artifact_kind=code).",
      inputSchema: zodToJsonSchema(codeSearchInputSchema),
    },
    {
      name: "synesis_docs_search",
      description: "Search the Synesis documentation corpus (artifact_kind=docs).",
      inputSchema: zodToJsonSchema(docsSearchInputSchema),
    },
    {
      name: "synesis_config_search",
      description:
        "Search the Synesis configuration corpus (artifact_kind=config): YAML, JSON, HCL, Kubernetes, etc.",
      inputSchema: zodToJsonSchema(configSearchInputSchema),
    },
    {
      name: "synesis_classify",
      description: "Classify a task description via planner entry classifier (intent, difficulty, taxonomy).",
      inputSchema: zodToJsonSchema(classifyInputSchema),
    },
    {
      name: "synesis_plan",
      description: "Generate an execution plan via planner chat completions.",
      inputSchema: zodToJsonSchema(planInputSchema),
    },
    {
      name: "synesis_critique",
      description: "Submit code for critic model review.",
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
