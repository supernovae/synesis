import type { Redis } from "ioredis";
import { ARTIFACT_REDIS_REPLICA_PREFIX, type ArtifactStore, type ArtifactRecord } from "./artifact-store.js";

export const ARTIFACT_TOOL_NAME = "synesis_artifact_retrieve";
const ARTIFACT_HANDLE_RE = /^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARTIFACT_QUERY_MAX_CHARS = 256;

const ARTIFACT_DESCRIPTION =
  "Retrieve the full, uncompressed content of a tool result or validation output " +
  "that was previously summarized. Use when a reduced summary lacks detail needed " +
  "to complete the task. Pass the artifact_handle from the summary block.";

const ARTIFACT_PARAMETERS = {
  type: "object" as const,
  properties: {
    artifact_handle: {
      type: "string",
      pattern: "^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      maxLength: 40,
      description: "The artifact ID (e.g. art_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
    },
    query: {
      type: "string",
      maxLength: ARTIFACT_QUERY_MAX_CHARS,
      description:
        "Optional keyword query to return only matching lines from the artifact. " +
        "Omit to get the full content."
    }
  },
  required: ["artifact_handle"],
  additionalProperties: false
};

export const ARTIFACT_TOOL_SCHEMA_OPENAI = {
  type: "function" as const,
  function: {
    name: ARTIFACT_TOOL_NAME,
    description: ARTIFACT_DESCRIPTION,
    parameters: ARTIFACT_PARAMETERS
  }
};

export const ARTIFACT_TOOL_SCHEMA_CLAUDE = {
  name: ARTIFACT_TOOL_NAME,
  description: ARTIFACT_DESCRIPTION,
  input_schema: ARTIFACT_PARAMETERS
};

export interface ArtifactRetrievalResult {
  found: boolean;
  content: string;
  kind?: ArtifactRecord["kind"];
  totalChars?: number;
  matchedLines?: number;
}

export class ArtifactRetrievalService {
  private retrievalCount = 0;
  private missCount = 0;
  private queryFilterCount = 0;

  constructor(
    private readonly store: ArtifactStore,
    private readonly replica?: { redis: Redis | null; enabled: boolean },
  ) {}

  hasArtifacts(): boolean {
    return this.store.size() > 0;
  }

  async retrieve(artifactHandle: string, query?: string): Promise<ArtifactRetrievalResult> {
    const handle = normalizeArtifactHandle(artifactHandle);
    if (!handle) {
      this.missCount++;
      return {
        found: false,
        content: "Artifact not found. The handle is invalid or unavailable."
      };
    }

    let record = this.store.get(handle);
    if (!record && this.replica?.enabled && this.replica.redis) {
      const raw = await this.replica.redis.get(`${ARTIFACT_REDIS_REPLICA_PREFIX}${handle}`);
      if (raw) {
        try {
          record = parseArtifactRecord(JSON.parse(raw), handle);
        } catch {
          record = undefined;
        }
      }
    }
    if (!record) {
      this.missCount++;
      return {
        found: false,
        content: "Artifact not found. It may have been evicted or the handle is incorrect."
      };
    }

    this.retrievalCount++;

    const normalizedQuery = normalizeArtifactQuery(query);
    if (!normalizedQuery) {
      return {
        found: true,
        content: record.payload,
        kind: record.kind,
        totalChars: record.payload.length
      };
    }

    this.queryFilterCount++;
    const lowerQuery = normalizedQuery.toLowerCase();
    const lines = record.payload.split("\n");
    const matched = lines.filter((line) => line.toLowerCase().includes(lowerQuery));

    if (matched.length === 0) {
      return {
        found: true,
        content: `No lines matched query in artifact (${lines.length} total lines).`,
        kind: record.kind,
        totalChars: record.payload.length,
        matchedLines: 0
      };
    }

    return {
      found: true,
      content: matched.join("\n"),
      kind: record.kind,
      totalChars: record.payload.length,
      matchedLines: matched.length
    };
  }

  injectToolOpenAI(tools: unknown[] | undefined): unknown[] | undefined {
    if (!this.hasArtifacts()) return tools;
    if (!tools) return [ARTIFACT_TOOL_SCHEMA_OPENAI];
    const exists = (tools as Array<{ function?: { name?: string } }>).some(
      (t) => t.function?.name === ARTIFACT_TOOL_NAME
    );
    if (exists) return tools;
    return [...tools, ARTIFACT_TOOL_SCHEMA_OPENAI];
  }

  injectToolClaude(tools: unknown[] | undefined): unknown[] | undefined {
    if (!this.hasArtifacts()) return tools;
    if (!tools) return [ARTIFACT_TOOL_SCHEMA_CLAUDE];
    const exists = (tools as Array<{ name?: string }>).some(
      (t) => t.name === ARTIFACT_TOOL_NAME
    );
    if (exists) return tools;
    return [...tools, ARTIFACT_TOOL_SCHEMA_CLAUDE];
  }

  getStats() {
    return {
      retrievalCount: this.retrievalCount,
      missCount: this.missCount,
      queryFilterCount: this.queryFilterCount
    };
  }
}

function normalizeArtifactHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const handle = value.trim();
  return ARTIFACT_HANDLE_RE.test(handle) ? handle : null;
}

function normalizeArtifactQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return replaceControlCharsWithSpace(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ARTIFACT_QUERY_MAX_CHARS)
    .trim();
}

function parseArtifactRecord(value: unknown, expectedHandle: string): ArtifactRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.id !== expectedHandle) return undefined;
  if (row.kind !== "validation-output" && row.kind !== "tool-result") return undefined;
  if (typeof row.payload !== "string" || typeof row.preview !== "string" || typeof row.digest !== "string") return undefined;
  return {
    id: expectedHandle,
    kind: row.kind,
    createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    digest: row.digest,
    preview: row.preview,
    payload: row.payload,
    payloadBytes: typeof row.payloadBytes === "number" && Number.isFinite(row.payloadBytes)
      ? Math.max(0, Math.floor(row.payloadBytes))
      : Buffer.byteLength(row.payload, "utf8"),
  };
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}
