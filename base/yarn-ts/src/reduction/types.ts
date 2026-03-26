export type ReducerFamily = "pytest" | "tsc" | "lint" | "git" | "search" | "generic";
export type ReducerLifecycle = "enabled" | "degraded" | "disabled" | "shadow";

export interface ReductionContext {
  toolName?: string;
  command?: string;
  profile: "balanced" | "aggressive" | "ultra";
  maxChars: number;
  minConfidence: number;
}

export interface ReducerInput {
  raw: string;
  context: ReductionContext;
}

export interface ReducerOutput {
  family: ReducerFamily;
  confidence: number;
  summary: string;
  actionableCount: number;
}

export interface Reducer {
  readonly family: ReducerFamily;
  reduce(input: ReducerInput): ReducerOutput | null;
}

export interface ReducerLifecycleState {
  lifecycle: ReducerLifecycle;
  successes: number;
  failures: number;
  lastError?: string;
}
