import type { AppConfig } from "./config.js";
import { z } from "zod";

import { normalizeGenerationParamsFromRecord } from "./llm/generation-params.js";

const PublicOfferingGenerationParamsSchema = z.object({
  max_tokens: z.number().int().min(1).max(2_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(1_000_000).optional(),
  min_p: z.number().min(0).max(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  repetition_penalty: z.number().min(0).max(10).optional(),
  enable_thinking: z.boolean().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  model_capability_preset: z.string().optional(),
}).strict();

const PublicPlannerOfferingSchema = z.object({
  id: z.number().optional(),
  client_model_id: z.string(),
  label: z.string().nullable(),
  effort_tier: z.string(),
  connection_mode: z.string().nullable(),
  route_via_role: z.string().nullable(),
  standalone_provider: z.string().nullable(),
  standalone_endpoint: z.string().nullable(),
  standalone_api_key_env: z.string().nullable(),
  backend_model_override: z.string().nullable(),
  generation_params: PublicOfferingGenerationParamsSchema.nullable().optional(),
  expose_planner: z.boolean().optional(),
  expose_yarn: z.boolean().optional(),
  is_active: z.boolean().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
}).strict();

const PublicOfferingsEnvelopeSchema = z.object({
  offerings: z.array(PublicPlannerOfferingSchema),
  for_service: z.string().optional(),
}).strict();

export type PublicPlannerOffering = z.infer<typeof PublicPlannerOfferingSchema>;

export interface LlmRoute {
  model: string;
  baseUrl: string;
  apiKeyEnv?: string | null;
  provider?: string | null;
  role?: string | null;
  generationParams?: Record<string, unknown> | null;
}

interface InternalRoleAssignment {
  role: string;
  assigned?: boolean;
  model?: string;
  served_name?: string;
  endpoint?: string;
  provider?: string;
  api_key_env?: string;
  route_params?: Record<string, unknown> | null;
}

const POLL_MS = 120_000;

let offerings: PublicPlannerOffering[] = [];
let roleModelByRole: Record<string, string> = {};
let routeByName: Record<string, LlmRoute> = {};

export function getPlannerPublicOfferings(): PublicPlannerOffering[] {
  return offerings;
}

export function getRoleBackendModel(role: string): string | undefined {
  const m = roleModelByRole[role];
  return m?.trim() || undefined;
}

function normalizeRouteKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function generationParamsFromRecord(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const normalized = normalizeGenerationParamsFromRecord(raw);
  return normalized ? { ...normalized } : null;
}

function routeFromRole(role: InternalRoleAssignment): LlmRoute | null {
  const model = (role.model ?? "").trim();
  const baseUrl =
    (role.endpoint ?? "").trim()
    || (typeof role.route_params?.api_base === "string" ? role.route_params.api_base.trim() : "");
  if (!role.assigned || !model || !baseUrl) return null;
  return {
    model,
    baseUrl,
    apiKeyEnv: (role.api_key_env ?? "").trim() || null,
    provider: (role.provider ?? "").trim() || null,
    role: role.role,
    generationParams: generationParamsFromRecord(role.route_params),
  };
}

function addRoute(map: Record<string, LlmRoute>, key: string | null | undefined, route: LlmRoute): void {
  const normalized = normalizeRouteKey(key);
  if (normalized) map[normalized] = route;
}

export function getLlmRoute(modelOrRole: string | null | undefined): LlmRoute | undefined {
  const route = routeByName[normalizeRouteKey(modelOrRole)];
  if (!route) return undefined;
  return { ...route, generationParams: route.generationParams ? { ...route.generationParams } : null };
}

export function hasLlmRoutes(): boolean {
  return Object.keys(routeByName).length > 0;
}

export async function refreshPublicModelCatalog(config: AppConfig): Promise<void> {
  if (!config.SYNESIS_ADMIN_URL?.trim() || !config.SYNESIS_ADMIN_INTERNAL_TOKEN?.trim()) {
    return;
  }
  const base = config.SYNESIS_ADMIN_URL.replace(/\/$/, "");
  const token = config.SYNESIS_ADMIN_INTERNAL_TOKEN;
  const headers: Record<string, string> = {
    "x-synesis-service-token": token,
    "x-synesis-service-name": "synesis-planner-ts",
    authorization: `Bearer ${token}`,
  };
  let offRes: Response;
  let rolesRes: Response;
  try {
    [offRes, rolesRes] = await Promise.all([
      fetch(`${base}/api/v1/models/public-offerings/internal?for=planner`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(`${base}/api/v1/models/roles/internal`, { headers, signal: AbortSignal.timeout(8_000) }),
    ]);
  } catch {
    return;
  }
  if (offRes.ok) {
    try {
      const parsed = PublicOfferingsEnvelopeSchema.parse(await offRes.json());
      offerings = parsed.offerings;
    } catch {
      offerings = [];
    }
  }
  if (rolesRes.ok) {
    try {
      const j = (await rolesRes.json()) as {
        roles?: InternalRoleAssignment[];
      };
      const next: Record<string, string> = {};
      const nextRoutes: Record<string, LlmRoute> = {};
      for (const r of j.roles ?? []) {
        if (r.assigned && r.model?.trim()) next[r.role] = r.model.trim();
        const route = routeFromRole(r);
        if (route) {
          addRoute(nextRoutes, r.role, route);
          addRoute(nextRoutes, r.served_name, route);
          addRoute(nextRoutes, r.model, route);
        }
      }
      roleModelByRole = next;
      for (const o of offerings) {
        const mode = (o.connection_mode ?? "").trim().toLowerCase();
        if (mode !== "standalone") continue;
        const model = (o.backend_model_override ?? "").trim() || o.client_model_id.trim();
        const baseUrl = (o.standalone_endpoint ?? "").trim();
        if (!model || !baseUrl) continue;
        addRoute(nextRoutes, o.client_model_id, {
          model,
          baseUrl,
          apiKeyEnv: (o.standalone_api_key_env ?? "").trim() || null,
          provider: (o.standalone_provider ?? "").trim() || null,
          role: null,
          generationParams: generationParamsFromRecord(o.generation_params ?? null),
        });
      }
      routeByName = nextRoutes;
    } catch {
      /* keep previous */
    }
  }
}

export function startPublicModelCatalogPolling(config: AppConfig): void {
  void refreshPublicModelCatalog(config).catch(() => {
    /* keep previous catalog */
  });
  setInterval(() => {
    void refreshPublicModelCatalog(config).catch(() => {
      /* keep previous catalog */
    });
  }, POLL_MS);
}
