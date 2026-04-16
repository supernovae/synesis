# Dual-Agent Governor Optimizer

Two-script system for stress-testing the execution governor without running a full user workload:

- **Worker** (`governor-worker.ts`) — drives Go-task scenarios through the Yarn API and captures governor events
- **Monitor** (`governor-monitor.ts`) — calls the LLM with the session transcript + governor source to identify misfires and suggest fixes
- **Loop** (`dual-agent-loop.ts`) — orchestrates worker → monitor over N iterations

Two modes: **simulated** (deterministic, no cluster required) and **live** (real tool execution through the `synesis-sandbox` warm pool).

---

## Prerequisites

### First-time cluster setup

Deploy the network policies that allow Yarn to reach the sandbox warm pool directly via cluster DNS (no `kubectl port-forward` needed):

```bash
./scripts/deploy.sh
```

Or apply only the new policies:

```bash
oc apply -f base/sandbox/warm-pool-allow-yarn.yaml
oc apply -f base/yarn-ts/network-policy.yaml
```

This is a one-time step. After deploy, `synesis-yarn` pods can reach `http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080/execute` directly.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `SYNESIS_YARN_URL` | always | Yarn base URL, e.g. `http://yarn.synesis-yarn.svc.cluster.local:8000` |
| `SYNESIS_YARN_TOKEN` | always | Bearer token for Yarn (also accepts `SYNESIS_TEST_PAT_TOKEN`) |
| `SYNESIS_ADMIN_URL` | optional | Admin API URL for governor telemetry |
| `SYNESIS_ADMIN_TOKEN` | optional | Admin bearer token |
| `SYNESIS_MONITOR_URL` | optional | LLM URL for monitor (defaults to `SYNESIS_YARN_URL`) |
| `SYNESIS_MONITOR_KEY` | optional | LLM key for monitor (defaults to `SYNESIS_YARN_TOKEN`) |
| `SYNESIS_MONITOR_MODEL` | optional | Model override for monitor |
| `SYNESIS_SANDBOX_URL` | optional | Sandbox warm pool URL (defaults to cluster DNS) |
| `SYNESIS_SANDBOX_SECRET` | optional | Sandbox auth secret |

---

## Running

All commands run from `base/yarn-ts/`.

### Smoke test — simulated mode (no cluster needed)

```bash
npm run governor:worker -- --all --mode simulated --out /tmp/session.json
```

Uses canned tool results from the scenario definitions. Fully local, no Yarn or sandbox required.

### Analyse a session with the monitor

```bash
npm run governor:monitor -- --session /tmp/session.json --out /tmp/analysis.json
```

Sends the session + full `execution-governor.ts` source to the LLM. Returns structured JSON with:
- **misfires** — rules that fired but shouldn't have
- **missing_fires** — patterns that should have triggered a rule but didn't
- **threshold_suggestions** — specific numeric changes (e.g. lower a threshold from 5 to 3)
- **new_rule_ideas** — patterns not covered by any existing rule
- **new_test_fixtures** — concrete replay fixtures for gaps found

Add `--write-fixtures` to auto-save fixtures to `tests/fixtures/governor-replay/`:

```bash
npm run governor:monitor -- --session /tmp/session.json --write-fixtures
```

### Full loop — simulated (good starting point)

```bash
npm run governor:loop -- \
  --iterations 3 \
  --mode simulated \
  --all \
  --out-dir /tmp/governor-loop
```

Runs 3 worker→monitor cycles. Each iteration writes to `/tmp/governor-loop/iter-N/session.json` and `/tmp/governor-loop/iter-N/analysis.json`. A `loop-report.json` aggregate is written at the end.

### Full loop — live mode (on-cluster, real sandbox execution)

```bash
SYNESIS_YARN_URL=http://yarn.synesis-yarn.svc.cluster.local:8000 \
SYNESIS_YARN_TOKEN=<your-token> \
SYNESIS_ADMIN_URL=http://admin.synesis-admin.svc.cluster.local:8080 \
SYNESIS_ADMIN_TOKEN=<admin-token> \
npm run governor:loop -- \
  --iterations 3 \
  --mode live \
  --all \
  --out-dir /tmp/governor-loop \
  --write-fixtures
```

Live mode forwards bash/shell tool calls to the real `synesis-sandbox` warm pool instead of using canned responses. This generates authentic `go test` output (real exit codes, real compile errors, real `[no test files]` messages) that the governor's regex patterns must handle correctly.

### Run a single scenario

```bash
# Simulated
npm run governor:worker -- --scenario go-cli-stall-loop --mode simulated --out /tmp/session.json

# Live
npm run governor:worker -- --scenario go-cli-exit-code-loop --mode live --out /tmp/session.json
```

---

## Available scenarios

| ID | Governor edge exercised | What it tests |
|---|---|---|
| `go-cli-happy-path` | No pause expected | Clean edit → build → test flow |
| `go-cli-stall-loop` | `source_file_stale_reread` | Reads main.go 3+ times without editing |
| `go-cli-verbal-churn` | `verbal_intent_without_action` | "I'll run the tests" loop without running tests |
| `go-cli-exit-code-loop` | `verification_churn_no_edit` | `go test` fails 4× with exit code 1, no edit |
| `go-cli-no-test-files` | `no_test_files_repeat` | `go test` returns `[no test files]` twice |

---

## Quick reference

| Command | What it does |
|---|---|
| `npm run governor:worker -- --all --mode simulated` | Run all 5 scenarios, canned results |
| `npm run governor:worker -- --scenario go-cli-stall-loop --mode live` | One scenario, real sandbox |
| `npm run governor:monitor -- --session /tmp/session.json` | Analyse session with LLM |
| `npm run governor:monitor -- --session /tmp/session.json --write-fixtures` | Analyse + save fixtures |
| `npm run governor:loop -- --iterations 2 --mode simulated --all` | 2-cycle loop, simulated |
| `npm run governor:loop -- --iterations 3 --mode live --all --write-fixtures` | Full live loop + fixtures |

---

## Typical workflow

1. **Smoke test** with `--mode simulated --all` from your laptop to confirm the pipeline is wired up
2. After `deploy.sh`, run one **live** scenario to verify sandbox connectivity: `--scenario go-cli-happy-path --mode live`
3. Run a **full live loop** with `--iterations 3 --write-fixtures` to generate authentic telemetry
4. Review `governor-analysis.json` for threshold suggestions and rule ideas
5. If fixtures were written, run `npm run test:governor:unit` — the replay fixture tests pick them up automatically
6. Apply any threshold or rule changes to `execution-governor.ts` and re-run to validate

---

## File locations

```
base/yarn-ts/scripts/
  governor-worker.ts         # Worker driver
  governor-monitor.ts        # Monitor analyst
  dual-agent-loop.ts         # Loop orchestrator
  lib/
    sandbox-executor.ts      # Sandbox tool-call interceptor

base/yarn-ts/src/eval/scenarios/
  golang-worker.ts           # 5 Go-task scenarios

base/sandbox/
  warm-pool-allow-yarn.yaml  # NetworkPolicy: synesis-yarn → warm pool
  kustomization.yaml         # Includes warm-pool-allow-yarn.yaml

base/yarn-ts/
  network-policy.yaml        # Egress rule: synesis-yarn → synesis-sandbox:8080
```
