# Engineering & development documentation

These pages support **contributors and operators** who work from the repository: CI, tests, migrations, milestone design history, and long-running trackers. They are **not** the primary path for end-user “connect my IDE” setup — use [`docs/user/`](../user/README.md) and [`docs/clients/`](../clients/CLIENTS.md) for that.

## Testing & CI (start here)

**[TESTING.md](./TESTING.md)** is the **inventory** of what runs on every PR vs cluster-only vs manual-only: GitHub Actions matrix, planner-ts / yarn-ts / admin / Python gates, optional probes, and local commands.

From the same directory:

| Document | Purpose |
|----------|---------|
| [DEVELOPMENT_CHECKS.md](./DEVELOPMENT_CHECKS.md) | Post-deploy checks, Makefile targets, live intent validation |
| [CI_GITHUB_VALIDATION.md](./CI_GITHUB_VALIDATION.md) | GitHub Actions variables/secrets for evaluation jobs |
| [LIVE_VERIFICATION_M9.md](./LIVE_VERIFICATION_M9.md) | Live verification runbook (deployed Yarn / planner checks) |
| [HARNESS_TRUST_HARDENING.md](./HARNESS_TRUST_HARDENING.md) | Strategy + operator runbook for trust KPIs, gates, canaries, scorecards, and rollback |

## Tooling & trackers

| Document | Purpose |
|----------|---------|
| [UV_TOOLING.md](./UV_TOOLING.md) | Python lockfiles and `uv` usage |
| [dependency-migrations.md](./dependency-migrations.md) | Dependency upgrade notes |
| [chat-planner-ts-feature-tracker.md](./chat-planner-ts-feature-tracker.md) | Chat (planner-ts) capability tracker (historical rows may cite pre-TS behavior) |
| [PLANNER_TS_SCALABILITY_RESEARCH.md](./PLANNER_TS_SCALABILITY_RESEARCH.md) | Scaling research notes |

## Milestone program (M1–M11)

Structured milestone write-ups (historical **engineering** references; product hubs remain [`docs/chat/`](../chat/README.md) and [`docs/coder/`](../coder/README.md)):

| Milestone | Document |
|-----------|----------|
| M1 | [VALIDATION_NORMALIZATION_M1.md](./VALIDATION_NORMALIZATION_M1.md) |
| M2 | [TOOL_RESULT_REDUCTION_M2.md](./TOOL_RESULT_REDUCTION_M2.md) |
| M3 | [WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md](./WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md) |
| M4 | [DETERMINISTIC_POLICY_ENGINE_M4.md](./DETERMINISTIC_POLICY_ENGINE_M4.md) |
| M5 | [PHASE_MODEL_ORCHESTRATOR_M5.md](./PHASE_MODEL_ORCHESTRATOR_M5.md) |
| M6 | [SESSION_INTELLIGENCE_DASHBOARD_M6.md](./SESSION_INTELLIGENCE_DASHBOARD_M6.md) |
| M7 | [CLIENT_ADAPTER_PACKS_M7.md](./CLIENT_ADAPTER_PACKS_M7.md) |
| M8 | [REDUCER_REGISTRY_M8.md](./REDUCER_REGISTRY_M8.md) |
| M9 | [LIVE_VERIFICATION_M9.md](./LIVE_VERIFICATION_M9.md) |
| M10 | [CONTEXT_OPTIMIZATION_M10.md](./CONTEXT_OPTIMIZATION_M10.md) |
| M11 | [SAFETY_HARDENING_M11.md](./SAFETY_HARDENING_M11.md) |

**Index:** [Migration map from milestones → features](../coder/migration-map-from-milestones.md) (`docs/coder/`).

## Product-aligned doc hubs

- **Chat:** [../chat/README.md](../chat/README.md)
- **Coder:** [../coder/README.md](../coder/README.md)
- **Platform index:** [../README.md](../README.md)
