import type { OpenAIStreamFinalizerTextResult } from "../streaming/openai-stream-finalizer.js";

export interface OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph> {
  session: TSession;
  checklist: TChecklist | null;
  traceRootPrompt: string;
  latestUserPrompt: string;
  verification: TVerification;
  recentToolNames: string[];
  planGraph?: TPlanGraph | null;
  responseStyleMode: string;
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: TChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: TVerification;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: TPlanGraph | null;
    session?: TSession | null;
  }): Promise<OpenAIStreamFinalizerTextResult>;
}

export type OpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph> =
  OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph>;

export function createOpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph>(
  input: OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph>,
): OpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph> {
  return {
    session: input.session,
    checklist: input.checklist,
    traceRootPrompt: input.traceRootPrompt,
    latestUserPrompt: input.latestUserPrompt,
    verification: input.verification,
    recentToolNames: input.recentToolNames,
    planGraph: input.planGraph,
    responseStyleMode: input.responseStyleMode,
    applyMarkdownGuardrail: input.applyMarkdownGuardrail,
    finalizeCompletionText: input.finalizeCompletionText,
  };
}
