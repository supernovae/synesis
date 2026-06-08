import { requireInternalRouteToken, type PlatformRouteDependencies } from "./platform-route-support.js";

export function registerArtifactRoutes(deps: PlatformRouteDependencies): void {
  const { app, artifactStore } = deps;

  app.get("/v1/artifacts/:id", async (req, reply) => {
    if (!requireInternalRouteToken(deps, req as never, reply, "/v1/artifacts/:id")) return;
    const id = (req.params as { id: string }).id;
    const artifact = artifactStore.get(id);
    if (!artifact) {
      return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
    }
    return artifact;
  });
}
