import type { FastifyBaseLogger } from "fastify";

export interface PromptProfile {
  id: number;
  name: string;
  service: string;
  content: string;
  content_hash: string;
}

export interface PromptAssignment {
  id: number;
  service: string;
  target_type: string;
  target_value: string;
  profile_id: number;
}

export interface PromptSnapshot {
  service: string;
  profiles: PromptProfile[];
  assignments: PromptAssignment[];
  updated_at?: string | null;
}

interface PromptRegistryConfig {
  adminUrl: string;
  adminToken: string;
  refreshMs: number;
  logger: FastifyBaseLogger;
}

export class PromptRegistry {
  private readonly config: PromptRegistryConfig;
  private snapshot: PromptSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAtMs = 0;
  private refreshFailures = 0;

  constructor(config: PromptRegistryConfig) {
    this.config = config;
  }

  start(): void {
    if (!this.config.adminUrl || !this.config.adminToken) {
      this.config.logger.warn("prompt_registry_disabled_missing_admin_credentials");
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, Math.max(5000, this.config.refreshMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): PromptSnapshot | null {
    return this.snapshot;
  }

  getStats(): {
    loaded: boolean;
    profiles: number;
    assignments: number;
    profileHashes: string[];
    updatedAt: string | null;
    lastRefreshAtMs: number;
    refreshFailures: number;
  } {
    return {
      loaded: Boolean(this.snapshot),
      profiles: this.snapshot?.profiles.length ?? 0,
      assignments: this.snapshot?.assignments.length ?? 0,
      profileHashes: (this.snapshot?.profiles ?? []).map((p) => p.content_hash).slice(0, 12),
      updatedAt: this.snapshot?.updated_at ?? null,
      lastRefreshAtMs: this.lastRefreshAtMs,
      refreshFailures: this.refreshFailures,
    };
  }

  private async refresh(): Promise<void> {
    try {
      const resp = await fetch(`${this.config.adminUrl.replace(/\/$/, "")}/api/v1/models/prompts/internal/planner`, {
        headers: {
          authorization: `Bearer ${this.config.adminToken}`,
          "x-synesis-service-token": this.config.adminToken,
          "x-synesis-service-name": "synesis-planner-ts",
        },
      });
      if (!resp.ok) {
        throw new Error(`prompt snapshot fetch failed ${resp.status}`);
      }
      const payload = (await resp.json()) as PromptSnapshot;
      if (!payload || payload.service !== "planner" || !Array.isArray(payload.profiles) || !Array.isArray(payload.assignments)) {
        throw new Error("invalid prompt snapshot payload");
      }
      this.snapshot = payload;
      this.lastRefreshAtMs = Date.now();
    } catch (err) {
      this.refreshFailures += 1;
      this.config.logger.warn({ err }, "prompt_registry_refresh_failed");
    }
  }
}
