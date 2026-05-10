# Yarn tool call collapsing

Synesis Yarn can **batch, dedupe, and merge** adjacent tool calls from the model before the client executes them. Goals: fewer round-trips, less context bloat, and lower prefill churn during tool-heavy phases (e.g. Qwen3 Coder step-style `read_file` bursts).

Implementation: [`base/yarn-ts/src/tool-collapse/`](../base/yarn-ts/src/tool-collapse/).

## Canonical safe toolset

Yarn fix-forward strict mode prefers canonical safe coding tools (`read_file`, `write_file`, `apply_patch`, `search_code`, `run_test`, `run_build`, `run_lint`, `format_code`, `git_status`) while preserving client protocol compatibility. Collapse logic includes aliases from Claude/Cursor/Codex-style tool names and normalizes them before batching.

## Do clients have to implement `synesis_*` tools?

**It depends which path you use.**

| Path | Client requirement |
|------|-------------------|
| **`POST /v1/coder/tool-collapse/plan`** | **No.** Send the model’s tool calls; the response includes a **plan**, **`synthetic_tool_calls`** (if collapse applied), and validation metadata. The IDE can either execute **original** tools unchanged or adopt synthetics. |
| **Non-stream rewrite** (`SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM=true` + headers, see below) | **Yes**, for any tool name we emit (`synesis_batch_read`, `synesis_batch_search`, `synesis_repo_context`, `synesis_merge_patch`, `synesis_run_tests`). |

If you only use the **plan API**, you still get a structured plan and logs (including dropped tool call IDs from the prepass) without executing synthetics.

If you do **not** implement synthetics, keep rewrite off and use the **plan API** to drive your own batching, or execute passthrough tools only.

## Enablement (cluster)

- **Manifest default:** [`base/yarn-ts/deployment.yaml`](../base/yarn-ts/deployment.yaml) sets `SYNESIS_YARN_TOOL_COLLAPSE_ENABLED=true` so the plan route is available after apply.
- **Helm values:** set these in `workloads.yarn.env` when you need explicit overrides:

  - `SYNESIS_YARN_TOOL_COLLAPSE_ENABLED` (default **true** when patching)
  - `SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM` (default **false**)
  - `SYNESIS_YARN_TOOL_COLLAPSE_DEBOUNCE_MS` (default **100**)
  - `SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST`

- **Full feature profiles:** keep the desired flags in your environment-specific Helm values file.

## Non-stream response rewrite (optional)

When enabled **and** the client opts in per request:

1. Header `x-synesis-tool-collapse: apply`
2. A resolved workspace root for path validation: `x-synesis-project-root`, legacy `x-synesis-workspace-root`, and/or OpenAI body `metadata.synesis_project_root` (same precedence as [SESSION_EXECUTION_CONTEXT.md](clients/SESSION_EXECUTION_CONTEXT.md))
3. More than one external tool call in the completion

Yarn may replace multiple calls with fewer **`synesis_*`** calls. Arguments include `_synesis_original_tool_call_ids` for tracing and fan-out.

## Collapse rules (deterministic)

Processing order: **(1) segment-scoped prepass** → **(2) linear batching** (repo_context, batch_read, batch_search, merge_patch, …).

### 1. Prepass: interleaved duplicate reads / searches

Segments end at each **`apply_patch`**, **`run_terminal_cmd`** (and aliases), each **`synesis_artifact_retrieve` / `synesis_knowledge_search`** (protected tools do not share a dedupe window with surrounding calls).

Within a segment:

- **Read, same path again** after **any other** call in between (in the original tool list) → **drop** the later read (e.g. `read → search → read foo.js` drops the second read of `foo.js`).  
  - **Consecutive** reads of the same path are **not** dropped here; they flow to **`batch_read`** so all tool call IDs are preserved in one merged op.
- **Search, same `(query, path)` again** after **any other** call in between → **drop** the later search (e.g. `read → search("foo") → read → search("foo")` → after read/search dedupe you get `read → search("foo")` only).  
  - **Consecutive** identical searches are **not** dropped here; they flow to **`batch_search`**.

