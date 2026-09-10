import { describe, it, expect } from "vitest";
import { getSynesisPlatformCatalog } from "../src/index.js";

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

describe("platform catalog schemas", () => {
  it("publishes closed, allowlisted JSON Schema descriptors", () => {
    for (const tool of getSynesisPlatformCatalog()) {
      assertClosedSchema(tool.inputSchema, tool.name);
    }
  });
});
