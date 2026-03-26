import { classifyReducerFamily } from "./classifier.js";
import { AnsibleReducer } from "./reducers/ansible.js";
import { CargoReducer } from "./reducers/cargo.js";
import { CurlHttpReducer } from "./reducers/curl-http.js";
import { DockerBuildReducer } from "./reducers/docker-build.js";
import { GitReducer } from "./reducers/git.js";
import { GoBuildReducer } from "./reducers/go-build.js";
import { HelmReducer } from "./reducers/helm.js";
import { JavaBuildReducer } from "./reducers/java-build.js";
import { JestReducer } from "./reducers/jest.js";
import { KubectlReducer } from "./reducers/kubectl.js";
import { LintReducer } from "./reducers/lint.js";
import { LogStreamReducer } from "./reducers/log-stream.js";
import { LsTreeReducer } from "./reducers/ls-tree.js";
import { MakeReducer } from "./reducers/make.js";
import { MypyReducer } from "./reducers/mypy.js";
import { NetworkDiagReducer } from "./reducers/network-diag.js";
import { NpmInstallReducer } from "./reducers/npm-install.js";
import { PipInstallReducer } from "./reducers/pip-install.js";
import { PytestReducer } from "./reducers/pytest.js";
import { SearchReducer } from "./reducers/search.js";
import { SqlResultReducer } from "./reducers/sql-result.js";
import { StackTraceReducer } from "./reducers/stack-trace.js";
import { StracePerfReducer } from "./reducers/strace-perf.js";
import { TerraformReducer } from "./reducers/terraform.js";
import { TscReducer } from "./reducers/tsc.js";
import type { Reducer, ReducerFamily, ReducerInput, ReducerLifecycleState, ReducerOutput } from "./types.js";

const REDUCERS: Record<Exclude<ReducerFamily, "generic">, Reducer> = {
  pytest: new PytestReducer(),
  tsc: new TscReducer(),
  lint: new LintReducer(),
  git: new GitReducer(),
  search: new SearchReducer(),
  "npm-install": new NpmInstallReducer(),
  "docker-build": new DockerBuildReducer(),
  cargo: new CargoReducer(),
  make: new MakeReducer(),
  "stack-trace": new StackTraceReducer(),
  jest: new JestReducer(),
  "go-build": new GoBuildReducer(),
  "pip-install": new PipInstallReducer(),
  "ls-tree": new LsTreeReducer(),
  "curl-http": new CurlHttpReducer(),
  kubectl: new KubectlReducer(),
  terraform: new TerraformReducer(),
  "sql-result": new SqlResultReducer(),
  mypy: new MypyReducer(),
  "java-build": new JavaBuildReducer(),
  ansible: new AnsibleReducer(),
  helm: new HelmReducer(),
  "network-diag": new NetworkDiagReducer(),
  "strace-perf": new StracePerfReducer(),
  "log-stream": new LogStreamReducer()
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
