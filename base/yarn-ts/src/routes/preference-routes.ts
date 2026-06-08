import { z } from "zod";
import {
  normalizeUserRuntimePreferences,
  userRuntimePreferencesResponse,
} from "../runtime/user-preferences.js";
import { requireInternalRouteToken, type PlatformRouteDependencies } from "./platform-route-support.js";

const PreferenceRouteParamsSchema = z.object({
  userId: z.string().trim().min(1).max(256),
}).strict();

const PreferenceRouteQuerySchema = z.object({
  org_id: z.string().trim().min(1).max(256).optional(),
  orgId: z.string().trim().min(1).max(256).optional(),
}).strict();

const LoopBreakModeSchema = z.enum(["standard", "assertive", "hands_off"]);
const CachePolicyBiasSchema = z.enum(["auto", "cache_first", "balanced", "efficiency_first"]);
const SynesisMemoryModeSchema = z.enum(["off", "observe", "safe", "adaptive", "aggressive", "adapt", "strict", "always"]);
const MaxToolLoopSoftFailsSchema = z.union([
  z.number().int().min(1).max(20),
  z.string().trim().regex(/^\d{1,2}$/),
  z.null(),
]);

export const UserRuntimePreferencesUpdateSchema = z.object({
  loopBreakMode: LoopBreakModeSchema.optional(),
  loop_break_mode: LoopBreakModeSchema.optional(),
  cachePolicyBias: CachePolicyBiasSchema.optional(),
  cache_policy_bias: CachePolicyBiasSchema.optional(),
  synesisMemoryMode: SynesisMemoryModeSchema.optional(),
  synesis_memory_mode: SynesisMemoryModeSchema.optional(),
  synesis_memory: SynesisMemoryModeSchema.optional(),
  contextMediation: SynesisMemoryModeSchema.optional(),
  context_mediation: SynesisMemoryModeSchema.optional(),
  allowAggressiveCompactionWithoutCacheHits: z.boolean().optional(),
  allow_aggressive_compaction_without_cache_hits: z.boolean().optional(),
  maxToolLoopSoftFails: MaxToolLoopSoftFailsSchema.optional(),
  max_tool_loop_soft_fails: MaxToolLoopSoftFailsSchema.optional(),
}).strict();

export function registerPreferenceRoutes(deps: PlatformRouteDependencies): void {
  const { app, config, sessionStore, loadUserRuntimePreferences, formatValidationError } = deps;

  app.get("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalRouteToken(deps, req as never, reply, "/v1/user-runtime-preferences/:userId")) return;
    const parsedParams = PreferenceRouteParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsedParams.error) } });
    }
    const parsedQuery = PreferenceRouteQuerySchema.safeParse((req as { query?: unknown }).query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsedQuery.error) } });
    }
    const { userId } = parsedParams.data;
    const orgId = parsedQuery.data.org_id ?? parsedQuery.data.orgId;
    if (!orgId) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: "org_id is required" } });
    }
    const preferences = await loadUserRuntimePreferences(orgId, userId);
    return userRuntimePreferencesResponse(preferences);
  });

  app.put("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalRouteToken(deps, req as never, reply, "/v1/user-runtime-preferences/:userId")) return;
    const parsedParams = PreferenceRouteParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsedParams.error) } });
    }
    const parsedQuery = PreferenceRouteQuerySchema.safeParse((req as { query?: unknown }).query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsedQuery.error) } });
    }
    const orgId = parsedQuery.data.org_id ?? parsedQuery.data.orgId;
    if (!orgId) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: "org_id is required" } });
    }
    const parsedBody = UserRuntimePreferencesUpdateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsedBody.error) } });
    }
    const { userId } = parsedParams.data;
    const preferences = normalizeUserRuntimePreferences({ ...parsedBody.data, updatedAt: Date.now() });
    await sessionStore.saveUserRuntimePreferences(
      orgId,
      userId,
      preferences,
      config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS,
    );
    return userRuntimePreferencesResponse(preferences);
  });
}
