# Tool Result Reduction + Artifact Handles (Milestone 2)

This milestone extends M1 so we do not only normalize validation logs.  
We now reduce oversized tool results in general, enrich validator-family outputs with deterministic diagnostics, and pass concise envelopes to the model.

## Plain-language summary

Before:
- agents often forwarded huge tool outputs into context
- token usage spiked even when only a small part was needed
- model had to reason about what errors mean and how to fix them

After:
- oversized tool results are replaced with a compact summary
- raw payload is stored behind an `artifact_handle`
- validator-family reducers include root cause and suggested next action per finding
- model sees actionable signal, not raw dumps — and can often skip reasoning about well-known errors
- `bypassEligible` flag marks reductions where all findings were deterministically classified

## What was implemented

### Core runtime

- `base/yarn-ts/src/reduction/tool-result-reducer.ts`
  - detects oversized `role=tool` messages
  - emits `<TOOL_REDUCED ...>` envelopes via family-specific reducers
  - falls back to `<TOOL_RESULT_SUMMARY>` with artifact handle when no reducer matches
  - tracks `enrichedCount` and `bypassEligibleCount` in stats
- `base/yarn-ts/src/reduction/types.ts`
  - `ReducerOutput` extended with `enrichedItems?: EnrichedItem[]` and `bypassEligible?: boolean`
  - `EnrichedItem` type: `{ message, file?, ruleId?, errorFamily?, rootCause?, action? }`
- `base/yarn-ts/src/reduction/enrich-bridge.ts`
  - bridge between M2 reducers and M1's enrichment classifiers
  - maps reducer families to M1 `ValidationFamily` names
  - produces enriched lines (Root cause / Action) and bypass eligibility flag
  - supports lint sub-family dispatch (eslint vs ruff)
- `base/yarn-ts/src/state/artifact-store.ts`
  - supports both `validation-output` and `tool-result` artifact kinds
- `base/yarn-ts/src/tool-mapping.ts`
  - `claudeMessagesToOpenAI` accepts optional tool-result reducer callback
- `base/yarn-ts/src/index.ts`
  - OpenAI path: tool-result reduction runs before validation normalization
  - Claude path: reducer callback applied while adapting content blocks
  - telemetry now includes `toolResultReduction` stats with enrichment counters
  - artifact fetch endpoint uses shared artifact store

### Enrichment-integrated reducers (13 families)

All validator-family reducers now import the enrich bridge and include Root cause / Action lines in their `<TOOL_REDUCED>` envelopes:

| Reducer | Family | Enrichment source (M1 classifier) |
|---------|--------|-----------------------------------|
| `pytest.ts` | pytest | pytest classifier |
| `tsc.ts` | tsc | TypeScript classifier |
| `lint.ts` | lint | ESLint or Ruff classifier (auto-detected) |
| `mypy.ts` | mypy | mypy classifier |
| `pylint.ts` | pylint | pylint classifier |
| `cargo.ts` | cargo | Cargo/rustc classifier |
| `clippy.ts` | clippy | Cargo/rustc classifier |
| `terraform.ts` | terraform | Terraform classifier |
| `jest.ts` | jest | Jest classifier |
| `go-build.ts` | go-build | Go classifier |
| `shellcheck.ts` | shellcheck | ShellCheck classifier |
| `rubocop.ts` | rubocop | RuboCop classifier |
| `cppcheck.ts` | cppcheck | cppcheck classifier |

### Enriched output example

Before (M2 only):
```
<TOOL_REDUCED family="mypy" errors="2">
  1. app/config.py:42: error: Incompatible types in assignment [assignment]
  2. app/config.py:58: error: "str" has no attribute "nonexistent" [attr-defined]
</TOOL_REDUCED>
```

After (M2 + enrichment):
```
<TOOL_REDUCED family="mypy" errors="2">
  1. Incompatible types in assignment
     Root cause: The assigned value's type is incompatible with the declared variable type.
     Action: Fix the assignment in app/config.py to match the declared type, or add an explicit cast.
  2. "str" has no attribute "nonexistent"
     Root cause: An attribute or method does not exist on the inferred type.
     Action: Check the type — the attribute may not exist or a different type is needed.
</TOOL_REDUCED>
```

