import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { ClaudeStreamRouteRunInputBuilderInput } from "./claude-stream-route-input.js";
import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";

interface RequirementChecklistShape {
  must: unknown[];
  should: unknown[];
}

type ClaudeStreamRouteCompletionSection<
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
> = ClaudeStreamRouteRunInputBuilderInput<
  ClaudeStreamProviderMessage,
  ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph
>["completion"];

type ClaudeStreamRouteCompletionFinalizer<
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
> = ClaudeStreamRouteCompletionSection<TChecklist, TVerification, TPlanGraph>["finalizer"];

type ClaudeStreamRouteCompletionTelemetry<
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
> = ClaudeStreamRouteCompletionSection<TChecklist, TVerification, TPlanGraph>["telemetry"];

export interface ClaudeStreamRouteCompletionBuilderInput<
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
> {
  scope: {
    pendingRequestId: string;
    historyRequestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
  };
  metadata: {
    source: unknown;
    getString(source: unknown, key: string): string;
  };
  recentMessages: Array<{ role: string; content: unknown }>;
  extractRecentToolNames(messages: Array<{ role: string; content: unknown }>): string[];
  checklist: TChecklist | null | undefined;
  finalizer: Omit<
    ClaudeStreamRouteCompletionFinalizer<TChecklist, TVerification, TPlanGraph>,
    "handlerInput"
  > & {
    handlerInput: Omit<
      ClaudeStreamRouteCompletionFinalizer<
        TChecklist,
        TVerification,
        TPlanGraph
      >["handlerInput"],
      | "pendingRequestId"
      | "historyRequestId"
      | "sessionKey"
      | "userId"
      | "orgId"
      | "checklist"
      | "traceRootPrompt"
      | "latestUserPrompt"
      | "recentToolNames"
    >;
  };
  telemetry: Omit<
    ClaudeStreamRouteCompletionTelemetry<TChecklist, TVerification, TPlanGraph>,
    "requirementChecklistMust" | "requirementChecklistShould"
  >;
}

export function buildClaudeStreamRouteCompletionInput<
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteCompletionBuilderInput<TChecklist, TVerification, TPlanGraph>,
): ClaudeStreamRouteCompletionSection<TChecklist, TVerification, TPlanGraph> {
  return {
    finalizer: {
      ...input.finalizer,
      handlerInput: {
        ...input.finalizer.handlerInput,
        pendingRequestId: input.scope.pendingRequestId,
        historyRequestId: input.scope.historyRequestId,
        sessionKey: input.scope.sessionKey,
        userId: input.scope.userId,
        orgId: input.scope.orgId,
        checklist: input.checklist ?? null,
        traceRootPrompt: input.metadata.getString(input.metadata.source, "trace_root_prompt"),
        latestUserPrompt: input.metadata.getString(input.metadata.source, "latest_user_prompt"),
        recentToolNames: input.extractRecentToolNames(input.recentMessages),
      },
    },
    telemetry: {
      ...input.telemetry,
      requirementChecklistMust: input.checklist?.must.length || undefined,
      requirementChecklistShould: input.checklist?.should.length || undefined,
    },
  };
}
