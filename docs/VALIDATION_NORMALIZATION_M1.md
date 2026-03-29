# Validation Normalization (Milestone 1)

This document explains the validation normalization layer, its deterministic parsing architecture, and the enrichment engine that produces actionable diagnostics without an LLM call.

## What problem this solves

Coding agents often paste raw validator/test output directly into model context.  
That wastes tokens and hides the important part (what failed, where, and how to fix it).

The normalization layer:

- detects validation-like tool output (by tool name, content heuristics, or structured format)
- extracts concise findings deterministically
- classifies each finding into a known error family with root cause and suggested action
- passes a compact, actionable summary to the model
- stores oversized raw output behind an artifact handle
- keeps raw artifacts out of the core prompt path

This is a pre-admission optimization. It reduces waste before compaction and gives the model (or a future bypass layer) structured answers instead of raw text to parse.

## Resolution order

The normalizer follows a strict tiered resolution order, biasing for deterministic parsing:

| Tier | Strategy | When |
|------|----------|------|
| **A** | Structured format parser (SARIF, JUnit, Checkstyle, JSON) | Tool emits machine-readable output |
| **B** | Deterministic line-regex parser | Plain-text with known patterns (tsc, ruff, eslint, pytest, mypy, terraform) |
| **Enrichment** | Error family classification + root cause + suggested action | Applied to all findings from Tier A and B |
| **C** | Small LLM fallback *(future)* | Messy/unknown formats needing interpretation |
| **D** | Generic single-finding fallback | First line of raw output when nothing else matches |

The rule: **if the field can be extracted mechanically, do not use an LLM.**

## Deterministic enrichment engine

After parsing (Tier A or B), every finding passes through the enrichment engine (`enrichment.ts`). This is the core of the "deterministic response pattern" — it produces actionable diagnostics without calling the LLM.

### What it does per finding

1. **Error family classification** — maps the error message and rule ID to a named category (e.g. `type_mismatch`, `undeclared_variable`, `unused_import`)
2. **Root cause** — a deterministic explanation of *why* the error occurred, from per-tool lookup tables
3. **Suggested next action** — a deterministic, file-aware action telling the agent *what to do*, with `{file}` interpolation
4. **Fingerprint** — SHA1-based content hash for dedup across repeated runs
5. **Repeat detection** — marks duplicate findings so the model doesn't waste tokens on them

### What the model sees (example)

Before enrichment:
```
1. [error] main.tf:15 - Reference to undeclared input variable
```

After enrichment:
```
1. [error] main.tf:15 - Reference to undeclared input variable
   Root cause: An input variable is referenced but not declared in any variables file.
   Action: Inspect main.tf and the corresponding variables.tf for a missing variable declaration.
```

The model receives an actionable summary with root cause and next step already determined. It can proceed directly to the fix instead of reasoning about what the error means.

### Supported tool classifiers

| Tool | Error families | Example families |
|------|---------------|-----------------|
| **TypeScript** | 9 | `type_mismatch`, `undeclared_name`, `null_check`, `import_error` |
| **ESLint** | 7 | `unused_symbol`, `style`, `type_safety`, `best_practice` |
| **Ruff** | 9 | `unused_import`, `unused_variable`, `security`, `complexity` |
| **pytest** | 8 | `assertion_failure`, `fixture_error`, `import_error`, `timeout` |
| **mypy** | 9 | `type_mismatch`, `argument_type`, `return_type`, `attribute_access` |
| **pylint** | 7 | `undeclared_name`, `convention`, `complexity`, `unused_symbol` |
| **Terraform** | 11 | `undeclared_variable`, `unsupported_argument`, `provider_configuration`, `dependency_cycle` |
| **Cargo/rustc** | 9 | `type_mismatch`, `ownership`, `borrow_error`, `trait_bound`, `lifetime` |
| **golangci-lint** | 8 | `unused_assignment`, `vet_error`, `unchecked_error`, `static_analysis` |
| **tfsec** | 7 | `critical_vulnerability`, `secret_exposure`, `excessive_permissions` |
| **trivy** | 7 | `critical_vulnerability`, `known_cve`, `weak_encryption` |
| **semgrep** | 7 | `injection`, `xss`, `secret_exposure`, `weak_encryption` |

Each classifier has a corresponding root cause table and action table. Actions support `{file}` interpolation for context-specific suggestions.

## Structured format parsers (Tier A)

These are tried first and produce the highest-fidelity extractions.

### SARIF (`parsers/sarif.ts`)

