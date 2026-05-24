import type { ModelAdapter } from "../providers/model-adapter.js";
import {
  buildPythonRuntimeDiscoveryToolPromptFragment,
  buildRetrievalPolicyToolPromptFragment,
  buildStdoutEfficiencyToolPromptFragment,
  buildVerificationDisciplineToolPromptFragment,
  mergeToolSystemPrompts,
} from "../retrieval-tool-policy.js";
import { appendSystemMessageAndNormalize } from "../transcript/system-message-ordering.js";
import { buildEmptyWorkspaceSystemPrompt } from "../governance/workspace-boundary.js";

export interface RouteModelMessage {
  role: string;
  content?: unknown;
}

export interface RouteWorkspaceInspection {
  isEmpty: boolean;
  projectInstructionFiles: unknown[];
  root: string | null;
}

export interface RouteEditMissGuard {
  active?: boolean;
  filePath?: string | null;
  missCount?: number | null;
}

export interface RouteStateReground {
  required: boolean;
  recommendedReadPath?: string | null;
  reasons: string[];
}

export interface RouteModelMessageAssemblyInput<TMessage extends RouteModelMessage> {
  adapter: ModelAdapter;
  effectiveTools: unknown[];
  messages: TMessage[];
  workspaceInspection: RouteWorkspaceInspection;
  policyPivotPrompt?: string | null;
  editMissGuard?: RouteEditMissGuard | null;
  forceReadRecovery: boolean;
  latestReadRefreshFilePath?: string | null;
  consecutiveEditContextMisses: number;
  stateReground: RouteStateReground;
  promptIntakeSystemBlock?: string | null;
  buildEditContextMissGuardPrompt(filePath: string, missCount: number): string;
  buildEditContextMissForcedReadPrompt(filePath?: string): string;
  buildStateRegroundReadPrompt(path: string, reasons: string[]): string;
}

export interface RouteModelMessageAssemblyResult<TMessage extends RouteModelMessage> {
  messages: TMessage[];
  toolPrompt?: string;
}

export function assembleRouteModelMessages<TMessage extends RouteModelMessage>(
  input: RouteModelMessageAssemblyInput<TMessage>,
): RouteModelMessageAssemblyResult<TMessage> {
  const toolPrompt = mergeToolSystemPrompts(
    input.adapter.toolSystemPrompt?.(input.effectiveTools.length),
    buildRetrievalPolicyToolPromptFragment(input.effectiveTools),
    buildStdoutEfficiencyToolPromptFragment(input.effectiveTools),
    buildVerificationDisciplineToolPromptFragment(input.effectiveTools),
    buildPythonRuntimeDiscoveryToolPromptFragment(input.effectiveTools),
  );
  let messages = toolPrompt
    ? ([{ role: "system" as const, content: toolPrompt }, ...input.messages] as TMessage[])
    : input.messages;

  if (input.workspaceInspection.isEmpty && input.workspaceInspection.projectInstructionFiles.length === 0) {
    messages = appendSystemMessageAndNormalize(
      messages,
      buildEmptyWorkspaceSystemPrompt(input.workspaceInspection.root),
    ) as TMessage[];
  }
  if (input.policyPivotPrompt) {
    messages = [...messages, { role: "system", content: input.policyPivotPrompt } as TMessage];
  }
  if (input.editMissGuard?.active || input.forceReadRecovery) {
    const recoveryFilePath = input.editMissGuard?.filePath ?? input.latestReadRefreshFilePath ?? "<unknown>";
    const recoveryMissCount = input.editMissGuard?.missCount ?? input.consecutiveEditContextMisses;
    const editRecoveryPrompt = input.forceReadRecovery
      ? input.buildEditContextMissForcedReadPrompt(recoveryFilePath)
      : input.buildEditContextMissGuardPrompt(recoveryFilePath, recoveryMissCount);
    messages = appendSystemMessageAndNormalize(messages, editRecoveryPrompt) as TMessage[];
  }
  if (input.stateReground.required && input.stateReground.recommendedReadPath) {
    const regroundPrompt = input.buildStateRegroundReadPrompt(
      input.stateReground.recommendedReadPath,
      input.stateReground.reasons,
    );
    messages = appendSystemMessageAndNormalize(messages, regroundPrompt) as TMessage[];
  }
  if (input.promptIntakeSystemBlock) {
    messages = appendSystemMessageAndNormalize(messages, input.promptIntakeSystemBlock) as TMessage[];
  }

  return { messages, toolPrompt };
}
