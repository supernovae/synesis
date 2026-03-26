# Reducer Expansion Backlog

Prioritized list of the next 20 reducer families beyond the initial 5 (`pytest`, `tsc`, `lint`, `git`, `search`). Ordered by expected token savings and frequency in real coding workflows.

## Scaffold command

```bash
cd base/yarn-ts
npx tsx scripts/scaffold-reducer.ts <family-name>
```

This generates the reducer stub, unit fixture, live fixture, and prints wiring instructions.

## Prioritized backlog

### Tier 1 — High impact, high frequency (implement first)

| # | Family | Tool/Command | What it reduces | Est. savings |
|---|--------|-------------|----------------|-------------|
| 1 | `npm-install` | `npm install`, `npm ci`, `yarn install` | Verbose dependency tree, audit warnings, peer dep noise | 70-90% |
| 2 | `docker-build` | `docker build`, `podman build` | Layer-by-layer output, download progress, cache hits | 80-95% |
| 3 | `cargo` | `cargo build`, `cargo test`, `cargo clippy` | Compiling/downloading lines, clippy warnings | 70-85% |
| 4 | `make` | `make`, `cmake` | Build progress lines, compile commands | 75-90% |
| 5 | `stack-trace` | Exception output from Python/Node/Java/Go | Multi-frame stack traces to top N frames + cause | 60-80% |

### Tier 2 — Moderate impact, common in CI/dev

| # | Family | Tool/Command | What it reduces | Est. savings |
|---|--------|-------------|----------------|-------------|
| 6 | `jest` | `jest`, `vitest` | Test output similar to pytest but JS-flavored | 50-70% |
| 7 | `go-build` | `go build`, `go test`, `go vet` | Build errors, test failures, vet warnings | 60-75% |
| 8 | `pip-install` | `pip install`, `uv pip install` | Download progress, already-satisfied lines | 80-90% |
| 9 | `ls-tree` | `ls`, `find`, `tree`, directory listings | File tree noise when only structure matters | 40-60% |
| 10 | `curl-http` | `curl -v`, `httpx` debug, HTTP response dumps | Headers, TLS handshake, timing — keep status + body summary | 60-80% |

### Tier 3 — Specialized but high-value when triggered

| # | Family | Tool/Command | What it reduces | Est. savings |
|---|--------|-------------|----------------|-------------|
| 11 | `kubectl` | `kubectl get`, `kubectl describe`, `oc get` | Pod/event/resource listings, verbose describe output | 50-70% |
| 12 | `terraform` | `terraform plan`, `terraform apply` | Resource change plans, state output | 60-80% |
| 13 | `sql-result` | Database query results, table output | Wide result sets to summary + row counts | 50-70% |
| 14 | `mypy` | `mypy`, type checker output | Grouped type errors similar to tsc | 50-65% |
| 15 | `java-build` | `mvn`, `gradle` | Build lifecycle noise, dependency resolution | 75-90% |

### Tier 4 — Long-tail, specialized

| # | Family | Tool/Command | What it reduces | Est. savings |
|---|--------|-------------|----------------|-------------|
| 16 | `ansible` | `ansible-playbook` | Task/play recap, ok/changed/failed grouping | 60-75% |
| 17 | `helm` | `helm install`, `helm upgrade` | Release notes, hook output, resource lists | 50-65% |
| 18 | `network-diag` | `ping`, `traceroute`, `dig`, `nslookup` | Repetitive packet lines, DNS records | 40-60% |
| 19 | `strace-perf` | `strace`, `perf`, profiler output | Syscall traces, flame graph text | 70-85% |
| 20 | `log-stream` | Application log tailing, `journalctl` | Repetitive log lines, grouped by level/source | 60-80% |

## Implementation batches

### Batch A (next sprint): families 1-5
- `npm-install`, `docker-build`, `cargo`, `make`, `stack-trace`
- These cover the most frequent high-noise tool outputs

### Batch B: families 6-10
- `jest`, `go-build`, `pip-install`, `ls-tree`, `curl-http`
- Extend test runner coverage beyond Python/TS, add package manager + HTTP noise

### Batch C: families 11-15
- `kubectl`, `terraform`, `sql-result`, `mypy`, `java-build`
- Infrastructure and platform tooling

### Batch D: families 16-20
- `ansible`, `helm`, `network-diag`, `strace-perf`, `log-stream`
- Long-tail specialized domains

## Per-reducer checklist

For each new reducer family, complete:

- [ ] `npx tsx scripts/scaffold-reducer.ts <family>`
- [ ] Implement parsing logic in `src/reduction/reducers/<family>.ts`
- [ ] Add classifier rule in `src/reduction/classifier.ts`
- [ ] Wire into `ReducerFamily` type, registry, and tool-result-reducer `byFamily`
- [ ] Fill `tests/fixtures/reducers/<family>.txt` with small fixture
- [ ] Fill `tests/fixtures/live/<family>-large.txt` with realistic fixture
- [ ] Add regression test in `tests/reducer-regression.test.ts`
- [ ] Add live scenario in `scripts/live-verify.ts`
- [ ] Add scenario in `scripts/ab-reducer-compare.ts`
- [ ] Run `npm test && npm run bench:reducers`
- [ ] Run `npm run verify:live` against staging
- [ ] Verify telemetry shows new family in admin dashboard

## Classifier guidance

When adding classifier rules in `classifier.ts`:

1. Prefer explicit tool name or command matches over raw content scanning
2. Order from most specific to least specific
3. New families should be checked **before** the `"generic"` fallback but **after** the initial 5
4. Use confidence scoring when classification is ambiguous (e.g. a `go test` failure that looks like pytest)
5. Keep the fast path fast — avoid expensive regex for every message

## Fail-safe contract

Every reducer must follow the fail-safe contract:
- `reduce()` returns `null` when it can't parse the content
- The registry catches exceptions and falls back to artifact summary
- A reducer in `degraded` state still attempts reduction but is monitored
- A reducer that fails 3+ times without recovery is marked `degraded`
- Lifecycle states are visible in `/health/telemetry` and the admin dashboard
