import { randomUUID } from "node:crypto";
import { ArtifactEnvelopeSchema } from "./schemas.js";
import type { ArtifactEnvelope, ArtifactStore } from "./types.js";

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactEnvelope>();

  async put<T>(artifact: Omit<ArtifactEnvelope<T>, "artifactId" | "createdAtIso">): Promise<ArtifactEnvelope<T>> {
    const saved: ArtifactEnvelope<T> = {
      ...artifact,
      artifactId: `art_${randomUUID()}`,
      createdAtIso: new Date().toISOString(),
    };
    const parsed = ArtifactEnvelopeSchema.parse(saved) as ArtifactEnvelope<T>;
    this.artifacts.set(parsed.artifactId, parsed as ArtifactEnvelope);
    return parsed;
  }

  async get<T>(artifactId: string): Promise<ArtifactEnvelope<T> | null> {
    return (this.artifacts.get(artifactId) as ArtifactEnvelope<T> | undefined) ?? null;
  }

  async listByTrace(traceId: string): Promise<ArtifactEnvelope[]> {
    const out: ArtifactEnvelope[] = [];
    for (const art of this.artifacts.values()) {
      if (art.traceId === traceId) out.push(art);
    }
    return out;
  }
}
