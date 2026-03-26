import { classifyReducerFamily } from "./classifier.js";
import { GitReducer } from "./reducers/git.js";
import { LintReducer } from "./reducers/lint.js";
import { PytestReducer } from "./reducers/pytest.js";
import { SearchReducer } from "./reducers/search.js";
import { TscReducer } from "./reducers/tsc.js";
import type { Reducer, ReducerFamily, ReducerInput, ReducerLifecycleState, ReducerOutput } from "./types.js";

const REDUCERS: Record<Exclude<ReducerFamily, "generic">, Reducer> = {
  pytest: new PytestReducer(),
  tsc: new TscReducer(),
  lint: new LintReducer(),
  git: new GitReducer(),
  search: new SearchReducer()
};

export interface RegistryOptions {
  enabled: boolean;
  enabledFamilies: Set<ReducerFamily>;
  minConfidence: number;
}

export class ReducerRegistry {
  private readonly lifecycle = new Map<ReducerFamily, ReducerLifecycleState>();

  constructor(private readonly options: RegistryOptions) {
    (Object.keys(REDUCERS) as Array<Exclude<ReducerFamily, "generic">>).forEach((family) => {
      this.lifecycle.set(family, { lifecycle: options.enabledFamilies.has(family) ? "enabled" : "disabled", successes: 0, failures: 0 });
    });
  }

  reduce(input: ReducerInput): ReducerOutput | null {
    if (!this.options.enabled) return null;
    const family = classifyReducerFamily(input.context.toolName, input.context.command, input.raw);
    if (family === "generic" || !this.options.enabledFamilies.has(family)) return null;
    const reducer = REDUCERS[family as Exclude<ReducerFamily, "generic">];
    if (!reducer) return null;
    const state = this.lifecycle.get(family);
    if (state?.lifecycle === "disabled") return null;
    try {
      const out = reducer.reduce(input);
      if (!out) return null;
      if (out.confidence < this.options.minConfidence) {
        return null;
      }
      if (state) {
        state.successes += 1;
        if (state.lifecycle === "degraded" && state.successes > state.failures * 2) {
          state.lifecycle = "enabled";
        }
      }
      return out;
    } catch (error) {
      if (state) {
        state.failures += 1;
        state.lastError = String(error);
        if (state.failures >= 3 && state.failures > state.successes) {
          state.lifecycle = "degraded";
        }
      }
      return null;
    }
  }

  lifecycleStates(): Record<string, ReducerLifecycleState> {
    return Object.fromEntries(this.lifecycle.entries());
  }
}
