# M8: Reducer Registry

Command-aware reducers that compact verbose tool output before it reaches the model,
saving 60-90% tokens on common dev workflows.

## Architecture

```
Tool output (raw)
       │
       ▼
  ┌─────────────┐     Phase 1: toolName / command hints
  │  Classifier  │     Phase 2: raw content fingerprints
  └──────┬──────┘
         │  ReducerFamily
         ▼
  ┌─────────────┐     Per-family parsing + summarisation
  │   Reducer    │     Returns <TOOL_REDUCED family="…">
  └──────┬──────┘
         │  null? → falls back to artifact-handle summary
         ▼
  ┌─────────────┐
  │  Artifact    │     Full raw stored; handle returned for debugging
  │  Store       │
  └─────────────┘
```

Source: `base/yarn-ts/src/reduction/`

## 55 Reducer Families (live-verified)

All families are **enabled by default**. Disable specific families via
`SYNESIS_YARN_REDUCER_DISABLED_FAMILIES` (comma-separated).

| Batch | Families | Category |
|-------|----------|----------|
| 1 (M8 launch) | `pytest` `tsc` `lint` `git` `search` | Core dev |
| 2 (20 families) | `npm-install` `docker-build` `cargo` `make` `stack-trace` `jest` `go-build` `pip-install` `ls-tree` `curl-http` `kubectl` `terraform` `sql-result` `mypy` `java-build` `ansible` `helm` `network-diag` `strace-perf` `log-stream` | Build / infra / diagnostics |
| 3 | `git-diff` `podman` `oc` `docker-compose` `coverage` | Container / VCS |
| 4 | `aws-cli` `gcloud` `az-cli` `npm-audit` `webpack` | Cloud CLIs / audit |
| 5 | `vite` `esbuild` `yarn-install` `pnpm` `apt-pkg` | JS build / pkg managers |
| 6 | `mocha` `rspec` `phpunit` `python-unittest` `dotnet` | Test runners |
| 7 | `pylint` `shellcheck` `clippy` `rubocop` `cppcheck` | Linters / static analysis |
| 8 | `gradle` `swift-build` `cmake` `composer` `git-log` | Remaining build / VCS |

Plus `generic` (fallback for unrecognised output).

## Classifier Design

`classifier.ts` routes tool output to the correct reducer in two phases:

**Phase 1 — command hints** (high confidence):
When `toolName` or `command` is specific (e.g. `pytest`, `cargo clippy`, `oc get`),
pattern-match on the combined `toolName + command` string. This always wins over Phase 2.

**Phase 2 — raw content fingerprints** (when `toolName = "bash"`):
Scan the lowercased raw output for family-specific markers (keywords, regexes).
This is where ordering matters — specific families MUST precede their generic superset:

| Ordering rule | Why |
|---------------|-----|
| `git` (status markers) before `git-diff` | git status output can embed diff fragments |
| Linters before test runners | pytest's `"failed" + "test_"` is too broad — catches pylint, phpunit, etc. |
| `phpunit` / `python-unittest` before `pytest` | All three share "failed" + "test_" keywords |
| `pnpm` before `yarn-install` | Both share "resolution step" + "done in" |
| `yarn-install` / `pnpm` before `npm-install` | npm-install's "added" + "packages" matches all three |
| `cppcheck` before `make` | cppcheck's `.cpp:N: error:` triggers make's C-file heuristic |
| `cmake` before `make` | cmake command names contain "make" as substring |

## Runtime Controls

| Env var | Default | Purpose |
|---------|---------|---------|
| `SYNESIS_YARN_REDUCERS_ENABLED` | `true` | Master kill-switch |
| `SYNESIS_YARN_REDUCER_DISABLED_FAMILIES` | `""` (none) | Comma-separated families to disable |
| `SYNESIS_YARN_REDUCER_MIN_CONFIDENCE` | `0.6` | Floor below which reducer output is discarded |
| `SYNESIS_YARN_REDUCER_PROFILE` | `balanced` | `balanced` / `aggressive` / `ultra` |

