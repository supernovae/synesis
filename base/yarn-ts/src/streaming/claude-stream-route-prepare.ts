import type {
  ClaudeStreamRouteGatesInput,
  ClaudeStreamRouteGatesResult,
} from "./claude-stream-route-gates.js";
import { startClaudeStreamRouteGates } from "./claude-stream-route-gates.js";
import {
  createClaudeStreamRouteRuntime,
  type ClaudeStreamRouteRuntimeInput,
  type ClaudeStreamRouteRuntimeResult,
} from "./claude-stream-route-runtime.js";
import type { RouteToolCallSideEffectsSession } from "./route-tool-call-side-effects.js";

type ClaudeStreamRouteGateRejection = Extract<ClaudeStreamRouteGatesResult, { ok: false }>;

export interface ClaudeStreamRoutePrepareInput<TSession extends RouteToolCallSideEffectsSession, TForensics> {
  gates: ClaudeStreamRouteGatesInput;
  runtime: Omit<ClaudeStreamRouteRuntimeInput<TSession, TForensics>, "started">;
}

export type ClaudeStreamRoutePrepareResult<TForensics> =
  | {
      ok: false;
      rejection: ClaudeStreamRouteGateRejection;
    }
  | {
      ok: true;
      runtime: ClaudeStreamRouteRuntimeResult<TForensics>;
    };

export async function prepareClaudeStreamRoute<TSession extends RouteToolCallSideEffectsSession, TForensics>(
  input: ClaudeStreamRoutePrepareInput<TSession, TForensics>,
): Promise<ClaudeStreamRoutePrepareResult<TForensics>> {
  const started = await startClaudeStreamRouteGates(input.gates);
  if (!started.ok) {
    return {
      ok: false,
      rejection: started,
    };
  }

  return {
    ok: true,
    runtime: createClaudeStreamRouteRuntime({
      ...input.runtime,
      started,
    }),
  };
}
