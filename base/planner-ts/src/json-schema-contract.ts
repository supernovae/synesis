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
}).strict());
