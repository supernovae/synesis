import { requireInternalRouteToken, type PlatformRouteDependencies } from "./platform-route-support.js";

export function registerHealthRoutes(deps: PlatformRouteDependencies): void {
  const { app, usagePersistenceEnabled, usageWriter, sessionStore, promRegistry } = deps;

  app.get("/health", async () => ({
    status: "ok",
    usage_persistence_enabled: usagePersistenceEnabled,
    usage_write_queue: usageWriter.getStats(),
  }));

  app.get("/health/readiness", async (_req, reply) => {
    const redisOk = await sessionStore.ping();
    if (!redisOk) {
      return reply.code(503).send({ status: "not_ready", reason: "redis_unreachable" });
    }
    return { status: "ready" };
  });

  app.get("/metrics", async (req, reply) => {
    if (!requireInternalRouteToken(deps, req as never, reply, "/metrics")) return;
    reply.header("Content-Type", promRegistry.contentType);
    return promRegistry.metrics();
  });
}