## Why this helps the platform

- lowers token and latency overhead for tool-heavy sessions
- enrichment reduces what the model needs to reason about (it gets actionable answers, not puzzles)
- `bypassEligible` flag prepares for deterministic responses that skip the LLM entirely
- improves consistency across clients (Claude Code, Cursor, Continue, Cline, Roo, etc.)
- keeps portability by enforcing a common runtime envelope format

## M1 classifiers added for M2 integration

Five new tool classifiers were added to M1's enrichment engine to support M2 reducer families that didn't have classifiers:

| Classifier | Error families | Example families |
|-----------|---------------|-----------------|
| **Jest** | 8 | `assertion_failure`, `snapshot_mismatch`, `mock_assertion`, `import_error` |
| **Go** | 9 | `undeclared_name`, `type_mismatch`, `unused_import`, `import_cycle` |
| **ShellCheck** | 11 | `unquoted_variable`, `deprecated_syntax`, `missing_cd_check`, `declare_assign` |
| **RuboCop** | 7 | `style`, `lint_warning`, `complexity`, `naming_convention`, `security` |
| **cppcheck** | 8 | `null_dereference`, `memory_leak`, `buffer_overflow`, `uninitialized_variable` |

Total classifier coverage: **17 tool families** with 140+ error family classifications, each with root cause and suggested action tables.

## Current tool coverage and future candidates

### Currently enrichment-supported (M1 classifiers + M2 reducers)

| Tool | M1 Classifier | M2 Reducer | Structured format support |
|------|:---:|:---:|---|
| TypeScript (tsc) | yes | yes | text (line-regex) |
| ESLint | yes | yes | SARIF, Checkstyle, JSON, text |
| Ruff | yes | yes | JSON, text |
| pytest | yes | yes | JUnit, text |
| mypy | yes | yes | JSON, text |
| pylint | yes | yes | JSON, text |
| Jest | yes | yes | JUnit, text |
| Cargo / rustc | yes | yes | JSON (NDJSON), text |
| Clippy | yes | yes | JSON (NDJSON), text |
| Go build | yes | yes | text |
| golangci-lint | yes | M2 via lint | Checkstyle, JSON, text |
| Terraform | yes | yes | text |
| tfsec | yes | M2 via lint/generic | SARIF, JSON |
| trivy | yes | M2 via lint/generic | SARIF, JSON |
| semgrep | yes | M2 via lint/generic | SARIF, JSON |
| ShellCheck | yes | yes | GCC-style text, annotated text |
| RuboCop | yes | yes | text |
| cppcheck | yes | yes | bracket text, colon text |

### Future tool candidates for enrichment

These tools have M2 reducers but no enrichment classifiers yet. Adding classifiers would increase deterministic coverage and further reduce LLM overhead.

**High priority** (common in agent workflows, predictable error patterns):

| Tool | M2 Reducer | Notes |
|------|:---:|---|
| **Mocha** | yes | JS test runner — patterns similar to Jest; assertion/timeout/import families |
| **RSpec** | yes | Ruby test runner — assertion/pending/fixture patterns; similar to pytest |
| **PHPUnit** | yes | PHP test runner — assertion/exception patterns |
| **python-unittest** | yes | Python stdlib tests — assertion/error patterns, subset of pytest |
| **dotnet (MSBuild/NUnit)** | yes | C# build + test — CS error codes, NUnit assertion patterns |
| **webpack** | yes | JS bundler — module-not-found, loader errors, asset size limits |
| **vite** | yes | JS bundler — resolve errors, dependency pre-bundling failures |
| **esbuild** | yes | JS bundler — import resolution, syntax errors, target compat |
| **npm audit** | yes | Vulnerability report — severity levels, advisories, fix paths |

**Medium priority** (infra/build tools with structured errors):

