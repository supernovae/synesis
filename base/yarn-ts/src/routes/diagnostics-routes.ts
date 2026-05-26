import { summarizeCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";
import type { PlatformRouteDependencies } from "./platform-route-support.js";

export function registerDiagnosticsRoutes(deps: PlatformRouteDependencies): void {
  const { app, requireInternalToken, diagnosticRegistry } = deps;

  app.get("/v1/diagnostics/recent", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const recent = await diagnosticRegistry.listRecent();
    return { diagnostics: recent.diagnostics, count: recent.diagnostics.length, source: recent.source };
  });

  app.get("/v1/diagnostics/cache-shapes/recent", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const recent = await diagnosticRegistry.listRecent();
    const summaries = summarizeCacheShapeDiagnostics(
      recent.diagnostics as Array<Record<string, unknown>>,
      diagnosticRegistry.getRingStats().max,
    );
    return {
      summaries,
      count: summaries.length,
      diagnosticCount: recent.diagnostics.length,
      source: recent.source,
    };
  });

  app.get("/v1/diagnostics/:requestId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const { requestId } = req.params as { requestId: string };
    const diagnostic = await diagnosticRegistry.getByRequestId(requestId);
    if (diagnostic) return diagnostic;
    return reply.code(404).send({ error: { type: "not_found", message: "Diagnostic not found" } });
  });
}
