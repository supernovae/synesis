import * as crypto from "node:crypto";
import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { runKnowledgeSearch } from "./knowledge.js";
import { LIMITS, clampInt } from "./tool-utils.js";

type PlanAction = "no-op" | "create" | "read" | "update" | "delete" | string;
type TerraformMetadataContext = {
  core_safety?: "0" | "1" | "2";
  risk_notes?: string;
  policy_reference?: string;
  provider?: string;
  resource_type?: string;
};

export interface TerraformResourceRisk {
  address: string;
  type: string;
  providerName: string;
  actions: PlanAction[];
  hardGateRequired: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskReason: string;
  metadataContext: TerraformMetadataContext;
}

function stableId(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function parsePlan(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    if (raw.length > LIMITS.maxTerraformPlanChars) {
      throw new Error("terraform_plan_too_large");
    }
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  }
  if (typeof raw === "object" && raw !== null) {
    const serialized = JSON.stringify(raw);
    if (serialized.length > LIMITS.maxTerraformPlanChars) {
      throw new Error("terraform_plan_too_large");
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function normalizeTerraformMetadata(type: string, value: unknown): TerraformMetadataContext {
  const raw = asRecord(value);
  const coreSafety = String(raw.core_safety ?? "").trim();
  return {
    resource_type: typeof raw.resource_type === "string" ? raw.resource_type : type,
    ...(coreSafety === "0" || coreSafety === "1" || coreSafety === "2" ? { core_safety: coreSafety } : {}),
    ...(typeof raw.risk_notes === "string" ? { risk_notes: raw.risk_notes.slice(0, LIMITS.mediumStringChars) } : {}),
    ...(typeof raw.policy_reference === "string" ? { policy_reference: raw.policy_reference.slice(0, LIMITS.mediumStringChars) } : {}),
    ...(typeof raw.provider === "string" ? { provider: raw.provider.slice(0, LIMITS.shortStringChars) } : {}),
  };
}

function metadataFor(type: string, synpackMetadata: Record<string, unknown>): TerraformMetadataContext {
  const resources = Array.isArray(synpackMetadata.resources) ? synpackMetadata.resources : [];
  const direct = resources.find((item) => asRecord(item).resource_type === type);
  return direct ? normalizeTerraformMetadata(type, direct) : {};
}

function riskFromActions(actions: string[], metadata: TerraformMetadataContext): Pick<TerraformResourceRisk, "hardGateRequired" | "riskLevel" | "riskReason"> {
  const replacement = actions.includes("delete") && actions.includes("create");
  const deletion = actions.includes("delete") && !actions.includes("create");
  const update = actions.includes("update");
  const coreSafety = String(metadata.core_safety ?? "").trim();
  if (replacement || deletion || coreSafety === "0") {
    return {
      hardGateRequired: true,
      riskLevel: deletion && !replacement ? "CRITICAL" : "HIGH",
      riskReason: replacement ? "Plan replaces the resource with delete/create actions." : deletion ? "Plan deletes the resource." : "SynPack metadata marks this resource as destructive.",
    };
  }
  if (update || coreSafety === "1") {
    return {
      hardGateRequired: false,
      riskLevel: "MEDIUM",
      riskReason: "Plan updates an existing resource; verify drift, provider permissions, and in-place semantics.",
    };
  }
  return {
    hardGateRequired: false,
    riskLevel: "LOW",
    riskReason: "Plan appears additive or read-only.",
  };
}

export function analyzeTerraformPlanLocal(args: Record<string, unknown>, fetchedMetadata: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  const plan = parsePlan(args.plan_json);
  const resourceChanges = Array.isArray(plan.resource_changes)
    ? plan.resource_changes.slice(0, LIMITS.maxTerraformResources)
    : [];
  const suppliedMetadata = asRecord(args.synpack_metadata);
  const risks: TerraformResourceRisk[] = [];

  for (const rawChange of resourceChanges) {
    const change = asRecord(rawChange);
    const changeBody = asRecord(change.change);
    const address = String(change.address ?? "");
    const type = String(change.type ?? "");
    const providerName = String(change.provider_name ?? "");
    const actions = asStringArray(changeBody.actions);
    const metadata: TerraformMetadataContext = {
      ...metadataFor(type, suppliedMetadata),
      ...normalizeTerraformMetadata(type, fetchedMetadata[type] ?? {}),
    };
    const risk = riskFromActions(actions, metadata);
    risks.push({
      address,
      type,
      providerName,
      actions,
      metadataContext: metadata,
      ...risk,
    });
  }

  const hardGateResources = risks.filter((r) => r.hardGateRequired);
  const highestRisk = risks.some((r) => r.riskLevel === "CRITICAL")
    ? "CRITICAL"
    : risks.some((r) => r.riskLevel === "HIGH")
      ? "HIGH"
      : risks.some((r) => r.riskLevel === "MEDIUM")
        ? "MEDIUM"
        : "LOW";
  const approvalRequest = hardGateResources.length > 0
    ? {
        request_id: `tfplan_${stableId({ risks: hardGateResources })}`,
        action: "HARD_GATE",
        resources: hardGateResources.map((r) => ({
          address: r.address,
          type: r.type,
          provider_name: r.providerName,
          actions: r.actions,
          risk_reason: r.riskReason,
          metadata_context: r.metadataContext,
        })),
        agent_directive:
          "Do not suggest terraform apply. Explain the destructive plan actions, look for a non-replacement alternative, or request explicit human approval with this bundle.",
      }
    : null;

  return {
    ok: true,
    analyzer: "terraform_plan_risk_v1",
    resource_count: risks.length,
    hard_gate_required: hardGateResources.length > 0,
    highest_risk: highestRisk,
    risk_summary: risks,
    approval_request: approvalRequest,
  };
}

function extractFirstMetadata(payload: unknown): Record<string, TerraformMetadataContext> {
  const out: Record<string, TerraformMetadataContext> = {};
  const results = Array.isArray(asRecord(payload).results) ? asRecord(payload).results as unknown[] : [];
  for (const result of results) {
    const row = asRecord(result);
    const symbol = String(row.symbol_fqn ?? "");
    const json = String(row.agent_enrichment_json ?? "");
    if (!symbol || !json || out[symbol]) continue;
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null) out[symbol] = normalizeTerraformMetadata(symbol, parsed);
    } catch {
      // Ignore malformed metadata; plan analysis remains deterministic from plan actions.
    }
  }
  return out;
}

export async function runTerraformPlanAnalyze(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  try {
    const plan = parsePlan(args.plan_json);
    const changes = Array.isArray(plan.resource_changes)
      ? plan.resource_changes.slice(0, LIMITS.maxTerraformResources)
      : [];
    const resourceTypes = [...new Set(changes.map((c) => String(asRecord(c).type ?? "")).filter(Boolean))].slice(0, 8);
    const fetched: Record<string, Record<string, unknown>> = {};
    for (const type of resourceTypes) {
      const payload = await runKnowledgeSearch(
        {
          query: `Terraform provider schema risk ${type}`,
          language: "terraform",
          artifact_kind: "provider_schema",
          symbol_fqn: type,
          pack_id: typeof args.pack_id === "string" ? args.pack_id : undefined,
          top_k: clampInt(args.top_k, 1, LIMITS.maxTopK) ?? 3,
        },
        auth,
        deps,
        undefined,
      );
      Object.assign(fetched, extractFirstMetadata(payload));
    }
    return analyzeTerraformPlanLocal(args, fetched);
  } catch (e) {
    return {
      ok: false,
      error: "terraform_plan_analyze_failed",
      message: e instanceof Error && e.message === "terraform_plan_too_large"
        ? `plan_json must be ${LIMITS.maxTerraformPlanChars} characters or fewer`
        : "Terraform plan analysis failed",
    };
  }
}
