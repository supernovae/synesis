import {
  architecturePolicyTrace,
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
} from "../providers/model-architecture-profile.js";
import { resolveAdapter } from "../providers/model-adapter.js";
import { resolveEndpointCapabilityId } from "../providers/endpoint-capabilities/resolve.js";
import { summarizeCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";
import type { PlatformRouteDependencies } from "./platform-route-support.js";

export interface ModelArchitectureDiagnosticsEnvelope {
  schema_version: "model_architecture_diagnostics_v1";
  count: number;
  models: ModelArchitectureDiagnostic[];
}

export interface ModelArchitectureDiagnostic {
  model_id: string;
  resolved: boolean;
  tier_id?: string;
  backend_model: string;
  provider?: string;
  adapter_family: string;
  declared_context_tokens?: number;
  override_applied: boolean;
  architecture: Record<string, unknown>;
  profile_notes?: string[];
}

export function buildModelArchitectureDiagnostics(
  deps: Pick<PlatformRouteDependencies, "tierRegistry" | "config">,
): ModelArchitectureDiagnosticsEnvelope {
  const models = deps.tierRegistry.getAvailableModels().map((entry): ModelArchitectureDiagnostic => {
    const modelId = entry.id;
    const tier = deps.tierRegistry.getTierConfig?.(modelId);
    const backendModel = tier?.backendModel ?? modelId;
    const provider = tier?.baseUrl ? resolveEndpointCapabilityId(tier.baseUrl) : undefined;
    const adapter = resolveAdapter(backendModel, tier?.baseUrl ?? "", tier?.adapterHint);
    const profile = resolveModelArchitectureProfile({
      modelId: backendModel,
      provider,
      family: adapter.family,
      declaredContextTokens: tier?.contextCeilingTokens,
      override: tier?.architectureProfile ?? null,
    });
    const policy = applyArchitectureMediationMode(
      deriveModelExecutionPolicy(profile),
      resolveArchitectureMediationMode({
        configMode: deps.config.SYNESIS_YARN_ARCHITECTURE_MEDIATION_MODE,
      }),
    );
    return {
      model_id: modelId,
      resolved: Boolean(tier),
      backend_model: backendModel,
      adapter_family: adapter.family,
      override_applied: Boolean(tier?.architectureProfile),
      architecture: architecturePolicyTrace(profile, policy),
      ...(tier ? { tier_id: tier.id } : {}),
      ...(provider ? { provider } : {}),
      ...(tier?.contextCeilingTokens ? { declared_context_tokens: tier.contextCeilingTokens } : {}),
      ...(profile.notes ? { profile_notes: profile.notes } : {}),
    };
  });

  return {
    schema_version: "model_architecture_diagnostics_v1",
    count: models.length,
    models,
  };
}

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

  app.get("/v1/diagnostics/model-architecture", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    return buildModelArchitectureDiagnostics(deps);
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