| Tool | M2 Reducer | Notes |
|------|:---:|---|
| **Gradle** | yes | JVM build — compilation errors, dependency resolution, test failures |
| **Java/Maven build** | yes | JVM build — javac errors, dependency conflicts |
| **Swift build** | yes | Xcode/SPM build — type errors, linking failures |
| **CMake** | yes | C/C++ build system — config errors, missing dependencies |
| **Docker build** | yes | Dockerfile errors — stage failures, copy/run errors, layer caching |
| **Ansible** | yes | Infra playbook — task failures, module errors, unreachable hosts |
| **Helm** | yes | K8s package — template render errors, value validation |

**Lower priority** (less predictable error patterns, or output is already compact):

| Tool | M2 Reducer | Notes |
|------|:---:|---|
| **kubectl / oc** | yes | K8s CLI — pod status, events; output varies widely |
| **AWS CLI / gcloud / az CLI** | yes | Cloud CLIs — error codes are well-defined but context-dependent |
| **Composer** | yes | PHP package manager — dependency resolution errors |
| **pip-install** | yes | Python package manager — dependency conflicts, build failures |
| **npm-install / yarn / pnpm** | yes | JS package managers — peer dep conflicts, registry errors |
| **apt-pkg** | yes | Debian packages — dependency conflicts |
| **Podman / docker-compose** | yes | Container orchestration — startup failures, port conflicts |
| **Coverage** | yes | Code coverage — threshold failures, uncovered lines |
| **strace/perf** | yes | System profiling — output is highly variable |
| **log-stream** | yes | Application logs — too varied for meaningful classification |

### Tools not yet in M2 that should be considered

These tools are common in agent workflows but don't have M2 reducers yet:

| Tool | Output format | Why |
|------|--------------|-----|
| **Biome** | JSON, text | JS/TS linter replacing ESLint for many projects |
| **oxlint** | text | Fast Rust-based JS linter, gaining adoption |
| **deno lint / check** | text | Deno's built-in linter and type checker |
| **Bun test** | text | Bun's test runner, different output format from Jest |
| **pnpm audit** | JSON | Like npm audit but different JSON schema |
| **cargo-deny** | text | Rust dependency audit tool |
| **hadolint** | SARIF, JSON, text | Dockerfile linter |
| **actionlint** | text | GitHub Actions workflow linter |
| **vale** | JSON | Prose/docs linter for technical writing |
| **sqlfluff** | JSON, text | SQL linter |
| **taplo** | text | TOML linter/formatter |
| **yamllint** | text | YAML linter |
| **markdownlint** | text | Markdown linter |
| **stylelint** | JSON, text | CSS/SCSS linter |
| **commitlint** | text | Git commit message linter |
| **pre-commit** | text | Hook runner aggregating multiple linters |
| **Snyk** | SARIF, JSON | Security scanner (SCA + SAST) |
| **Checkov** | SARIF, JSON | IaC security scanner (broader than tfsec) |

## Expansion paths

1. ~~Add tool-specific reducers~~ — done (55 families)
2. **Add enrichment classifiers to high-priority M2 reducers** (Mocha, RSpec, PHPUnit, webpack, vite, esbuild, npm audit, etc.)
3. **Add severity/risk tags to envelopes** for routing and policy decisions
4. **Route to deterministic responses** (LLM bypass) when envelope indicates clear next action and `bypassEligible=true`
5. **Persist artifacts in Redis/object storage** for multi-replica durability
6. **Add per-client formatting profiles** (IDE, CLI, PR/background)
7. **Add M2 reducers for uncovered common tools** (Biome, hadolint, sqlfluff, etc.)

## Success metrics

- `toolResultReduction.reducedCount` — total reductions
- `toolResultReduction.artifactHandleCount` — artifact handle fallbacks
- `toolResultReduction.tokensSavedEstimateTotal` — estimated token savings
- `toolResultReduction.enrichedCount` — reductions that included deterministic enrichment
- `toolResultReduction.bypassEligibleCount` — reductions where all findings were classified (eligible for LLM bypass)
- lower average admitted chars per request for tool-heavy sessions
