import {
  makeUntrusted,
  makeUntrustedEvidence,
  serializeStableJson,
  type AttributionV1,
  type ContentPurpose,
  type SourceType,
} from "./trust-packet.js";
import { sanitize } from "./content-sanitizer.js";
import { SANDWICH_REMINDER } from "./operational-policy.js";

export interface RenderUntrustedPromptBlockOptions {
  title?: string;
  sourceType: SourceType;
  sourceId?: string;
  contentPurpose?: ContentPurpose;
  artifactHandle?: string;
  maxChars?: number;
  includeReminder?: boolean;
}

export interface RenderUntrustedEvidencePromptBlockOptions {
  title?: string;
  artifactHandle?: string;
  maxChars?: number;
  includeReminder?: boolean;
}

const DEFAULT_TITLE = "## Untrusted Context";
const DEFAULT_MAX_CHARS = 20_000;

function boundedContent(content: string, maxChars: number | undefined): string {
  const limit = Math.max(0, Math.min(DEFAULT_MAX_CHARS, Math.floor(maxChars ?? DEFAULT_MAX_CHARS)));
  return content.slice(0, limit);
}

function renderPacketBlock(title: string | undefined, packetJson: string, includeReminder: boolean | undefined): string {
  const lines = [title?.trim() || DEFAULT_TITLE, packetJson];
  if (includeReminder !== false) lines.push(SANDWICH_REMINDER);
  return lines.join("\n");
}

export function renderUntrustedPromptBlock(
  content: string,
  options: RenderUntrustedPromptBlockOptions,
): string {
  const sanitized = sanitize(boundedContent(content, options.maxChars));
  const packet = makeUntrusted(sanitized.text, options.sourceType, {
    sourceId: options.sourceId,
    contentPurpose: options.contentPurpose ?? "data",
    sanitization: sanitized.applied,
    imperativeLikelihood: sanitized.imperativeLikelihood,
    artifactHandle: options.artifactHandle,
  });
  return renderPacketBlock(options.title, serializeStableJson(packet), options.includeReminder);
}

export function renderUntrustedEvidencePromptBlock(
  content: string,
  attribution: AttributionV1,
  options: RenderUntrustedEvidencePromptBlockOptions = {},
): string {
  const sanitized = sanitize(boundedContent(content, options.maxChars));
  const packet = makeUntrustedEvidence(sanitized.text, attribution, {
    sanitization: sanitized.applied,
    imperativeLikelihood: sanitized.imperativeLikelihood,
    artifactHandle: options.artifactHandle,
  });
  return renderPacketBlock(options.title ?? "## Evidence", serializeStableJson(packet), options.includeReminder);
}
