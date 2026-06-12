# Engineering & development documentation

These pages support **contributors and operators** who work from the repository: CI, tests, migrations, and maintained engineering runbooks. They are **not** the primary path for end-user “connect my IDE” setup — use [`docs/user/`](../user/README.md) and [`docs/clients/`](../clients/CLIENTS.md) for that.

## Testing & CI (start here)

**[TESTING.md](./TESTING.md)** is the **inventory** of what runs on every PR vs cluster-only vs manual-only: GitHub Actions matrix, planner-ts / yarn-ts / admin / Python gates, optional probes, and local commands.

From the same directory:

| Document | Purpose |
|----------|---------|
| [DEVELOPMENT_CHECKS.md](./DEVELOPMENT_CHECKS.md) | Post-deploy checks, Makefile targets, live intent validation |
| [CI_GITHUB_VALIDATION.md](./CI_GITHUB_VALIDATION.md) | GitHub Actions variables/secrets for evaluation jobs |
| [TESTING.md#97-harness-trust-kpi-lane-coder-reliability](./TESTING.md#97-harness-trust-kpi-lane-coder-reliability) | Governor trust KPIs, canaries, scorecards, and rollout hold policy |

## Tooling & trackers

| Document | Purpose |
|----------|---------|
| [UV_TOOLING.md](./UV_TOOLING.md) | Python lockfiles and `uv` usage |
| [PLANNER_TS_SCALABILITY_RESEARCH.md](./PLANNER_TS_SCALABILITY_RESEARCH.md) | Scaling research notes |

Dependency and chat capability history is tracked through the current testing,
security, and product hubs: [TESTING.md](./TESTING.md),
[../SECURITY.md](../SECURITY.md), and [../chat/README.md](../chat/README.md).

## Feature documentation

Milestone-era design notes have been consolidated into the current feature docs below:

| Area | Canonical docs |
|------|----------------|
| Validation normalization and reducers | [`base/yarn-ts/src/reduction/README.md`](../../base/yarn-ts/src/reduction/README.md) |
| Context, manifest, recall, and structural index | [`docs/coder/context-and-recall-architecture.md`](../coder/context-and-recall-architecture.md) |
| Model routing and phase policy | [`docs/coder/model-routing-and-adaptive-complexity.md`](../coder/model-routing-and-adaptive-complexity.md) |
| Governor and safety controls | [`docs/coder/GOVERNOR_HARNESS.md`](../coder/GOVERNOR_HARNESS.md), [`docs/coder/GOVERNOR_PAUSE_ENVELOPE.md`](../coder/GOVERNOR_PAUSE_ENVELOPE.md) |
| Verification and evals | [`docs/coder/observability-verification-and-evals.md`](../coder/observability-verification-and-evals.md), [`TESTING.md`](./TESTING.md) |

## Product-aligned doc hubs

- **Chat:** [../chat/README.md](../chat/README.md)
- **Coder:** [../coder/README.md](../coder/README.md)
- **Platform index:** [../README.md](../README.md)
