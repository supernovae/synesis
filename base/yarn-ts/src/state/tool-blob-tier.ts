/**
 * Future replica-safe archival for tool payloads (Track B extension).
 * In-process {@link ArtifactStore} remains the default; a Redis- or object-store-backed
 * implementation can satisfy this interface for multi-replica Yarn without sticky sessions.
 */
export interface ToolBlobTier {
  /** Store UTF-8 payload; returns stable handle for synesis_artifact_retrieve. */
  putToolBlob(payload: string): Promise<{ id: string }> | { id: string };
  getToolBlob(id: string): Promise<string | undefined> | string | undefined;
}