## Telemetry

`/health/telemetry` exposes:

- `reducedCount`, `rawCharsTotal`, `reducedCharsTotal`, `tokensSavedEstimateTotal`
- Per-family counters (`family.<name>`)
- Reducer lifecycle map (`enabled` / `degraded` / `disabled`) with `ok` / `fail` counts
- `reducerFailures` (zero in healthy state)

## Fail-safe Behavior

- If a reducer returns `null` (not applicable) or throws, Yarn falls back to
  artifact-handle summaries — requests are never blocked.
- After repeated failures, a family transitions `enabled → degraded → disabled`
  (self-healing via lifecycle state machine).

## Development Workflow

| Task | Command |
|------|---------|
| Run regression tests | `npm test` (249 tests, all 55 families) |
| Benchmark reducers | `npm run bench:reducers` |
| Live verification | `npm run verify:live` (requires Yarn URL + PAT: `SYNESIS_TEST_PAT_TOKEN` or `SYNESIS_TEST_AUTH`; see `docs/development/CI_GITHUB_VALIDATION.md`) |
| Add a new reducer | Create `src/reduction/reducers/<name>.ts`, register in `registry.ts`, add fixtures, update `ReducerFamily` type |

Fixtures live in:
- `tests/fixtures/reducers/*.txt` — small (200-500 chars), unit-test focus
- `tests/fixtures/live/*.txt` — large (1-3 KB), realistic output for live verification

## Future: Scored Multi-Match Classifier

The current Phase 2 classifier is a linear if/else cascade — the first matching rule wins.
This is ordering-sensitive: adding a new family can silently steal matches from existing ones.
We hit this repeatedly during the 30-family expansion (7 misclassifications in one round).

**Proposed alternative: fingerprint scoring.**

Instead of first-match-wins, define a declarative fingerprint per family and score all
families in parallel, picking the highest-scoring match:

```typescript
interface FamilyFingerprint {
  /** Keywords that MUST appear (each hit = +1 score) */
  keywords: string[];
  /** Regex patterns (each match = +2 score) */
  patterns: RegExp[];
  /** Anti-keywords — presence disqualifies this family */
  antiKeywords?: string[];
  /** Minimum score threshold to be a candidate */
  minScore: number;
}

const FINGERPRINTS: Record<string, FamilyFingerprint> = {
  "phpunit":  { keywords: ["phpunit", "assertions:"], patterns: [/tests:\s*\d+.*assertions:\s*\d+/i], minScore: 2 },
  "pytest":   { keywords: ["test_", "::test", "=== failures"], patterns: [/passed|failed/], antiKeywords: ["phpunit", "assertions:"], minScore: 2 },
  "cppcheck": { keywords: ["(error)", "(warning)", "(style)"], patterns: [/\[\w+\]/], minScore: 2 },
  "make":     { keywords: ["make[", "make:"], patterns: [/\.(c|cpp|h):\d+/], antiKeywords: ["(error)", "(style)"], minScore: 2 },
  // ... all 55 families
};
```

**Benefits:**
- **Ordering-independent** — no fragile if/else cascade
- **Self-documenting** — each family's fingerprint is pure data, easy to audit
- **Anti-keywords** replace implicit ordering rules (e.g. pytest's anti-keywords
  explicitly exclude phpunit output instead of relying on check order)
- **Extensible** — adding a family never silently steals another family's matches
**When to do this:** After the current 55-family set is stable in production and we
have telemetry data on real-world misclassification rates. The current ordered
cascade works with the documented ordering rules; the scored approach is insurance
for when we scale to 100+ families.

## Live Verification

See [LIVE_VERIFICATION_M9.md](./LIVE_VERIFICATION_M9.md) for the live verification
suite that exercises all 55 reducers against a deployed Yarn instance, validates
telemetry counters, and supports A-B profile comparison.
