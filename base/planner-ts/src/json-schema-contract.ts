import { z } from "zod";

const JsonSchemaTypeNameSchema = z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]);
const JsonSchemaScalarSchema = z.union([
  z.string().max(8192),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const JsonSchemaPropertyNameSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);

type JsonSchemaScalar = z.infer<typeof JsonSchemaScalarSchema>;

export type JsonSchemaContract = {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: z.infer<typeof JsonSchemaTypeNameSchema> | Array<z.infer<typeof JsonSchemaTypeNameSchema>>;
  properties?: Record<string, JsonSchemaContract>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaContract;
  items?: JsonSchemaContract | JsonSchemaContract[];
  enum?: JsonSchemaScalar[];
  const?: JsonSchemaScalar;
  default?: JsonSchemaScalar;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
  oneOf?: JsonSchemaContract[];
  anyOf?: JsonSchemaContract[];
  allOf?: JsonSchemaContract[];
  $defs?: Record<string, JsonSchemaContract>;
  definitions?: Record<string, JsonSchemaContract>;
};

function jsonSchemaMap() {
  return z.record(JsonSchemaPropertyNameSchema, JsonSchemaContractSchema)
    .refine((value) => Object.keys(value).length <= 256, "JSON Schema map must contain 256 entries or fewer");
}

function jsonSchemaArray(max = 128) {
  return z.array(JsonSchemaContractSchema).max(max);
}

function schemaTypeSet(type: JsonSchemaContract["type"]): Set<string> | null {
  if (type === undefined) return null;
  return new Set(Array.isArray(type) ? type : [type]);
}

function typeIncludes(types: Set<string> | null, typeName: string): boolean {
  return types === null || types.has(typeName);
}

function scalarMatchesType(value: JsonSchemaScalar, types: Set<string> | null): boolean {
  if (types === null) return true;
  if (value === null) return types.has("null");
  if (typeof value === "string") return types.has("string");
  if (typeof value === "boolean") return types.has("boolean");
  if (typeof value === "number") {
    return types.has("number") || (Number.isInteger(value) && types.has("integer"));
  }
  return false;
}

function refineJsonSchemaContract(schema: JsonSchemaContract, ctx: z.RefinementCtx): void {
  if (Object.keys(schema).length === 0) {
    ctx.addIssue({ code: "custom", message: "JSON Schema descriptor must not be empty" });
    return;
  }

  const types = schemaTypeSet(schema.type);

  if (schema.additionalProperties === true) {
    ctx.addIssue({
      code: "custom",
      path: ["additionalProperties"],
      message: "additionalProperties true is not allowed",
    });
  }

  if (schema.properties !== undefined && !typeIncludes(types, "object")) {
    ctx.addIssue({ code: "custom", path: ["properties"], message: "properties requires object type" });
  }
  if (schema.required !== undefined) {
    if (!typeIncludes(types, "object")) {
      ctx.addIssue({ code: "custom", path: ["required"], message: "required requires object type" });
    }
    if (schema.properties === undefined) {
      ctx.addIssue({ code: "custom", path: ["required"], message: "required requires properties" });
    } else {
      for (const requiredKey of schema.required) {
        if (!(requiredKey in schema.properties)) {
          ctx.addIssue({
            code: "custom",
            path: ["required"],
            message: `required key is not declared in properties: ${requiredKey}`,
          });
        }
      }
    }
  }
  if (schema.additionalProperties !== undefined && !typeIncludes(types, "object")) {
    ctx.addIssue({
      code: "custom",
      path: ["additionalProperties"],
      message: "additionalProperties requires object type",
    });
  }

  if (schema.items !== undefined && !typeIncludes(types, "array")) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "items requires array type" });
  }

  if ((schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined)
    && !typeIncludes(types, "string")) {
    ctx.addIssue({ code: "custom", message: "string constraints require string type" });
  }
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && !typeIncludes(types, "array")) {
    ctx.addIssue({ code: "custom", message: "array constraints require array type" });
  }
  if ((schema.minimum !== undefined || schema.maximum !== undefined)
    && !typeIncludes(types, "number") && !typeIncludes(types, "integer")) {
    ctx.addIssue({ code: "custom", message: "numeric constraints require number or integer type" });
  }

  for (const enumValue of schema.enum ?? []) {
    if (!scalarMatchesType(enumValue, types)) {
      ctx.addIssue({ code: "custom", path: ["enum"], message: "enum value does not match schema type" });
    }
  }
  if (schema.const !== undefined && !scalarMatchesType(schema.const, types)) {
    ctx.addIssue({ code: "custom", path: ["const"], message: "const value does not match schema type" });
  }
  if (schema.default !== undefined && !scalarMatchesType(schema.default, types)) {
    ctx.addIssue({ code: "custom", path: ["default"], message: "default value does not match schema type" });
  }
}

export const JsonSchemaContractSchema: z.ZodType<JsonSchemaContract> = z.lazy(() => z.object({
  $schema: z.string().max(512).optional(),
  $id: z.string().max(512).optional(),
  $ref: z.string().max(512).optional(),
  title: z.string().max(512).optional(),
  description: z.string().max(4096).optional(),
  type: z.union([JsonSchemaTypeNameSchema, z.array(JsonSchemaTypeNameSchema).max(8)]).optional(),
  properties: jsonSchemaMap().optional(),
  required: z.array(JsonSchemaPropertyNameSchema).max(256).optional(),
  additionalProperties: z.union([z.boolean(), JsonSchemaContractSchema]).optional(),
  items: z.union([JsonSchemaContractSchema, jsonSchemaArray(32)]).optional(),
  enum: z.array(JsonSchemaScalarSchema).max(256).optional(),
  const: JsonSchemaScalarSchema.optional(),
  default: JsonSchemaScalarSchema.optional(),
  format: z.string().max(128).optional(),
  pattern: z.string().max(512).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  minLength: z.number().int().min(0).max(1_000_000).optional(),
  maxLength: z.number().int().min(0).max(1_000_000).optional(),
  minItems: z.number().int().min(0).max(1_000_000).optional(),
  maxItems: z.number().int().min(0).max(1_000_000).optional(),
  nullable: z.boolean().optional(),
  oneOf: jsonSchemaArray().optional(),
  anyOf: jsonSchemaArray().optional(),
  allOf: jsonSchemaArray().optional(),
  $defs: jsonSchemaMap().optional(),
  definitions: jsonSchemaMap().optional(),
}).strict().superRefine(refineJsonSchemaContract));
