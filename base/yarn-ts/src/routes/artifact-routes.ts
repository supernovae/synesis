import type { PlatformRouteDependencies } from "./platform-route-support.js";

export function registerArtifactRoutes(deps: PlatformRouteDependencies): void {
  const { app, requireInternalToken, artifactStore } = deps;

  app.get("/v1/artifacts/:id", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({
        error: { type: "auth_error", message: "Internal service token required" },
      });
    }
    const id = (req.params as { id: string }).id;
    const artifact = artifactStore.get(id);
    if (!artifact) {
      return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
    }
    return artifact;
  });
}
