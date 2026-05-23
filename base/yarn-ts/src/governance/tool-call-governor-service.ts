import type { ModelAdapter } from "../providers/model-adapter.js";
import {
  remapCommonToolArgAliases,
  repairBashToolCall,
  repairWriteContentArray,
  repairWriteToolCall,
} from "../providers/model-adapter.js";
import {
  applyUpperHarnessToolCall,
  upperHarnessBlockPayload,
  type UpperHarnessDecision,
  type YarnUpperHarnessContext,
} from "../upper-harness/bridge.js";
import {
  buildUserSafeErrorBashCommand,
  governToolCall,
  type GovernToolCallOptions,
  type GovernedToolCall,
} from "../path-governance/tool-call-governance.js";
import {
  rewriteUnavailableToolCall,
  type GuardrailToolCall,
} from "../tools/tool-call-availability.js";

export interface AdapterToolHardeningResult {
  toolName: string;
  input: Record<string, unknown>;
  remapped: boolean;
  repairedWriteContent: boolean;
  repairedWrite: boolean;
  repairedBash: boolean;
  upperHarnessDecision?: UpperHarnessDecision;
  upperHarnessRepaired: boolean;
  upperHarnessBlocked: boolean;
}

export interface AdapterToolHardeningOptions {
  upperHarness?: YarnUpperHarnessContext;
  clientKind?: string;
  recentToolNames?: string[];
}

export interface PrepareGovernedToolCallInput {
  adapter: ModelAdapter;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  streamToolName?: string;
  hardeningOptions?: AdapterToolHardeningOptions;
  governanceOptions: Omit<GovernToolCallOptions, "toolName" | "input">;
  availability?: {
    offeredToolSet: Set<string>;
    offeredToolNames: string[];
    fallbackBashToolName: string | null;
  };
}

export interface PrepareGovernedToolCallResult {
  hardening: AdapterToolHardeningResult;
  governed: GovernedToolCall;
  call: GuardrailToolCall;
  unavailableRewrite: {
    rewritten: boolean;
    requestedTool?: string;
  };
}

/**
 * Same tool pipeline for OpenAI and Claude:
 * upper-harness policy → adapter arg remap/repair → path/tool governance → availability rewrite.
 */
export function prepareGovernedToolCall(input: PrepareGovernedToolCallInput): PrepareGovernedToolCallResult {
  const hardening = applyAdapterToolHardening(
    input.adapter,
    input.toolName,
    input.input,
    input.streamToolName,
    input.hardeningOptions,
  );
  const governed = governToolCall({
    ...input.governanceOptions,
    toolName: hardening.toolName,
    input: hardening.input,
  });
  const candidate: GuardrailToolCall = {
    toolCallId: input.toolCallId,
    toolName: governed.toolName,
    input: governed.input,
  };
  const unavailable = input.availability
    ? rewriteUnavailableToolCall(
        candidate,
        input.availability.offeredToolSet,
        input.availability.offeredToolNames,
        input.availability.fallbackBashToolName,
      )
    : { call: candidate, rewritten: false };
  return {
    hardening,
    governed,
    call: unavailable.call,
    unavailableRewrite: {
      rewritten: unavailable.rewritten,
      requestedTool: unavailable.requestedTool,
    },
  };
}

export function applyAdapterToolHardening(
  adapter: ModelAdapter,
  toolNameFromCall: string,
  input: Record<string, unknown>,
  streamToolName?: string,
  options?: AdapterToolHardeningOptions,
): AdapterToolHardeningResult {
  let finalInput = { ...input };
  let remapped = false;
  let upperHarnessDecision: UpperHarnessDecision | undefined;
  let upperHarnessRepaired = false;
  let upperHarnessBlocked = false;
  let toolNameForCall = toolNameFromCall;

  if (options?.upperHarness) {
    const upper = applyUpperHarnessToolCall({
      context: options.upperHarness,
      toolName: toolNameForCall,
      input: finalInput,
      recentToolNames: options.recentToolNames,
    });
    upperHarnessDecision = upper.decision;
    upperHarnessRepaired = upper.repaired;
    upperHarnessBlocked = upper.blocked;
    toolNameForCall = upper.toolName;
    finalInput = upper.input;
    remapped = upper.repaired;

    if (upper.blocked) {
      const payload = upperHarnessBlockPayload(upper.decision, toolNameFromCall);
      const clientKind = options.clientKind ?? "";
      if (clientKind === "claude-code" || options.upperHarness.surface === "claude") {
        return {
          toolName: "Synesis_Error_UpperHarnessBlocked",
          input: payload,
          remapped,
          repairedWriteContent: false,
          repairedWrite: false,
          repairedBash: false,
          upperHarnessDecision,
          upperHarnessRepaired,
          upperHarnessBlocked,
        };
      }
      return {
        toolName: "Bash",
        input: {
          command: buildUserSafeErrorBashCommand(String(payload.message ?? "Tool call blocked by Synesis upper harness.")),
          description: "Blocked by Synesis upper harness",
        },
        remapped,
        repairedWriteContent: false,
        repairedWrite: false,
        repairedBash: false,
        upperHarnessDecision,
        upperHarnessRepaired,
        upperHarnessBlocked,
      };
    }
  }

  const commonAliases = remapCommonToolArgAliases(toolNameForCall, finalInput);
  if (commonAliases.remapped) {
    finalInput = commonAliases.input;
    remapped = true;
  }

  if (adapter.remapToolArgs) {
    const r = adapter.remapToolArgs(toolNameForCall, finalInput);
    finalInput = r.input;
    remapped = remapped || r.remapped;
  }
  let emitToolName = (streamToolName ?? toolNameForCall).trim() || toolNameForCall;

  let repairedWriteContent = false;
  const writeContentRepair = repairWriteContentArray(emitToolName, finalInput);
  if (writeContentRepair) {
    finalInput = writeContentRepair.input;
    repairedWriteContent = writeContentRepair.repaired;
  }

  let repairedWrite = false;
  const writeRepair = repairWriteToolCall(emitToolName, finalInput);
  if (writeRepair) {
    emitToolName = writeRepair.rewrittenToolName;
    finalInput = writeRepair.rewrittenInput;
    repairedWrite = true;
  }

  let repairedBash = false;
  const bashRepair = repairBashToolCall(emitToolName, finalInput);
  if (bashRepair) {
    finalInput = bashRepair.input;
    repairedBash = bashRepair.repaired;
  }

  return {
    toolName: emitToolName,
    input: finalInput,
    remapped,
    repairedWriteContent,
    repairedWrite,
    repairedBash,
    upperHarnessDecision,
    upperHarnessRepaired,
    upperHarnessBlocked,
  };
}
