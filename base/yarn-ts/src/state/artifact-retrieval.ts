import type { ArtifactStore, ArtifactRecord } from "./artifact-store.js";

export const ARTIFACT_TOOL_NAME = "synesis_artifact_retrieve";

const ARTIFACT_DESCRIPTION =
  "Retrieve the full, uncompressed content of a tool result or validation output " +
  "that was previously summarized. Use when a reduced summary lacks detail needed " +
  "to complete the task. Pass the artifact_handle from the summary block.";

const ARTIFACT_PARAMETERS = {
  type: "object" as const,
  properties: {
    artifact_handle: {
      type: "string",
      description: "The artifact ID (e.g. art_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
    },
    query: {
      type: "string",
      description:
        "Optional keyword query to return only matching lines from the artifact. " +
        "Omit to get the full content."
    }
  },
  required: ["artifact_handle"]
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

  constructor(private readonly store: ArtifactStore) {}

  hasArtifacts(): boolean {
    return this.store.size() > 0;
  }

  retrieve(artifactHandle: string, query?: string): ArtifactRetrievalResult {
    const record = this.store.get(artifactHandle);
    if (!record) {
      this.missCount++;
      return {
        found: false,
        content: `Artifact ${artifactHandle} not found. It may have been evicted or the handle is incorrect.`
      };
    }

    this.retrievalCount++;

    if (!query) {
      return {
        found: true,
        content: record.payload,
        kind: record.kind,
        totalChars: record.payload.length
      };
    }

    this.queryFilterCount++;
    const lowerQuery = query.toLowerCase();
    const lines = record.payload.split("\n");
    const matched = lines.filter((line) => line.toLowerCase().includes(lowerQuery));

    if (matched.length === 0) {
      return {
        found: true,
        content: `No lines matched query "${query}" in artifact ${artifactHandle} (${lines.length} total lines).`,
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