Example: `read_file("foo.js")`, `search("foo")`, `read_file("foo.js")`, `search("foo")` → prepass → **`read_file("foo.js")`, `search("foo")`** (two redundant calls removed; IDs of dropped calls appear in plan log).

### 2. Linear batching (on prepass output)

- **`read_file` (and aliases)** — consecutive reads are grouped. Paths are deduped by **file path only**. **`line_range` / `offset` / `limit` are ignored for grouping.**  
  - **Semantics:** synthetic `synesis_batch_read` uses **`full_file_per_unique_path`**; `_synesis_merged_duplicate_path_reads` when the same path had multiple reads in the batch.

- **`codebase_search` / `grep` / …** — two or more **consecutive** searches → **`synesis_batch_search`**.

- **`search` immediately followed by `read_file`** → **`synesis_repo_context`** (one pair).

- **`apply_patch` (and aliases)** — consecutive patches → **`synesis_merge_patch`**.

- **`run_terminal_cmd` / …** — identical command strings in a run → **`synesis_run_tests`** (shell allowlist).

- **Never collapsed / segment boundaries:** `synesis_artifact_retrieve`, `synesis_knowledge_search`.

### What we are **not** doing (yet)

- No arbitrary **reordering** of tools (e.g. moving all reads before all searches).
- No **`read_then_search`** synthetic unless it matches the strict `search + read` pair for `repo_context`.
- **Patch text** is not semantically merged beyond string concatenation; no third-party diff engine in Yarn.
- **`run_terminal_cmd`** is treated as mutating for segment boundaries but we do not parse which files it touches.

## Safety and limits (“100% safe”?)

We **cannot** prove collapse is correct for every possible model + workspace state without a full symbolic model of the repo. What we do:

- **Conservative segment boundaries** so we do not dedupe reads across patches, shell, or Synesis server tools.
- **Interleaved dedupe** uses the **previous call in the original segment** (not “last kept”) so dropping a redundant read does not accidentally keep a duplicate search that only looked “consecutive” after drops.
- Paths validated against workspace root; shell allowlist; strict validation fallback to **passthrough** (no synthetic tools).

**False positives** are still possible (e.g. model intentionally re-read after a no-op tool). Mitigation: plan API + logs; turn off rewrite; tune client.

## LLM bias (Qwen3 vs others)

Patterns (step-wise `read_file`, alternating search/read) show up in **many** agentic tool-calling models, not only Qwen3 Coder. Tool **names** differ by product (`read_file` vs `filesystem.read`); we use **alias sets** in [`tool-call-collapser.ts`](../base/yarn-ts/src/tool-collapse/tool-call-collapser.ts). Expand aliases as you onboard models.

## Libraries

There is **no single npm library** that “collapses agent tool calls” correctly for all stacks. Options people use elsewhere:

- **Rule-based batching** (what we do) — predictable, testable.
- **Unified diff / patch application** (e.g. `diff`/`patch` tooling) — for *validation* of merges, not usually for collapse logic itself; adds weight and still needs a trusted sandbox.
- **Tree-sitter** — great for *edit safety*, heavy for Yarn’s gateway role; keep in the **client executor** if needed.

We intentionally avoid new heavy dependencies in Yarn for this layer.

## Plan API

`POST /v1/coder/tool-collapse/plan`  
Auth: PAT + coder scope + same OpenFGA check as completions.

Body (either shape):

- `{ "tool_calls": [ { "toolCallId", "toolName", "input" } ], "workspace_root"?, "strict_validation"?, "execute"? }`
- Or OpenAI-style `tool_calls` array (see route parser in [`routes.ts`](../base/yarn-ts/src/tool-collapse/routes.ts)).

## Tests

[`base/yarn-ts/tests/tool-collapse/tool-collapse.test.ts`](../base/yarn-ts/tests/tool-collapse/tool-collapse.test.ts) covers batching, merge, dedupe, search batching, validation, and fallback.

## References

Related ideas: speculative/decoded tool batching in agent loops; **lost-in-the-middle** and context trimming are complementary (Sawtooth / reducers in Yarn), not replaced by this layer.
