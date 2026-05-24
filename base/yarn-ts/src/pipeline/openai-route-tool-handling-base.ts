import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { GovernToolCallOptions } from "../path-governance/tool-call-governance.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { OpenAINonStreamToolCallLogger, OpenAINonStreamToolCallPathContext } from "./openai-nonstream-tool-calls.js";

export interface OpenAIChatRouteToolHandlingBaseInput<TSession> {
  adapter: ModelAdapter;
  clientKind: string;
  effectiveTools: unknown[];
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  recentToolNames: string[];
  taskCue: unknown;
  planModeRequested: boolean;
  sensemakingRestrictDiscovery?: boolean;
  pathContext: OpenAINonStreamToolCallPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  normalizedMessageCount: number;
  session: TSession;
  stats: ToolArgHardeningStats;
  logger: OpenAINonStreamToolCallLogger;
  isWriteCapableToolName(name: string): boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializePlanShadow(data: unknown): PlanContentShadow | null;
  buildPathSandboxPolicy(root: string): PathSandboxPolicy;
}

export type OpenAIChatRouteToolHandlingBase<TSession> = OpenAIChatRouteToolHandlingBaseInput<TSession>;

export function createOpenAIChatRouteToolHandlingBase<TSession>(
  input: OpenAIChatRouteToolHandlingBaseInput<TSession>,
): OpenAIChatRouteToolHandlingBase<TSession> {
  return {
    adapter: input.adapter,
    clientKind: input.clientKind,
    effectiveTools: input.effectiveTools,
    strictGovernance: input.strictGovernance,
    upperHarness: input.upperHarness,
    recentToolNames: input.recentToolNames,
    taskCue: input.taskCue,
    planModeRequested: input.planModeRequested,
    sensemakingRestrictDiscovery: input.sensemakingRestrictDiscovery,
    pathContext: input.pathContext,
    enforcePathRoot: input.enforcePathRoot,
    blockBashPathDrift: input.blockBashPathDrift,
    pathSandboxEnabled: input.pathSandboxEnabled,
    artifactShadows: input.artifactShadows,
    normalizedMessageCount: input.normalizedMessageCount,
    session: input.session,
    stats: input.stats,
    logger: input.logger,
    isWriteCapableToolName: input.isWriteCapableToolName,
    shouldRestrictDiscoveryForPlanWork: input.shouldRestrictDiscoveryForPlanWork,
    deserializePlanShadow: input.deserializePlanShadow,
    buildPathSandboxPolicy: input.buildPathSandboxPolicy,
  };
}
