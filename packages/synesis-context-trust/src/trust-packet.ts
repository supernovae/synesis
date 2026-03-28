import { z } from "zod";

export const TrustLevel = z.enum(["trusted", "semi_trusted", "untrusted"]);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const SourceType = z.enum([
  "system_control",
  "system_volatile",
  "client_system",
  "user_message",
  "assistant_message",
  "tool_result",
  "mcp_response",
  "web_retrieval",
  "rag_retrieval",
  "session_continuity",
]);
export type SourceType = z.infer<typeof SourceType>;

export const ContentPurpose = z.enum([
  "instruction",
  "data",
  "summary",
  "reference",
  "code",
  "context",
]);
export type ContentPurpose = z.infer<typeof ContentPurpose>;

export const TrustPacketV1 = z.object({
  schema_version: z.literal(1),
  trust_level: TrustLevel,
  source_type: SourceType,
  source_id: z.string().max(256).default(""),
  instruction_execution_allowed: z.boolean(),
  content_purpose: ContentPurpose,
  excerpt_only: z.boolean().default(false),
  sanitization_applied: z.array(z.string()).default([]),
  imperative_likelihood: z.number().min(0).max(1).default(0),
  artifact_handle: z.string().optional(),
  content: z.string(),
});
export type TrustPacketV1 = z.infer<typeof TrustPacketV1>;

export const SemiTrustedPacketV1 = TrustPacketV1.extend({
  trust_level: z.literal("semi_trusted"),
  instruction_execution_allowed: z.literal(false),
});
export type SemiTrustedPacketV1 = z.infer<typeof SemiTrustedPacketV1>;

/**
 * Serialize a trust packet with deterministic key order for prompt-cache stability.
 */
export function serializeStableJson(packet: TrustPacketV1): string {
  const ordered: Record<string, unknown> = {
    schema_version: packet.schema_version,
    trust_level: packet.trust_level,
    source_type: packet.source_type,
    source_id: packet.source_id,
    instruction_execution_allowed: packet.instruction_execution_allowed,
    content_purpose: packet.content_purpose,
    excerpt_only: packet.excerpt_only,
    sanitization_applied: packet.sanitization_applied,
    imperative_likelihood: packet.imperative_likelihood,
    content: packet.content,
  };
  if (packet.artifact_handle) {
    ordered.artifact_handle = packet.artifact_handle;
  }
  return JSON.stringify(ordered);
}

export function parseTrustPacket(json: string): TrustPacketV1 {
  return TrustPacketV1.parse(JSON.parse(json));
}

export function makeTrustedControl(content: string): TrustPacketV1 {
  return {
    schema_version: 1,
    trust_level: "trusted",
    source_type: "system_control",
    source_id: "",
    instruction_execution_allowed: true,
    content_purpose: "instruction",
    excerpt_only: false,
    sanitization_applied: [],
    imperative_likelihood: 0,
    content,
  };
}

export function makeUntrusted(
  content: string,
  sourceType: SourceType,
  opts: {
    sourceId?: string;
    contentPurpose?: ContentPurpose;
    sanitization?: string[];
    imperativeLikelihood?: number;
    artifactHandle?: string;
  } = {},
): TrustPacketV1 {
  return {
    schema_version: 1,
    trust_level: "untrusted",
    source_type: sourceType,
    source_id: opts.sourceId ?? "",
    instruction_execution_allowed: false,
    content_purpose: opts.contentPurpose ?? "data",
    excerpt_only: false,
    sanitization_applied: opts.sanitization ?? [],
    imperative_likelihood: opts.imperativeLikelihood ?? 0,
    artifact_handle: opts.artifactHandle,
    content,
  };
}

export function makeSemiTrusted(
  content: string,
  sourceType: SourceType,
  opts: {
    sourceId?: string;
    contentPurpose?: ContentPurpose;
    sanitization?: string[];
  } = {},
): TrustPacketV1 {
  return {
    schema_version: 1,
    trust_level: "semi_trusted",
    source_type: sourceType,
    source_id: opts.sourceId ?? "",
    instruction_execution_allowed: false,
    content_purpose: opts.contentPurpose ?? "summary",
    excerpt_only: false,
    sanitization_applied: opts.sanitization ?? [],
    imperative_likelihood: 0,
    content,
  };
}
