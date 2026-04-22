export const ORCHESTRATION_LIMITS = {
  maxParallelWorkers: 5,
  maxPlannerRounds: 2,
  maxRepairRounds: 1,
  maxArchitecturalChallengeRounds: 1,
  maxArchitecturalAdjudicationRounds: 1,
} as const;

export const DEFAULT_BUDGETS = {
  tokenBudget: 8_000,
  stepBudget: 20,
  locBudget: 250,
} as const;

export const PROJECT_INSTRUCTION_SOURCES = {
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  internal: "internal",
} as const;

export const REPO_OPERATION_IDS = {
  search: "repo.search",
  readRange: "repo.read_range",
  findSymbol: "repo.find_symbol",
  applyPatch: "repo.apply_patch",
  runTests: "repo.run_tests",
  runLint: "repo.run_lint",
  gitDiff: "repo.git_diff",
  listChangedFiles: "repo.list_changed_files",
  writeDecisionRecord: "repo.write_decision_record",
} as const;
