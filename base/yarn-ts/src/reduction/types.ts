export type ReducerFamily =
  | "pytest" | "tsc" | "lint" | "git" | "search"
  | "npm-install" | "docker-build" | "cargo" | "make" | "stack-trace"
  | "jest" | "go-build" | "pip-install" | "ls-tree" | "curl-http"
  | "kubectl" | "terraform" | "sql-result" | "mypy" | "java-build"
  | "ansible" | "helm" | "network-diag" | "strace-perf" | "log-stream"
  // Batch 3: container/infra + version control
  | "git-diff" | "podman" | "oc" | "docker-compose" | "coverage"
  // Batch 4: cloud CLIs + audit
  | "aws-cli" | "gcloud" | "az-cli" | "npm-audit" | "webpack"
  // Batch 5: JS build + package managers
  | "vite" | "esbuild" | "yarn-install" | "pnpm" | "apt-pkg"
  // Batch 6: test runners
  | "mocha" | "rspec" | "phpunit" | "python-unittest" | "dotnet"
  // Batch 7: linters + build tools
  | "pylint" | "shellcheck" | "clippy" | "rubocop" | "cppcheck"
  // Batch 8: remaining
  | "gradle" | "swift-build" | "cmake" | "composer" | "git-log"
  | "generic";
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

export interface EnrichedItem {
  message: string;
  file?: string;
  ruleId?: string;
  errorFamily?: string;
  rootCause?: string;
  action?: string;
}

export interface ReducerOutput {
  family: ReducerFamily;
  confidence: number;
  summary: string;
  actionableCount: number;
  enrichedItems?: EnrichedItem[];
  bypassEligible?: boolean;
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