Handles SARIF v2.1.0 JSON from any compliant emitter. Extracts `ruleId`, severity level, physical location (file/line/column), and message text. Infers tool family from the embedded `tool.driver.name`.

**Tools that emit SARIF:** ESLint (sarif formatter), tfsec, trivy, semgrep, CodeQL, checkov.

### JUnit XML (`parsers/junit.ts`)

Parses `<testcase>` elements with `<failure>` or `<error>` children. Extracts test name, classname-to-file mapping, failure message, and best-effort line number from stack traces. Skips passing tests entirely.

**Tools that emit JUnit:** pytest (`--junitxml`), Jest (jest-junit), go-junit-report, cargo2junit, tfsec.

### Checkstyle XML (`parsers/checkstyle.ts`)

Parses `<file>` → `<error>` structure. Extracts file, line, column, severity, message, and source rule.

**Tools that emit Checkstyle:** ESLint (checkstyle formatter), PHP_CodeSniffer, detekt, SwiftLint, golangci-lint.

### JSON diagnostics (`parsers/json-diagnostics.ts`)

A registry of sub-parsers for tool-specific JSON schemas:

| Sub-parser | Detection | Tools |
|-----------|-----------|-------|
| ESLint JSON | `[{ filePath, messages }]` | ESLint `--format json` |
| Ruff JSON | `[{ filename, code, location }]` | Ruff `--output-format json` |
| mypy JSON | `[{ file, severity, message }]` | mypy `--output json` |
| pylint JSON | `[{ path, message-id }]` | pylint `--output-format json` |
| cargo/clippy | NDJSON `reason: "compiler-message"` | cargo clippy `--message-format=json` |
| golangci-lint | `{ Issues: [...] }` | golangci-lint `--out-format json` |
| tfsec JSON | `{ results: [{ rule_id }] }` | tfsec `--format json` |
| trivy JSON | `{ Results: [{ Vulnerabilities }] }` | trivy `--format json` |

## Line-regex parsers (Tier B)

For plain-text output with known patterns:

- **TypeScript** — `file(line,col): error TSxxxx: message`
- **Ruff** — `file:line:col: CODE message`
- **ESLint** — `file:line:col: severity message  rule-name`
- **pytest** — `___ test_name ___` headers + `E       ` assertion lines
- **mypy** — `file:line: severity: message [code]`
- **Terraform** — `Error: message` blocks with `on file line N` locations

## What was added

### Core runtime pieces

- `base/yarn-ts/src/validation/types.ts`
  - `ValidationFamily` expanded: typescript, eslint, ruff, pytest, mypy, pylint, jest, cargo, go, golangci-lint, terraform, tfsec, trivy, semgrep, generic
  - `ValidationOutputFormat`: sarif, junit, checkstyle, json, text
  - `ValidationFinding` includes: `column`, `ruleId`, `errorFamily`, `likelyRootCause`, `suggestedNextAction`, `rawFingerprint`, `isRepeat`
- `base/yarn-ts/src/validation/enrichment.ts`
  - Error family classifiers for 12 tool families
  - Root cause lookup tables (100+ entries)
  - Suggested next action tables with `{file}` interpolation (100+ entries)
  - SHA1 fingerprinting and repeat detection
- `base/yarn-ts/src/validation/parsers/sarif.ts`
  - SARIF v2.1.0 deterministic parser with tool-family inference
- `base/yarn-ts/src/validation/parsers/junit.ts`
  - JUnit XML deterministic parser with stack-trace line extraction
- `base/yarn-ts/src/validation/parsers/checkstyle.ts`
  - Checkstyle XML deterministic parser
- `base/yarn-ts/src/validation/parsers/json-diagnostics.ts`
  - Sub-parser registry for ESLint, Ruff, mypy, pylint, cargo, golangci-lint, tfsec, trivy JSON
- `base/yarn-ts/src/validation/parsers/index.ts`
  - Format detection + structured parser routing (SARIF → JSON → JUnit → Checkstyle)
- `base/yarn-ts/src/validation/normalizer.ts`
  - Tries structured parsers (Tier A), then line-regex (Tier B), then enrichment on all findings
  - Terraform text parser for `terraform validate` output
  - Summary includes root cause and action lines per finding
- `base/yarn-ts/src/validation/admission-policy.ts`
  - Applies limits and emits artifact handles (unchanged, works with all formats)
- `base/yarn-ts/src/state/artifact-store.ts`
  - In-memory handle store for oversized raw payloads
- `base/yarn-ts/src/validation/service.ts`
  - Orchestrates detection, normalization, admission policy, and telemetry counters
  - Tool hints expanded for all supported validators including terraform

