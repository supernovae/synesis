import type { FastifyBaseLogger } from "fastify";
import type { CapabilityMatrixDocument } from "./resolver.js";

interface CapabilityMatrixClientConfig {
  adminUrl: string;
  adminToken: string;
  refreshMs: number;
  logger: FastifyBaseLogger;
}

const DEFAULT_MATRIX: CapabilityMatrixDocument = {
  version: 1,
  mode: "enforced",
  global_optimizations_enabled: false,
  overrides: [],
};

export class CapabilityMatrixClient {
  private readonly config: CapabilityMatrixClientConfig;
  private matrix: CapabilityMatrixDocument = DEFAULT_MATRIX;
  private timer: NodeJS.Timeout | null = null;
  private etag = "";
  private lastRefreshAtMs = 0;
  private refreshFailures = 0;

  constructor(config: CapabilityMatrixClientConfig) {
    this.config = config;
  }

  start(): void {
    if (!this.config.adminUrl || !this.config.adminToken) {
      this.config.logger.warn("capability_matrix_disabled_missing_admin_credentials");
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

  getMatrix(): CapabilityMatrixDocument {
    return this.matrix ?? DEFAULT_MATRIX;
  }

  getStats(): {
    loaded: boolean;
    etag: string;
    mode: string;
    globalOptimizationsEnabled: boolean;
    overrideCount: number;
    lastRefreshAtMs: number;
    refreshFailures: number;
  } {
    return {
      loaded: Boolean(this.matrix),
      etag: this.etag,
      mode: this.matrix.mode ?? "enforced",
      globalOptimizationsEnabled: this.matrix.global_optimizations_enabled === true,
      overrideCount: this.matrix.overrides?.length ?? 0,
      lastRefreshAtMs: this.lastRefreshAtMs,
      refreshFailures: this.refreshFailures,
    };
  }

  private async refresh(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.config.adminToken}`,
        "x-synesis-service-token": this.config.adminToken,
        "x-synesis-service-name": "synesis-planner-ts",
      };
      if (this.etag) headers["if-none-match"] = `"${this.etag}"`;
      const resp = await fetch(`${this.config.adminUrl.replace(/\/$/, "")}/api/v1/governance/capability-matrix/effective`, {
        headers,
      });
      if (resp.status === 304) {
        this.lastRefreshAtMs = Date.now();
        return;
      }
      if (!resp.ok) {
        throw new Error(`capability matrix fetch failed ${resp.status}`);
      }
      const payload = (await resp.json()) as CapabilityMatrixDocument & { etag?: string };
      this.matrix = {
        version: Number(payload.version ?? 1),
        mode: payload.mode === "shadow" ? "shadow" : "enforced",
        global_optimizations_enabled: payload.global_optimizations_enabled === true,
        overrides: Array.isArray(payload.overrides) ? payload.overrides : [],
      };
      this.etag = String(payload.etag ?? "");
      this.lastRefreshAtMs = Date.now();
    } catch (err) {
      this.refreshFailures += 1;
      this.config.logger.warn({ err }, "capability_matrix_refresh_failed");
    }
  }
}
