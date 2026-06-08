import { describe, it, expect } from "vitest";
import type { SynesisMcpAuth, SynesisMcpDeps } from "@synesis/mcp-tools";
import { getSynesisPlatformCatalog, registerSynesisMcpTools } from "@synesis/mcp-tools";

const CORE_TOOLS = [
  "synesis_search",
  "synesis_resolve_pack",
  "synesis_context_bundle",
  "synesis_web_search",
  "synesis_code_search",
  "synesis_docs_search",
  "synesis_patch_integrity",
];

const EXTENDED_TOOLS = [
  "synesis_config_search",
  "synesis_classify",
  "synesis_plan",
  "synesis_critique",
  "synesis_terraform_plan_analyze",
  "synesis_ecma_environment_check",
  "synesis_ecma_package_risk_analyze",
];

const REMOVED_TOOLS = [
  "web_search",
  "search_developer_docs",
  "synesis_knowledge_search",
  "synesis_cve_check",
  "synesis_license_check",
  "synesis_docs_lookup",
];

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

function collectRegisteredTools(options?: { allTools?: boolean }): string[] {
  const registered: string[] = [];
  const mockServer = {
    registerTool(name: string) {
      registered.push(name);
    },
  };
  const auth: SynesisMcpAuth = {
    bearerToken: "test",
    userId: "test",
    orgId: "",
    tenantIds: [],
  };
  const deps: SynesisMcpDeps = { plannerBaseUrl: "http://localhost:8080" };
  registerSynesisMcpTools(mockServer, auth, deps, options);
  return registered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedSchema(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertClosedSchema(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(schema)) return;

  expect(Object.keys(schema).length, `${path} must not expose an empty schema descriptor`).toBeGreaterThan(0);
  for (const key of Object.keys(schema)) {
    expect(CATALOG_JSON_SCHEMA_KEYS.has(key), `${path} should not expose unknown schema key ${key}`).toBe(true);
  }

  const hasBoundedMapSchema = isRecord(schema.propertyNames) && isRecord(schema.additionalProperties);
  if ((schema.type === "object" || isRecord(schema.properties)) && !hasBoundedMapSchema) {
    expect(schema.additionalProperties, `${path} must reject undeclared fields`).toBe(false);
  }

  for (const key of ["items", "allOf", "anyOf", "oneOf", "propertyNames", "additionalProperties"] as const) {
    assertClosedSchema(schema[key], `${path}.${key}`);
  }

  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      assertClosedSchema(propertySchema, `${path}.properties.${propertyName}`);
    }
  }
  if (isRecord(schema.$defs)) {
    for (const [definitionName, definitionSchema] of Object.entries(schema.$defs)) {
      assertClosedSchema(definitionSchema, `${path}.$defs.${definitionName}`);
    }
  }
}

describe("tool curation — default registration", () => {
  const tools = collectRegisteredTools();

  it("registers all core tools", () => {
    for (const name of CORE_TOOLS) {
      expect(tools, `core tool ${name} should be registered`).toContain(name);
    }
  });

  it("does not register extended tools by default", () => {
    for (const name of EXTENDED_TOOLS) {
      expect(tools, `extended tool ${name} should NOT be registered by default`).not.toContain(name);
    }
  });

  it("does not register removed tools", () => {
    for (const name of REMOVED_TOOLS) {
      expect(tools, `removed tool ${name} should never be registered`).not.toContain(name);
    }
  });

  it("registers exactly the core set", () => {
    expect(tools.sort()).toEqual([...CORE_TOOLS].sort());
  });
});

describe("platform catalog schemas", () => {
  it("publishes closed, allowlisted JSON Schema descriptors", () => {
    for (const tool of getSynesisPlatformCatalog()) {
      assertClosedSchema(tool.inputSchema, tool.name);
    }
  });
});

describe("tool curation — allTools registration", () => {
  const tools = collectRegisteredTools({ allTools: true });

  it("registers core tools", () => {
    for (const name of CORE_TOOLS) {
      expect(tools).toContain(name);
    }
  });

  it("registers extended tools", () => {
    for (const name of EXTENDED_TOOLS) {
      expect(tools, `extended tool ${name} should be registered with allTools`).toContain(name);
    }
  });

  it("still does not register removed tools", () => {
    for (const name of REMOVED_TOOLS) {
      expect(tools, `removed tool ${name} should never be registered`).not.toContain(name);
    }
  });

  it("registers exactly core + extended set", () => {
    expect(tools.sort()).toEqual([...CORE_TOOLS, ...EXTENDED_TOOLS].sort());
  });
});
