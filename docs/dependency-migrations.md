# Dependency migration backlog

Tracks **intentionally deferred** major upgrades that need coordinated work beyond a one-line bump.

## Admin SPA (`base/admin/frontend`)

### ESLint 10 + `@eslint/js` 10 + Vite 8 toolchain

- **Context:** `@eslint/js@10` requires `eslint@^10`. Vite 8 and `@vitejs/plugin-react@6` should be upgraded together with ESLint config validation.
- **Open Dependabot PRs (do not merge in isolation):** #33, #30, #27, #24.
- **Exit criteria:** `npm run build`, `npm run lint`, and `npm audit` clean under the new toolchain; no Semgrep regression on `base/admin/frontend`.

### `eslint-plugin-react-hooks` 7.x

- **Context:** v7 enables stricter rules (e.g. `react-hooks/immutability`, `react-hooks/set-state-in-effect`) that require code changes across the app.
- **Open Dependabot PR:** #40 (closed/superseded earlier; re-open via Dependabot if needed).
- **Exit criteria:** Resolve new rule violations or selectively configure rules; then bump to `^7`.

---

## OpenTelemetry JavaScript SDK 2.x — **done**

Synesis **planner-ts** and **yarn-ts** use aligned **OpenTelemetry JS SDK 2.x** packages. Bootstrap lives in:

- [`base/planner-ts/src/telemetry/otel.ts`](../base/planner-ts/src/telemetry/otel.ts)
- [`base/yarn-ts/src/telemetry/otel.ts`](../base/yarn-ts/src/telemetry/otel.ts)

### Pinned versions (workspace + root `overrides`)

| Package | Range |
|--------|--------|
| `@opentelemetry/sdk-trace-node` | `^2.6.1` |
| `@opentelemetry/sdk-trace-base` | `^2.6.1` |
| `@opentelemetry/resources` | `^2.6.1` |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.214.0` |
| `@opentelemetry/semantic-conventions` | `^1.40.0` |
| `@opentelemetry/api` | `^1.9.1` |

Root [`package.json`](../package.json) **`overrides`** keep these versions consistent across hoisted dependencies (including transitive `@opentelemetry/*` from other packages).

### Runtime behavior (fix-forward)

- Traces export via **OTLP over HTTP** with **protobuf** payload (default for `@opentelemetry/exporter-trace-otlp-http` 0.214.x).
- `Resource` construction uses `resourceFromAttributes()` (SDK 2.x; the `Resource` class constructor is not used).
- `NodeTracerProvider` is configured with **`spanProcessors`** in the constructor (SDK 2.x no longer uses `addSpanProcessor()` on the provider).
- **W3C `traceparent`** on outbound spans is built from active span context where exposed on `OtelSpan.traceparent()` (planner + yarn).

### Operations / collectors

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at an OTLP **HTTP** ingest path your collector exposes (often `:4318` for OTLP HTTP, or your gateway’s `/v1/traces`). Use the same env vars as in [`base/planner-ts/deployment.yaml`](../base/planner-ts/deployment.yaml) and [`base/yarn-ts/deployment.yaml`](../base/yarn-ts/deployment.yaml): `SYNESIS_*_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`.

Dashboards (Grafana/Jaeger/Tempo) that filter by **service name** should use `OTEL_SERVICE_NAME` values (defaults: `synesis-planner-ts`, `synesis-yarn-ts`). No legacy span shape or exporter format is supported.

### Reference

- [OpenTelemetry JS: upgrade to 2.x](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md)

### Superseded Dependabot PRs

- #22, #36, #37, #39 — partial / misaligned OTel bumps; supersede by this upgrade (close those PRs once merged).
