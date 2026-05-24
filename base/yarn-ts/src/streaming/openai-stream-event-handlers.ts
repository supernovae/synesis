import type { ModelAdapter } from "../providers/model-adapter.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import type { AdapterToolHardeningResult } from "../governance/tool-call-governor-service.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { OpenAIStreamEventHandlers } from "./openai-stream-event-runner.js";
import type { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";
import {
  applyOpenAIStreamToolCallResult,
  handleOpenAIStreamToolCall,
  type OpenAIStreamDiscoveryGuardrailResult,
  type OpenAIStreamToolCallAccumulator,
  type OpenAIStreamToolCallRecovery,
} from "./openai-stream-tool-call-handler.js";

export interface OpenAIStreamEventHandlerFactoryInput {
  streamState: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  effectiveTools: unknown[];
  debugProtocol: boolean;
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  recentToolNames: string[];
  governanceOptions(): Omit<GovernToolCallOptions, "toolName" | "input">;
  availability: NonNullable<Parameters<typeof handleOpenAIStreamToolCall>[0]["availability"]>;
  acceptedGuardrailCalls: GuardrailToolCall[];
  blockedDiscoveryDetails: BlockedDiscoveryDetail[];
  stats: ToolArgHardeningStats;
  logger: Parameters<typeof handleOpenAIStreamToolCall>[0]["logger"];
  accumulator: OpenAIStreamToolCallAccumulator;
  scrubAndFlushText(text: string): void;
  isWriteCapableToolName(name: string): boolean;
  onWriteCapableTool(): void;
  onGitInspectionChurnBlock(): void;
  onGovernedToolCall(governed: GovernedToolCall): void;
  onPlanWriteAudit(audit: PlanWriteAuditRecord): void;
  onEnvelopeUnwrapSample(toolName: string, governed: GovernedToolCall, toolCallId: string): void;
  onUpperHarnessDecision(decision: AdapterToolHardeningResult["upperHarnessDecision"]): void;
  onStrictGovernanceRewrites(count: number): void;
  onRedirectedDiscovery(count: number): void;
  getTopLevelDirs(): Promise<string[]>;
  applyDiscoveryGuardrail(calls: GuardrailToolCall[], topLevelDirs: string[]): OpenAIStreamDiscoveryGuardrailResult;
  buildBlockedDiscoveryRecovery(blockedDetails: BlockedDiscoveryDetail[]): Promise<OpenAIStreamToolCallRecovery>;
}

export function createOpenAIStreamEventHandlers(
  input: OpenAIStreamEventHandlerFactoryInput,
): OpenAIStreamEventHandlers {
  const flushPendingText = (): void => {
    if (input.streamState.hasPendingText()) {
      input.scrubAndFlushText(input.streamState.drainText());
    }
  };

  return {
    onTextDelta: (event) => {
      input.streamState.appendTextDelta(event.text);
    },
    onReasoningDelta: (event) => {
      if (event.text) {
        input.writer.writeReasoningDelta(event.text);
      }
    },
    onReasoningEnd: () => {
      /* boundary only; OpenAI format has no per-block stop for reasoning */
    },
    onToolInputStart: (event) => {
      flushPendingText();
      input.streamState.startToolInput(event.toolCallId, event.toolName);
    },
    onToolCall: async (event) => {
      flushPendingText();
      const handled = await handleOpenAIStreamToolCall({
        event,
        streamState: input.streamState,
        writer: input.writer,
        adapter: input.adapter,
        requestId: input.requestId,
        clientKind: input.clientKind,
        effectiveTools: input.effectiveTools,
        debugProtocol: input.debugProtocol,
        strictGovernance: input.strictGovernance,
        hardeningOptions: {
          upperHarness: input.upperHarness,
          clientKind: input.clientKind,
          recentToolNames: input.recentToolNames,
        },
        governanceOptions: input.governanceOptions(),
        availability: input.availability,
        stats: input.stats,
        logger: input.logger,
        isWriteCapableToolName: input.isWriteCapableToolName,
        onWriteCapableTool: input.onWriteCapableTool,
        onGitInspectionChurnBlock: input.onGitInspectionChurnBlock,
        onGovernedToolCall: input.onGovernedToolCall,
        onPlanWriteAudit: input.onPlanWriteAudit,
        onEnvelopeUnwrapSample: input.onEnvelopeUnwrapSample,
        onUpperHarnessDecision: input.onUpperHarnessDecision,
        onRedirectedDiscovery: input.onRedirectedDiscovery,
        getTopLevelDirs: input.getTopLevelDirs,
        applyDiscoveryGuardrail: input.applyDiscoveryGuardrail,
        buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecovery,
        acceptedGuardrailCalls: input.acceptedGuardrailCalls,
        blockedDiscoveryDetails: input.blockedDiscoveryDetails,
      });
      applyOpenAIStreamToolCallResult(input.accumulator, handled);
      input.onStrictGovernanceRewrites(handled.strictGovernanceRewrites);
    },
    onToolInputDelta: (event) => {
      input.streamState.appendToolInputDelta(event.toolCallId, event.inputTextDelta);
    },
    onFinish: (event) => {
      if (event.finishReason === "length") input.streamState.markLengthFinish();
    },
  };
}
