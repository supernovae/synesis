import type { AppConfig } from "../config.js";
import type { Redis } from "ioredis";
import { RedisToolBlobTier } from "./redis-tool-blob-tier.js";

/**
 * Replica-safe blob storage for large tool payloads (optional; in-process {@link ArtifactStore} is default).
 * Use {@link RedisToolBlobTier} for multi-replica Yarn. A future S3/HTTP tier can implement the same interface.
 */
export interface ToolBlobTier {
  /** Store UTF-8 payload; returns stable handle for synesis_artifact_retrieve. */
  putToolBlob(payload: string): Promise<{ id: string }> | { id: string };
  getToolBlob(id: string): Promise<string | undefined> | string | undefined;
}

export { RedisToolBlobTier };

/**
 * Placeholder for a future object-store (S3/HTTP) tier. Not implemented in this package.
 */
export class UnimplementedObjectStoreBlobTier implements ToolBlobTier {
  putToolBlob(): Promise<{ id: string }> {
    return Promise.reject(
      new Error(
        "Object-store tool blob tier is not implemented. Use RedisToolBlobTier (SYNESIS_YARN_TOOL_BLOB_REDIS_ENABLED) or in-process ArtifactStore.",
      ),
    );
  }

  getToolBlob(): Promise<string | undefined> {
    return Promise.reject(
      new Error(
        "Object-store tool blob tier is not implemented. Use RedisToolBlobTier or in-process ArtifactStore.",
      ),
    );
  }
}

/**
 * Create a {@link ToolBlobTier} or null to use in-process only.
 */
export function createToolBlobTier(
  config: AppConfig,
  sessionRedis: Redis | null,
): ToolBlobTier | null {
  if (config.SYNESIS_YARN_TOOL_BLOB_REDIS_ENABLED && sessionRedis) {
    return new RedisToolBlobTier(
      sessionRedis,
      config.SYNESIS_YARN_TOOL_BLOB_REDIS_MAX_BYTES,
      config.SYNESIS_YARN_TOOL_BLOB_REDIS_TTL_S,
    );
  }
  return null;
}
