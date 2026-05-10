import type { AppConfig } from "./config.js";

export interface PublicPlannerOffering {
  client_model_id: string;
  label: string | null;
  effort_tier: string;
  connection_mode: string | null;
  route_via_role: string | null;
  standalone_provider: string | null;
  standalone_endpoint: string | null;
  standalone_api_key_env: string | null;
  backend_model_override: string | null;
  generation_params?: Record<string, unknown> | null;
}

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
  litellm_params?: Record<string, unknown> | null;
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
  if (!raw || typeof raw !== "object") return null;
  const allowed = [
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "repetition_penalty",
    "enable_thinking",
    "reasoning_effort",
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function routeFromRole(role: InternalRoleAssignment): LlmRoute | null {
  const model = (role.model ?? "").trim();
  const baseUrl =
    (role.endpoint ?? "").trim()
    || (typeof role.litellm_params?.api_base === "string" ? role.litellm_params.api_base.trim() : "");
  if (!role.assigned || !model || !baseUrl) return null;
  return {
    model,
    baseUrl,
    apiKeyEnv: (role.api_key_env ?? "").trim() || null,
    provider: (role.provider ?? "").trim() || null,
    role: role.role,
    generationParams: generationParamsFromRecord(role.litellm_params),
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
  const [offRes, rolesRes] = await Promise.all([
    fetch(`${base}/api/v1/models/public-offerings/internal?for=planner`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    }),
    fetch(`${base}/api/v1/models/roles/internal`, { headers, signal: AbortSignal.timeout(8_000) }),
  ]);
  if (offRes.ok) {
    try {
      const j = (await offRes.json()) as { offerings?: PublicPlannerOffering[] };
      offerings = Array.isArray(j.offerings) ? j.offerings : [];
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
  void refreshPublicModelCatalog(config);
  setInterval(() => {
    void refreshPublicModelCatalog(config);
  }, POLL_MS);
}
