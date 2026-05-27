# Harness Tester

The harness tester runs real developer harnesses against Synesis Yarn's OpenAI-compatible API and records the full coding loop: harness process, API/session trace correlation, workspace diff, deterministic validation, and behavioral failure labels.

It is intentionally not a second proxy, tracer, sandbox, or eval framework. It reuses the existing Yarn eval/Harness Lab pieces and adds the missing local task-runner layer for language-level coding workflows.

## What It Tests

- Whether a harness can run non-interactively against the Synesis OpenAI-compatible API.
- Whether a model/harness pair can make a minimal source change and pass deterministic validators.
- Whether failures look like harness invocation issues, Synesis/API/tool compatibility issues, model behavior, or task validation failures.
- Whether reports contain enough evidence to turn user complaints into reproducible fixtures.

It does not claim benchmark quality or use an LLM grader in v1. A run only passes when validation evidence exists.

## First-Class Languages

The initial suite includes small fixtures for:

- Python with `pytest`
- Go with `go test ./...`
- JavaScript/TypeScript with `npm test`

Rust and other languages should be added with the same fixture pattern: a small repo, setup commands, validation commands, expected changed files, and forbidden changed files.

## OpenCode Usage

Point OpenCode at a running Yarn instance:

```bash
cd base/yarn-ts
OPENAI_API_KEY=local-token \
OPENAI_BASE_URL=http://localhost:8000/v1 \
npm run harness:tester -- run \
  --task tests/fixtures/harness-tester/tasks/simple-python-bugfix.json \
  --harness opencode \
  --model qwen3-coder \
  --api-base-url http://localhost:8000/v1
```

Run the core language suite:

```bash
cd base/yarn-ts
npm run harness:tester -- run-suite \
  --suite tests/fixtures/harness-tester/suites/language-core.json \
  --harness opencode \
  --model qwen3-coder \
  --api-base-url http://localhost:8000/v1
```

The OpenCode adapter is command-template based. If your local OpenCode CLI needs different flags, pass `--harness-command` or `--harness-args`.

## Benchmark Packs

Harness Tester supports benchmark adapters above the same task runner. The first local packs are intentionally small:

- `swe-bench`: repo issue -> patch -> deterministic tests
- `xlam`: tool-use task -> tool/schema reliability signals
- `humaneval`: function implementation -> deterministic tests

Run a benchmark task:

```bash
cd base/yarn-ts
npm run harness:tester -- run-benchmark \
  --task tests/fixtures/harness-tester/benchmarks/swe-bench-local-python.json \
  --harness opencode \
  --model qwen3-coder \
  --api-base-url http://localhost:8000/v1
```

Reports include native scores and normalized scores:

- `task_success`
- `tool_call_reliability`
- `patch_correctness`
- `instruction_following`
- `efficiency_score`

MT-Bench, AlpacaEval, and ToxiGen are represented in the adapter interface but should remain optional judge/safety packs. They need explicit cost and policy controls before becoming release gates.

## Trace Correlation

Each run receives a `run_id` and uses `sessionKey = harness-tester-<run_id>`. The runner passes:

- `SYNESIS_HARNESS_RUN_ID`
- `SYNESIS_HARNESS_SESSION_KEY`
- `SYNESIS_HARNESS_TASK_ID`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

When `SYNESIS_EVAL_ADMIN_URL` and `SYNESIS_EVAL_ADMIN_TOKEN` are configured, the tester fetches existing Yarn session events from Admin APIs. If Admin access is unavailable, the run still completes and reports `trace_correlation_missing`.

## Artifacts

By default, artifacts are written under `harness-tester-artifacts/<run_id>/`:

- `report.json`
- `summary.md`
- `workspace.diff`
- harness stdout/stderr logs
- setup and validation stdout/stderr logs
- preserved workspace path on failures

Successful workspaces are cleaned unless `--keep-artifacts` is set.

## Behavioral Flags

Flags are deterministic and explainable. They are grouped by likely owner:

- Harness: `permission_prompt_blocked`, `harness_noninteractive_failure`, `final_success_claim_without_validation`
- Synesis/API upper harness: `api_schema_error`, `tool_call_parse_error`, `invalid_tool_result_shape`, `trace_correlation_missing`
- Model behavior: `repeated_file_reads`, `repeated_validation_without_new_changes`, `cwd_path_confusion`, `task_reset`, `no_files_changed`
- Task validation: `setup_failed`, `validation_failed`, `forbidden_file_modified`, `expected_file_not_modified`

Some flags also create adaptation signals such as `lora_candidate_path_reasoning` or `prompt_policy_candidate`. Treat those as labels for future analysis, not pass/fail evidence by themselves.

## Adding a Harness Adapter

Add an adapter that implements `HarnessTesterAdapter`:

- `name`
- `buildCommand(input)`

The adapter should set API base URL, API key, model, workspace, run id, and session key without hardcoding a personal environment. Unit tests should validate command construction without requiring the external harness to be installed.

## Adding a Task

Use JSON task files:

```json
{
  "id": "simple-python-bugfix-001",
  "name": "Fix failing Python unit test",
  "prompt": "Fix the bug causing the Python test failure. Keep the change minimal and do not edit tests.",
  "fixture": "../fixtures/simple-python-bugfix",
  "validate": ["python -m pytest -q"],
  "expected_changed": ["example_pkg/math_utils.py"],
  "forbidden_changed": ["tests/test_math_utils.py"],
  "timeout_seconds": 300,
  "tags": ["python", "pytest", "bugfix"]
}
```

Keep fixtures tiny and deterministic. The goal is plumbing and behavior validation first, not model leaderboard scoring.
