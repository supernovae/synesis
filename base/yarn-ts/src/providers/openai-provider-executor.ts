import {
  buildRequiredRepairPrompt,
  validateRequiredToolCalls,
  type PhaseAwareToolChoice,
  type PhaseExecutionPolicyDecision,
  type SDKToolCallLike,
} from "../governance/phase-execution-policy.js";
import type { SessionPhase } from "../governance/execution-governor.js";

export interface ProviderAttempt<TResult, TMessages, TAttemptContext = unknown> {
  result: TResult;
  context?: TAttemptContext;
  messages: TMessages;
  toolChoice: PhaseAwareToolChoice | undefined;
}

export interface ExecutePhaseRequiredProviderCallOptions<TResult, TMessages, TAttemptContext = unknown> {
  messages: TMessages;
  toolChoice: PhaseAwareToolChoice | undefined;
  phasePolicy: PhaseExecutionPolicyDecision;
  governorPhase: SessionPhase;
  runAttempt: (
    messages: TMessages,
    toolChoice: PhaseAwareToolChoice | undefined,
  ) => Promise<ProviderAttempt<TResult, TMessages, TAttemptContext>>;
  appendSystemMessage: (messages: TMessages, content: string) => TMessages;
  getToolCalls: (result: TResult) => SDKToolCallLike[];
  finalizeAttempt?: (attempt: ProviderAttempt<TResult, TMessages, TAttemptContext>) => void;
  onValidationRetry?: (reasons: string[]) => void;
  onValidationFallback?: (reasons: string[]) => void;
}

export interface ExecutePhaseRequiredProviderCallResult<TResult, TMessages> {
  result: TResult;
  messages: TMessages;
  toolChoice: PhaseAwareToolChoice | undefined;
  validationReasons: string[];
  attempt: "initial" | "repair" | "fallback";
}

export async function executePhaseRequiredProviderCall<TResult, TMessages, TAttemptContext = unknown>(
  options: ExecutePhaseRequiredProviderCallOptions<TResult, TMessages, TAttemptContext>,
): Promise<ExecutePhaseRequiredProviderCallResult<TResult, TMessages>> {
  let currentMessages = options.messages;
  let effectiveToolChoice = options.toolChoice;
  let currentAttempt = await options.runAttempt(currentMessages, effectiveToolChoice);
  let validation = validateRequiredToolCalls(
    options.getToolCalls(currentAttempt.result),
    options.phasePolicy,
  );

  if (!validation.valid && options.phasePolicy.toolChoice === "required") {
    options.onValidationRetry?.(validation.reasons);
    currentMessages = options.appendSystemMessage(
      currentMessages,
      buildRequiredRepairPrompt(options.governorPhase, options.phasePolicy.allowedCanonicalTools),
    );
    currentAttempt = await options.runAttempt(currentMessages, effectiveToolChoice);
    options.finalizeAttempt?.(currentAttempt);
    validation = validateRequiredToolCalls(
      options.getToolCalls(currentAttempt.result),
      options.phasePolicy,
    );

    if (!validation.valid) {
      options.onValidationFallback?.(validation.reasons);
      effectiveToolChoice = "auto";
      currentMessages = options.appendSystemMessage(
        currentMessages,
        "Phase execution policy fallback: required tool-call contract failed after retry. Continue with tool_choice=auto and recover safely.",
      );
      currentAttempt = await options.runAttempt(currentMessages, effectiveToolChoice);
      options.finalizeAttempt?.(currentAttempt);
      return {
        result: currentAttempt.result,
        messages: currentMessages,
        toolChoice: effectiveToolChoice,
        validationReasons: validation.reasons,
        attempt: "fallback",
      };
    }

    return {
      result: currentAttempt.result,
      messages: currentMessages,
      toolChoice: effectiveToolChoice,
      validationReasons: validation.reasons,
      attempt: "repair",
    };
  }

  options.finalizeAttempt?.(currentAttempt);
  return {
    result: currentAttempt.result,
    messages: currentMessages,
    toolChoice: effectiveToolChoice,
    validationReasons: validation.reasons,
    attempt: "initial",
  };
}
