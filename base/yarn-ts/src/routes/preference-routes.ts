import {
  normalizeUserRuntimePreferences,
  userRuntimePreferencesResponse,
} from "../runtime/user-preferences.js";
import type { PlatformRouteDependencies } from "./platform-route-support.js";

export function registerPreferenceRoutes(deps: PlatformRouteDependencies): void {
  const { app, config, requireInternalToken, sessionStore, loadUserRuntimePreferences } = deps;

  app.get("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
    }
    const { userId } = req.params as { userId: string };
    const preferences = await loadUserRuntimePreferences(userId);
    return userRuntimePreferencesResponse(preferences);
  });

  app.put("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
    }
    const { userId } = req.params as { userId: string };
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const preferences = normalizeUserRuntimePreferences({ ...body, updatedAt: Date.now() });
    await sessionStore.saveUserRuntimePreferences(
      userId,
      preferences,
      config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS,
    );
    return userRuntimePreferencesResponse(preferences);
  });
}
