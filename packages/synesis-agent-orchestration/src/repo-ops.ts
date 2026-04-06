import { REPO_OPERATION_IDS } from "./constants.js";
import type { RepoOperationRequest, RepoOperationResult, RepoOpsAdapter } from "./types.js";

export interface RepoOpDefinition {
  operationId: string;
  existingToolNames: string[];
  description: string;
}

export const REPO_OP_DEFINITIONS: RepoOpDefinition[] = [
  {
    operationId: REPO_OPERATION_IDS.search,
    existingToolNames: ["search_code"],
    description: "Search repository text with bounded scope.",
  },
  {
    operationId: REPO_OPERATION_IDS.readRange,
    existingToolNames: ["read_file"],
    description: "Read bounded file ranges.",
  },
  {
    operationId: REPO_OPERATION_IDS.findSymbol,
    existingToolNames: ["search_code"],
    description: "Locate symbols with line-level matches.",
  },
  {
    operationId: REPO_OPERATION_IDS.applyPatch,
    existingToolNames: ["str_replace", "write_file"],
    description: "Apply bounded edits using patch/line/symbol strategy.",
  },
  {
    operationId: REPO_OPERATION_IDS.runTests,
    existingToolNames: ["run_test"],
    description: "Run bounded test presets.",
  },
  {
    operationId: REPO_OPERATION_IDS.runLint,
    existingToolNames: ["run_lint"],
    description: "Run bounded lint presets.",
  },
  {
    operationId: REPO_OPERATION_IDS.gitDiff,
    existingToolNames: ["git_diff"],
    description: "Read git diff.",
  },
  {
    operationId: REPO_OPERATION_IDS.listChangedFiles,
    existingToolNames: ["git_status"],
    description: "List changed files from git status.",
  },
  {
    operationId: REPO_OPERATION_IDS.writeDecisionRecord,
    existingToolNames: ["write_file"],
    description: "Persist decision records in docs/artifacts.",
  },
];

export const DEFAULT_AGENT_ALLOWED_REPO_OPS = [
  REPO_OPERATION_IDS.search,
  REPO_OPERATION_IDS.readRange,
  REPO_OPERATION_IDS.findSymbol,
  REPO_OPERATION_IDS.applyPatch,
  REPO_OPERATION_IDS.runTests,
  REPO_OPERATION_IDS.runLint,
  REPO_OPERATION_IDS.gitDiff,
  REPO_OPERATION_IDS.listChangedFiles,
  REPO_OPERATION_IDS.writeDecisionRecord,
] as const;

export class GuardedRepoOpsAdapter implements RepoOpsAdapter {
  constructor(
    private readonly delegate: (request: RepoOperationRequest) => Promise<RepoOperationResult>,
    private readonly allowedOps: ReadonlySet<string>,
  ) {}

  async call(request: RepoOperationRequest): Promise<RepoOperationResult> {
    if (!this.allowedOps.has(request.op)) {
      return { ok: false, error: `repo_op_forbidden:${request.op}` };
    }
    return this.delegate(request);
  }
}
