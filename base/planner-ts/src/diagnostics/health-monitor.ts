import type { AppConfig } from "../config.js";
import type { SessionStore } from "../context/session-store.js";
import { hasLlmRoutes } from "../public-model-catalog.js";

export interface DependencyCheck {
  name: string;
  configured: boolean;
  ok: boolean;
  detail: string;
  checkedAt: number;
}

export interface DependencySnapshot {
  status: "ok" | "degraded";
  checkedAt: number;
  checks: DependencyCheck[];
}

export class DependencyHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: DependencySnapshot = {
    status: "ok",
    checkedAt: Date.now(),
    checks: [],
  };

  constructor(
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
  ) {}

  start(): void {
    if (!this.config.SYNESIS_PLANNER_TS_HEALTH_MONITOR_ENABLED) return;
    if (this.timer) return;
    void this.probe();
    this.timer = setInterval(() => {
      void this.probe();
    }, this.config.SYNESIS_PLANNER_TS_HEALTH_MONITOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): DependencySnapshot {
    return this.latest;
  }

  async probe(): Promise<DependencySnapshot> {
    const timeoutMs = this.config.SYNESIS_PLANNER_TS_HEALTH_MONITOR_TIMEOUT_MS;
    const checks: DependencyCheck[] = [];

    checks.push(this.llmRouteCheck());
    checks.push(await this.redisCheck(timeoutMs));
    checks.push(await this.httpCheck("openfga", this.config.SYNESIS_OPENFGA_API_URL, "/healthz", timeoutMs));
    checks.push(await this.httpCheck("admin", this.config.SYNESIS_ADMIN_URL, "/health", timeoutMs, this.config.SYNESIS_ADMIN_INTERNAL_TOKEN));
    checks.push(await this.httpCheck("embedder", this.config.SYNESIS_EMBEDDER_URL, "/health", timeoutMs));
    checks.push(await this.httpCheck("web_search", this.config.SYNESIS_WEB_SEARCH_URL, "/health", timeoutMs));
    checks.push(await this.httpCheck("gliner", this.config.SYNESIS_GLINER_SERVICE_URL, "/health", timeoutMs));

    const configuredChecks = checks.filter((c) => c.configured);
    const allConfiguredHealthy = configuredChecks.every((c) => c.ok);
    this.latest = {
      status: allConfiguredHealthy ? "ok" : "degraded",
      checkedAt: Date.now(),
      checks,
    };
    return this.latest;
  }

  private llmRouteCheck(): DependencyCheck {
    const checkedAt = Date.now();
    const configured = Boolean(this.config.SYNESIS_PLANNER_TS_LLM_ENABLED);
    const hasFallback = Boolean(this.config.SYNESIS_PLANNER_TS_LLM_BASE_URL);
    const hasAdminRoutes = hasLlmRoutes();
    return {
      name: "llm_routes",
      configured,
      ok: !configured || hasAdminRoutes || hasFallback,
      detail: hasAdminRoutes ? "admin_routes_loaded" : hasFallback ? "fallback_base_url_configured" : "no_routes_loaded",
      checkedAt,
    };
  }

  private async redisCheck(timeoutMs: number): Promise<DependencyCheck> {
    const configured = Boolean(this.config.SYNESIS_PLANNER_TS_REDIS_URL);
    const checkedAt = Date.now();
    if (!configured) {
      return { name: "redis", configured, ok: true, detail: "not_configured", checkedAt };
    }
    try {
      const out = await Promise.race([
        this.sessionStore.ping(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      return {
        name: "redis",
        configured,
        ok: out,
        detail: out ? "pong" : "ping_failed_or_timeout",
        checkedAt,
      };
    } catch (error) {
      return {
        name: "redis",
        configured,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  private async httpCheck(
    name: string,
    baseUrl: string,
    path: string,
    timeoutMs: number,
    bearerToken = "",
  ): Promise<DependencyCheck> {
    const configured = Boolean(baseUrl);
    const checkedAt = Date.now();
    if (!configured) {
      return { name, configured, ok: true, detail: "not_configured", checkedAt };
    }
    try {
      const url = `${baseUrl.replace(/\/$/, "")}${path}`;
      const resp = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      });
      return {
        name,
        configured,
        ok: resp.ok,
        detail: `status_${resp.status}`,
        checkedAt,
      };
    } catch (error) {
      return {
        name,
        configured,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }
}
