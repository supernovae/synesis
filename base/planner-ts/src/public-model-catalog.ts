import type { AppConfig } from "./config.js";

export interface PublicPlannerOffering {
  client_model_id: string;
  label: string | null;
  effort_tier: string;
  backend_model_override: string | null;
}

const POLL_MS = 120_000;

let offerings: PublicPlannerOffering[] = [];
let roleModelByRole: Record<string, string> = {};

export function getPlannerPublicOfferings(): PublicPlannerOffering[] {
  return offerings;
}

export function getRoleBackendModel(role: string): string | undefined {
  const m = roleModelByRole[role];
  return m?.trim() || undefined;
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
        roles?: Array<{ role: string; assigned?: boolean; model?: string }>;
      };
      const next: Record<string, string> = {};
      for (const r of j.roles ?? []) {
        if (r.assigned && r.model?.trim()) next[r.role] = r.model.trim();
      }
      roleModelByRole = next;
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