### Runtime integration

- `base/yarn-ts/src/index.ts`
  - Normalizes request messages before model admission (OpenAI and Claude paths)
  - Exposes normalization stats in `/health/telemetry`
  - Exposes artifact retrieval endpoint `/v1/artifacts/:id`

### Configuration knobs

Added to `base/yarn-ts/src/config.ts`:

- `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS`
- `SYNESIS_YARN_VALIDATION_MAX_FINDINGS`
- `SYNESIS_YARN_VALIDATION_INCLUDE_RAW`

## Test coverage

Every parser adapter and classifier has dedicated tests:

| Test file | What it covers |
|-----------|---------------|
| `tests/enrichment.test.ts` | All 12 tool classifiers, root cause tables, action tables with file interpolation, fingerprinting, repeat detection, likelyFix override behavior |
| `tests/parsers-sarif.test.ts` | SARIF detection, multi-run, level mapping, family inference, no-location results |
| `tests/parsers-junit.test.ts` | pytest/Jest JUnit, failure vs error, pass-only suite, line extraction, maxFindings |
| `tests/parsers-checkstyle.test.ts` | ESLint/golangci-lint checkstyle, severity mapping, multi-file, empty suite |
| `tests/parsers-json-diagnostics.test.ts` | ESLint, Ruff, mypy, pylint, cargo, golangci-lint, tfsec, trivy JSON; unrecognized JSON rejection |
| `tests/parsers-registry.test.ts` | Format detection routing, SARIF-over-JSON preference, plain-text fallthrough |
| `tests/validation-normalizer.test.ts` | All line parsers + terraform; enrichment integration (errorFamily, rootCause, action in output); structured-first preference |
| `tests/admission-policy.test.ts` | Under-limit summary, over-limit artifact handle |
| `tests/validation-service.test.ts` | End-to-end message normalization with stats tracking |

## Future: deterministic LLM bypass (Option B)

The enrichment engine produces structured, actionable responses for well-known validator patterns. A future enhancement can use this to **skip the upstream LLM entirely** when the deterministic response is sufficient:

### How it would work

1. **Bypass policy** — a new layer between normalization and the model call that inspects the enriched envelope:
   - If **all** findings have a classified `errorFamily` + `suggestedNextAction` → eligible for bypass
   - If the latest user message is a simple "continue" / "fix this" → eligible for bypass
   - If findings include unclassified errors or the user asked a question → forward to LLM
2. **Synthetic response** — Yarn produces an OpenAI-compatible `chat/completions` response without calling upstream. IDE clients treat it as a normal assistant message.
3. **Confidence scoring** — the bypass policy tracks what percentage of findings were classified, and only fires above a configurable threshold (e.g. 90%).
4. **Telemetry** — track bypass rate, synthetic response acceptance, and cases where the user corrected or re-asked.

### Why this is safe

- The enrichment tables are mechanical (no hallucination risk)
- Unclassified findings always fall through to the LLM
- The bypass is conservative by default — any ambiguity sends to the model
- IDE clients don't distinguish synthetic from real model responses (standard OpenAI format)

### When this matters most

- **Hot validation loops** — agent runs linter, sees errors, fixes, runs again. Each iteration currently costs an upstream model call. With bypass, well-known errors get instant deterministic responses.
- **CI-like patterns** — `terraform validate`, `ruff check`, `tsc --noEmit` produce highly predictable output. The model adds no insight beyond what the deterministic tables already provide.
- **Cost** — each bypassed request saves one upstream LLM call (latency + tokens + cost).

### Implementation path

1. Add a `bypassEligible: boolean` field to `ValidationEnvelope` based on classification coverage
2. Add a `SYNESIS_YARN_VALIDATION_BYPASS_ENABLED` config flag (default off)
3. Add a bypass policy function that checks the envelope + latest user message
4. Add synthetic response formatting that mimics the model's typical response structure
5. Add telemetry counters: `bypassCount`, `bypassRate`, `classificationCoverage`

## Why this matters

- fewer tokens sent upstream
- faster response times on validation-heavy loops
- clearer and more actionable error summaries with deterministic root cause and suggested actions
- the model receives "what went wrong, why, and what to do" instead of raw tool output
- deterministic extraction means reproducible results and easier debugging
- raw artifacts stay out of prompt path — model sees only structured summaries
- fingerprinting and repeat detection prevent redundant diagnostics
- better portability across Claude Code, Cursor, VS Code/Copilot, Continue, Cline, Roo, and others
