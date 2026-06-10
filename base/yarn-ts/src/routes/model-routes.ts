import type { PlatformRouteDependencies } from "./platform-route-support.js";
import { authorizeModelCatalogRequest } from "./platform-route-support.js";

export function registerModelRoutes(deps: PlatformRouteDependencies): void {
  const { app, tierRegistry } = deps;

  app.get("/v1", async () => ({
    status: "ok",
    service: "synesis-yarn-ts",
    version: "0.2.0",
    endpoints: ["/v1/models", "/v1/models/{model}", "/v1/chat/completions", "/v1/responses", "/v1/messages"],
  }));

  app.get("/v1/models", async (req, reply) => {
    const auth = await authorizeModelCatalogRequest(deps, req.headers.authorization);
    if (!auth.ok) {
      if (auth.retryAfter != null) reply.header("Retry-After", String(auth.retryAfter));
      return reply.code(auth.statusCode).send(auth.body);
    }
    return {
      object: "list",
      data: tierRegistry.getAvailableModels(),
    };
  });

  app.get("/v1/models/:model", async (req, reply) => {
    const auth = await authorizeModelCatalogRequest(deps, req.headers.authorization);
    if (!auth.ok) {
      if (auth.retryAfter != null) reply.header("Retry-After", String(auth.retryAfter));
      return reply.code(auth.statusCode).send(auth.body);
    }
    const { model } = req.params as { model: string };
    const found = tierRegistry.getAvailableModels().find((entry) => entry.id === model);
    if (!found) {
      return reply.code(404).send({
        error: { type: "invalid_request_error", message: `Model '${model}' was not found.` },
      });
    }
    return found;
  });
}
