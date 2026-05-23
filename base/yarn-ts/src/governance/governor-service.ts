import type { PipelineContext, GovernorDecision } from "../pipeline/types.js";
import {
  evaluateExecutionGovernor,
  type ExecutionGovernorDecision,
  type ExecutionGovernorOptions,
  type GovernorInputMessage,
} from "./execution-governor.js";

export interface GovernorServiceOptions {
  enabled: boolean;
  governanceDisabled?: boolean;
  defaultProfile?: ExecutionGovernorOptions["profile"];
  evaluate?: typeof evaluateExecutionGovernor;
}

export interface GovernorBeforeProviderRequest {
  messages: GovernorInputMessage[];
  options?: Omit<ExecutionGovernorOptions, "profile"> & {
    profile?: ExecutionGovernorOptions["profile"];
  };
}

export interface GovernorToolEvent {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  blocked?: boolean;
  reason?: string;
}

export interface GovernorProviderResult {
  finishReason?: string;
  text?: string;
  toolCalls?: unknown[];
  usage?: unknown;
}

export class GovernorService {
  private readonly evaluate: typeof evaluateExecutionGovernor;

  constructor(private readonly options: GovernorServiceOptions) {
    this.evaluate = options.evaluate ?? evaluateExecutionGovernor;
  }

  async beforeProviderCall(
    ctx: PipelineContext,
    request: GovernorBeforeProviderRequest,
  ): Promise<GovernorDecision> {
    if (!this.options.enabled || this.options.governanceDisabled) {
      return disabledDecision();
    }
    const execution = this.evaluate(request.messages, {
      ...request.options,
      profile: request.options?.profile ?? this.options.defaultProfile ?? "balanced_completion",
    });
    return executionDecisionToGovernorDecision(execution, ctx);
  }

  async afterToolEvent(_ctx: PipelineContext, _event: GovernorToolEvent): Promise<void> {
    // Stable hook for future event-ledger/FSM integration. Existing governor
    // behavior is transcript-derived, so there is no side effect to preserve here.
  }

  async afterProviderResult(_ctx: PipelineContext, _result: GovernorProviderResult): Promise<void> {
    // Stable hook for future post-result policy/FSM integration.
  }
}

export function executionDecisionToGovernorDecision(
  execution: ExecutionGovernorDecision,
  _ctx?: PipelineContext,
): GovernorDecision {
  return {
    action: execution.pause ? "pause" : "pass",
    reason: execution.reason || (execution.pause ? "governor_pause" : "allow"),
    matchedRules: execution.matchedRules,
    mutations: [],
    execution,
    telemetry: execution.telemetry as unknown as Record<string, unknown>,
  };
}

export function disabledExecutionGovernorDecision(): ExecutionGovernorDecision {
  return {
    pause: false,
    reason: "disabled",
    matchedRules: ["disabled"],
    telemetry: {
      phase: "edit",
      repeatedTestCommands: 0,
      repeatedReadSearchCalls: 0,
      repeatedBroadDiscoveryCalls: 0,
      totalBroadDiscoveryCalls: 0,
      broadTestRepeat: false,
      noEditEvidence: false,
      trailingVerificationRunLength: 0,
    },
  };
}

function disabledDecision(): GovernorDecision {
  const execution = disabledExecutionGovernorDecision();
  return {
    action: "pass",
    reason: execution.reason,
    matchedRules: execution.matchedRules,
    mutations: [],
    execution,
    telemetry: execution.telemetry as unknown as Record<string, unknown>,
  };
}
