import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { CompactionMode } from "../governance/context-budget-manager.js";
import type { UserRuntimePreferences } from "../runtime/user-preferences.js";
import type {
  CachePolicyControllerDecision,
  ProviderCachePolicyWindow,
} from "../telemetry/cache-policy-controller.js";
import { cachePolicyLogRecord } from "../telemetry/cache-policy-controller.js";
import type { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import type { PrefixOptimizer } from "../providers/prefix-optimizer/index.js";
import type { MarkerBackend } from "../providers/prefix-optimizer/types.js";

type RouteMessage = { role: string; content: unknown; [key: string]: unknown };

export interface OpenAIProviderFinalizationIdentity {
  userId: string;
  orgId: string;
  clientKind: string;
}

export interface OpenAIProviderFinalizationPathContext {
  projectRoot: string | null;
  shellCwd: string | null;
  platform?: string;
  osVersion?: string;
  shell?: string;
  gitSummary?: string;
  clientModelLabel?: string;
  knowledgeCutoff?: string;
}

export interface OpenAIProviderFinalizationSession {
  history: Array<{ role: string; content: string }>;
  toolCallsSinceCheckpoint: number;
}

export interface OpenAIProviderFinalizationLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAIProviderFinalizationInput<TSession extends OpenAIProviderFinalizationSession, TResolveResult> {
  request: OpenAIChatCompletionRequest;
  selectedModel: string;
  enrichedMessages: RouteMessage[];
  toolResultCount: number;
  session: TSession;
  sessionKey: string;
  requestId: string;
  identity: OpenAIProviderFinalizationIdentity;
  pathContext: OpenAIProviderFinalizationPathContext;
  governanceDisabled: boolean;
  volatileSystemBlocks: string[];
  policyPivotPrompt?: string | null;
  latestUserContent?: unknown;
  runtimePreferences?: UserRuntimePreferences | null;
  configuredCompactionMode: CompactionMode;
  defaultTier: string;
  cachePolicyFallbackProvider?: string;
  prefixHash?: string;
  prefixChangeReasons?: string[];
  prefixOptimizer: PrefixOptimizer | null | undefined;
  prefixOptimizerErrorEvent?: string;
  optimizationLedger?: OptimizationLedger;
  logger: OpenAIProviderFinalizationLogger;
  injectSessionContext(messages: RouteMessage[], session: TSession): RouteMessage[];
  injectArtifactTool?(tools: unknown[]): unknown[];
  injectKnowledgeTool?(tools: unknown[]): unknown[];
  injectWebSearchTool?(tools: unknown[]): unknown[];
  getTierConfig(modelId: string): { baseUrl: string } | undefined;
  resolveEndpointCapabilityId(baseUrl: string): string;
  loadProviderCachePolicyWindow(
    orgId: string,
    provider: string,
    clientKind: string,
  ): Promise<ProviderCachePolicyWindow | null>;
  evaluateCachePolicy(
    session: TSession,
    provider: string,
    configuredCompactionMode: CompactionMode,
    providerWindow?: ProviderCachePolicyWindow | null,
    runtimePreferences?: UserRuntimePreferences | null,
  ): CachePolicyControllerDecision;
  markerBackendForRequest(
    modelId: string,
    fallbackModelId: string,
    sessionKey: string,
    cachePolicy?: CachePolicyControllerDecision,
  ): MarkerBackend;
  setCurrentRequestContext(context: {
    sessionKey: string;
    requestId: string;
    clientKind: string;
  }): void;
  setWorkspaceContext(
    session: TSession,
    status: "ready",
    requestId: string,
    details: { reason: string; cwd?: string; projectRoot?: string; shell?: string; os?: string; arch?: string },
  ): void;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
  runOpenAIRequest(request: OpenAIChatCompletionRequest): TResolveResult;
}

export interface OpenAIProviderFinalizationResult<TResolveResult> {
  normalizedRequest: OpenAIChatCompletionRequest;
  pathContext: OpenAIProviderFinalizationPathContext;
  cachePolicy: CachePolicyControllerDecision;
  cachePolicyProvider: string;
  resolveResult: TResolveResult;
}

export async function finalizeOpenAIProviderRequest<TSession extends OpenAIProviderFinalizationSession, TResolveResult>(
  input: OpenAIProviderFinalizationInput<TSession, TResolveResult>,
): Promise<OpenAIProviderFinalizationResult<TResolveResult>> {
  const normalizedRequest: OpenAIChatCompletionRequest = {
    ...input.request,
    model: input.selectedModel,
    messages: input.enrichedMessages as never,
  };

  input.session.toolCallsSinceCheckpoint += input.toolResultCount;
  if (input.policyPivotPrompt) {
    input.session.history.push({ role: "system", content: input.policyPivotPrompt });
  }
  if (input.latestUserContent) {
    input.session.history.push({ role: "user", content: String(input.latestUserContent) });
  }

  normalizedRequest.messages = input.injectSessionContext(
    normalizedRequest.messages as RouteMessage[],
    input.session,
  ) as never;

  if (!normalizedRequest.stream) {
    if (input.injectArtifactTool) {
      normalizedRequest.tools = input.injectArtifactTool(normalizedRequest.tools as unknown[]) as never;
    }
    if (input.injectKnowledgeTool) {
      normalizedRequest.tools = input.injectKnowledgeTool(normalizedRequest.tools as unknown[]) as never;
    }
    if (input.injectWebSearchTool) {
      normalizedRequest.tools = input.injectWebSearchTool(normalizedRequest.tools as unknown[]) as never;
    }
  }

  if (!input.governanceDisabled && input.volatileSystemBlocks.length > 0) {
    const combined = input.volatileSystemBlocks.filter(Boolean).join("\n\n");
    if (combined) {
      const messages = normalizedRequest.messages as RouteMessage[];
      messages.push({ role: "system", content: combined });
      normalizedRequest.messages = messages as never;
    }
  }

  const cachePolicyTier =
    input.getTierConfig(normalizedRequest.model)
    ?? input.getTierConfig(input.defaultTier);
  const cachePolicyProvider = cachePolicyTier
    ? input.resolveEndpointCapabilityId(cachePolicyTier.baseUrl)
    : input.cachePolicyFallbackProvider ?? "generic";
  const providerWindow = await input.loadProviderCachePolicyWindow(
    input.identity.orgId,
    cachePolicyProvider,
    input.identity.clientKind,
  );
  const cachePolicy = input.evaluateCachePolicy(
    input.session,
    cachePolicyProvider,
    input.configuredCompactionMode,
    providerWindow,
    input.runtimePreferences,
  );
  if (cachePolicy.action !== "observe" || cachePolicy.reasons.length > 0) {
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "cache_policy_controller_decision_v1",
      "cache-policy-controller",
      `action=${cachePolicy.action} compaction=${cachePolicy.compactionMode} provider=${cachePolicyProvider}`,
      input.requestId,
      cachePolicyLogRecord(cachePolicy),
    );
  }
  input.optimizationLedger?.recordCacheDiagnostics({
    policyAction: cachePolicy.action,
    policyProvider: cachePolicyProvider,
    policyCompactionMode: cachePolicy.compactionMode,
    policyReasons: cachePolicy.reasons,
  });

  input.setCurrentRequestContext({
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    clientKind: input.identity.clientKind,
  });

  let pathContext = input.pathContext;
  if (input.prefixOptimizer) {
    try {
      const optimized = input.prefixOptimizer.optimize(
        normalizedRequest.messages as never,
        normalizedRequest.tools as never,
        input.sessionKey,
        {
          markerBackend: input.markerBackendForRequest(
            normalizedRequest.model,
            input.defaultTier,
            input.sessionKey,
            cachePolicy,
          ),
        },
      );
      input.optimizationLedger?.setPrefixStableBytes(optimized.diagnostics.prefixStableBytes ?? 0);
      normalizedRequest.messages = optimized.messages as never;
      if (optimized.tools) {
        normalizedRequest.tools = optimized.tools as never;
      }

      const clientMetadata = optimized.clientMetadata;
      if (clientMetadata && (!pathContext.projectRoot || !pathContext.shellCwd)) {
        pathContext = {
          ...pathContext,
          projectRoot: pathContext.projectRoot ?? clientMetadata.projectRoot,
          shellCwd: pathContext.shellCwd ?? clientMetadata.shellCwd,
          shell: pathContext.shell ?? clientMetadata.shell ?? undefined,
          platform: pathContext.platform ?? clientMetadata.platform ?? undefined,
          osVersion: pathContext.osVersion ?? clientMetadata.osVersion ?? undefined,
        };
        if (clientMetadata.projectRoot || clientMetadata.shellCwd) {
          input.setWorkspaceContext(input.session, "ready", input.requestId, {
            reason: "Extracted from client system message",
            projectRoot: clientMetadata.projectRoot ?? undefined,
            cwd: clientMetadata.shellCwd ?? undefined,
            shell: clientMetadata.shell ?? undefined,
            os: clientMetadata.platform ?? undefined,
            arch: clientMetadata.osVersion ?? undefined,
          });
          input.logger.info(
            {
              sessionKey: input.sessionKey,
              projectRoot: clientMetadata.projectRoot,
              shellCwd: clientMetadata.shellCwd,
              shell: clientMetadata.shell,
              platform: clientMetadata.platform,
            },
            "prefix_optimizer_metadata_backfill",
          );
        }
      }
    } catch (err) {
      input.logger.warn({ err, sessionKey: input.sessionKey }, input.prefixOptimizerErrorEvent ?? "prefix_optimizer_oai_error");
    }
  }
  input.optimizationLedger?.recordCacheDiagnostics({
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
  });

  return {
    normalizedRequest,
    pathContext,
    cachePolicy,
    cachePolicyProvider,
    resolveResult: input.runOpenAIRequest(normalizedRequest),
  };
}
