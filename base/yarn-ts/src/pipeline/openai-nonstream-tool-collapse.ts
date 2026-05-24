import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import { ToolCallInterceptor, defaultShellAllowlistFromEnv, planToSyntheticToolCalls } from "../tool-collapse/index.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";

export interface OpenAINonStreamToolCollapseLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAINonStreamToolCollapseInput {
  calls: GuardrailToolCall[];
  enabled: boolean;
  rewriteNonStream: boolean;
  collapseHeader: unknown;
  workspaceRoot: string | null;
  shellAllowlistEnv: string;
  dedupeLayer?: DedupeLayer | null;
  toolPrefixCache?: ToolPrefixCache | null;
  logger: OpenAINonStreamToolCollapseLogger;
  requestId: string;
}

export async function maybeRewriteOpenAINonStreamCollapsedToolCalls(
  input: OpenAINonStreamToolCollapseInput,
): Promise<GuardrailToolCall[]> {
  if (
    !input.enabled
    || !input.rewriteNonStream
    || String(input.collapseHeader ?? "") !== "apply"
    || input.calls.length <= 1
  ) {
    return input.calls;
  }

  const collapseInterceptor = new ToolCallInterceptor({
    workspaceRoot: input.workspaceRoot,
    shellAllowlist: defaultShellAllowlistFromEnv(input.shellAllowlistEnv),
    strictValidation: true,
    execute: false,
    executor: null,
    dedupeLayer: input.dedupeLayer,
    toolPrefixCache: input.toolPrefixCache,
    log: ({ msg, data }) => input.logger.info({ msg, ...data }, "tool_collapse_non_stream"),
  });
  const parsedCalls = input.calls.map((tc) => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: tc.input,
  }));
  const collapseResult = await collapseInterceptor.processImmediate(parsedCalls);
  if (!collapseResult.validated.ok || !collapseResult.usedCollapse) {
    return input.calls;
  }

  const synthetic = planToSyntheticToolCalls(collapseResult.plan);
  const rewritten = synthetic.map((s) => ({
    toolCallId: s.toolCallId,
    toolName: s.toolName,
    input: s.input,
  }));
  input.logger.info(
    { from: parsedCalls.length, to: rewritten.length, reqId: input.requestId },
    "tool_collapse_rewrite_non_stream",
  );
  return rewritten;
}
