import crypto from "node:crypto";

export interface ArtifactRecord {
  id: string;
  kind: "validation-output" | "tool-result";
  createdAt: number;
  digest: string;
  preview: string;
  payload: string;
  payloadBytes: number;
}

export interface ArtifactStoreStats {
  artifactCount: number;
  artifactEvictions: number;
  artifactBytes: number;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly maxCount: number;
  private readonly ttlMs: number;
  private readonly maxPayloadBytes: number;
  private evictionCount = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { maxCount?: number; ttlMs?: number; maxPayloadBytes?: number }) {
    this.maxCount = opts?.maxCount ?? 500;
    this.ttlMs = opts?.ttlMs ?? 3_600_000;
    this.maxPayloadBytes = opts?.maxPayloadBytes ?? 1_048_576;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  putValidationOutput(payload: string): ArtifactRecord {
    return this.put("validation-output", payload);
  }

  putToolResult(payload: string): ArtifactRecord {
    return this.put("tool-result", payload);
  }

  put(kind: ArtifactRecord["kind"], payload: string): ArtifactRecord {
    this.evictIfNeeded();
    const id = `art_${crypto.randomUUID()}`;
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    const truncated = payloadBytes > this.maxPayloadBytes;
    const storedPayload = truncated
      ? payload.slice(0, this.maxPayloadBytes) + `\n... [truncated from ${payloadBytes} bytes]`
      : payload;
    const record: ArtifactRecord = {
      id,
      kind,
      createdAt: Date.now(),
      digest,
      preview: payload.length <= 240 ? payload : `${payload.slice(0, 240)}...`,
      payload: storedPayload,
      payloadBytes: Buffer.byteLength(storedPayload, "utf8"),
    };
    this.artifacts.set(id, record);
    return record;
  }

  get(id: string): ArtifactRecord | undefined {
    return this.artifacts.get(id);
  }

  size(): number {
    return this.artifacts.size;
  }

  getStats(): ArtifactStoreStats {
    let totalBytes = 0;
    for (const r of this.artifacts.values()) {
      totalBytes += r.payloadBytes;
    }
    return {
      artifactCount: this.artifacts.size,
      artifactEvictions: this.evictionCount,
      artifactBytes: totalBytes,
    };
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private evictIfNeeded(): void {
    while (this.artifacts.size >= this.maxCount) {
      const oldest = this.artifacts.keys().next().value!;
      this.artifacts.delete(oldest);
      this.evictionCount += 1;
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, rec] of this.artifacts) {
      if (rec.createdAt < cutoff) {
        this.artifacts.delete(id);
        this.evictionCount += 1;
      }
    }
  }
}
