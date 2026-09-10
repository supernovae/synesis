# Architecture evidence

The [decision record](../../docs/ARCHITECTURE_REVIEW.md) selects a local knowledge-first direction. The usable implementation is now the [source-pack CLI and MCP reader](../../docs/SOURCE_PACKS.md). Restoring the former deployment is not required.

## Current executable checks

```bash
npm run build
npm test
node evals/architecture/local-smoke.mjs /tmp/synesis-local-smoke.json
```

The smoke check builds selected repository sources, imports a fresh library, queries it, verifies source reads and removes its temporary files. It starts no model or database service. It is a source-navigation and resource smoke test, not a model-quality or hosted-capacity benchmark.

The production package tests also use the official MCP SDK client over a real subprocess, including different cwd, bounded arguments and shutdown. See the [local core](../../packages/synesis-mcp/).

## Historical evidence

- `inventory.json` records the broad stack at its baseline commit, including configuration counts and route-owner candidates. Dynamic registration still requires inspection before deletion.
- `postgres-smoke.json` records the small PostgreSQL prototype experiment.
- `sqlite-smoke.json` records the initial Python/SQLite feasibility experiment.
- `screening.json` contains twelve screening questions. Private-category questions are repository simulations, and coding questions do not run coding clients. They are not a held-out evaluation suite.

The exploratory HTTP front door, PostgreSQL adapter, alternate archive builder and screening runner have been retired now that the local core exists. Historical measurements remain limited observations, not claims of reproducible current performance or a supported second implementation. Their differing runtimes, tokenizers and concurrency make timing comparisons invalid. No model-quality advantage was measured.

## Analysis of supplied model trials

The remaining `@synesis/architecture-lab` package only inventories source and analyzes supplied results. It starts no server or database and makes no model calls.

```bash
npm run build --workspace=@synesis/architecture-lab
node packages/synesis-architecture-lab/dist/inventory.js /tmp/inventory.json
node packages/synesis-architecture-lab/dist/cli.js /path/to/trials.jsonl /tmp/comparison.json
```

The analysis compares additional interception complexity with knowledge-first operation; it is not a general retrieval evaluator. Emit the strict `TrialSchema` in `src/compare.ts` only for actual reviewed runs. Pair keys include task, model/revision, harness/revision, corpus/suite hashes, knowledge treatment and repetition.

Broader quality claims use the proposed 60-task coverage policy: 20 public, 20 private, 10 coding and 10 research tasks, two model families per task and two coding harnesses per coding task/model pair. This is a starting coverage policy, not a claim of statistical power or an implementation prerequisite.

Missing pairs, synthetic trials, screening data and unreviewed outcomes return `insufficient_evidence` for a quality claim. They do not block architecture decisions based on cost or maintenance. Unknown cost remains unknown. Candidate protocol/security failures or increased false interventions disqualify added complexity; a baseline conformance failure prevents endorsing either side.

The task-clustered bootstrap is descriptive. It cannot prove future non-regression, especially for saturated small samples. Complete task cost includes allocated idle/build/refresh costs as well as model usage. Actual model runs, private task evidence, human review and a completed held-out suite remain unperformed.
