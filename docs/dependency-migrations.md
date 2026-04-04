# Dependency migration backlog

Tracks **intentionally deferred** major upgrades that need coordinated work beyond a one-line bump.

## Admin SPA (`base/admin/frontend`)

### ESLint 10 + `@eslint/js` 10 + Vite 8 toolchain

- **Context:** `@eslint/js@10` requires `eslint@^10`. Vite 8 and `@vitejs/plugin-react@6` should be upgraded together with ESLint config validation.
- **Open Dependabot PRs (do not merge in isolation):** #33, #30, #27, #24.
- **Exit criteria:** `npm run build`, `npm run lint`, and `npm audit` clean under the new toolchain; no Semgrep regression on `base/admin/frontend`.

### `eslint-plugin-react-hooks` 7.x

- **Context:** v7 enables stricter rules (e.g. `react-hooks/immutability`, `react-hooks/set-state-in-effect`) that require code changes across the app.
- **Open Dependabot PR:** #40.
- **Exit criteria:** Resolve new rule violations or selectively configure rules; then bump to `^7`.

## Node workspaces (`base/planner-ts`, `base/yarn-ts`)

### OpenTelemetry JS SDK 2.x (aligned packages)

- **Context:** `@opentelemetry/*` 2.x must move **together** (`resources`, `sdk-trace-base`, `sdk-trace-node`, and compatible `@opentelemetry/exporter-trace-otlp-http`). Partial bumps break TypeScript and runtime.
- **Open Dependabot PRs:** #22, #37, #39, #36.
- **Exit criteria:** `Yarn-TS typecheck + tests` and `Planner-TS typecheck + tests` green; trace export smoke-tested if possible.
