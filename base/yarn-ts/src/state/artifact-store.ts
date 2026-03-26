import crypto from "node:crypto";

export interface ArtifactRecord {
  id: string;
  kind: "validation-output" | "tool-result";
  createdAt: number;
  digest: string;
  preview: string;
  payload: string;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();

  putValidationOutput(payload: string): ArtifactRecord {
    return this.put("validation-output", payload);
  }

  putToolResult(payload: string): ArtifactRecord {
    return this.put("tool-result", payload);
  }

  put(kind: ArtifactRecord["kind"], payload: string): ArtifactRecord {
    const id = `art_${crypto.randomUUID()}`;
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const record: ArtifactRecord = {
      id,
      kind,
      createdAt: Date.now(),
      digest,
      preview: payload.length <= 240 ? payload : `${payload.slice(0, 240)}...`,
      payload
    };
    this.artifacts.set(id, record);
    return record;
  }

  get(id: string): ArtifactRecord | undefined {
    return this.artifacts.get(id);
  }
}
