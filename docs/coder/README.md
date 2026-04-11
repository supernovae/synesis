# Synesis **Coder** (yarn-ts) — design hub

**Coder** is the Synesis product surface for **IDE and agent coding**: OpenAI- and Anthropic-compatible APIs, tool calling, session intelligence, and governance hooks. The supported implementation is **`base/yarn-ts/`** (TypeScript).

This directory collects **capability and architecture** notes for coder. For “how do I connect Claude Code / Cursor?” see **[`docs/clients/CLIENTS.md`](../clients/CLIENTS.md)** and **[`docs/clients/CLAUDECODE.md`](../clients/CLAUDECODE.md)**.

The intent is to keep model reasoning in the loop while reducing avoidable ambiguity through deterministic evidence, stronger retrieval, and organization-level governance. These are building blocks, not mandatory gates.

## Core Principles

- **Capability-first adoption:** teams can start with minimal policy and gradually enable stronger governance.
- **Guiding constraints by default:** constraints shape better outcomes without over-constraining exploration.
- **Hard constraints only where needed:** safety, compliance, and runtime integrity boundaries remain enforceable.
- **Evidence before inference:** reduce inference when high-confidence evidence exists.
- **Fail-safe behavior:** when confidence is low, abstain, ask for more evidence, or escalate model tier.
- **Top-down plus bottom-up:** centralized governance complements local `AGENTS.md` and rule files.

## Document Map

- [`constraint-governance.md`](./constraint-governance.md)
- [`context-and-recall-architecture.md`](./context-and-recall-architecture.md)
- [`model-routing-and-adaptive-complexity.md`](./model-routing-and-adaptive-complexity.md)
- [`language-and-toolchain-intelligence.md`](./language-and-toolchain-intelligence.md)
- [`rag-schema-and-knowledge-sources.md`](./rag-schema-and-knowledge-sources.md)
- [`corpus-ingestion-and-annotation.md`](./corpus-ingestion-and-annotation.md)
- [`admin-control-plane-and-constitutions.md`](./admin-control-plane-and-constitutions.md)
- [`safety-reliability-and-fail-safe.md`](./safety-reliability-and-fail-safe.md)
- [`observability-verification-and-evals.md`](./observability-verification-and-evals.md)
- [`qwen-stability-feedback-loop.md`](./qwen-stability-feedback-loop.md)
- [`GIT_FIRST_POLICY_MODES.md`](./GIT_FIRST_POLICY_MODES.md)
- [`implementation-phases.md`](./implementation-phases.md)
- [`migration-map-from-milestones.md`](./migration-map-from-milestones.md)

## Runtime & operations (moved here from `docs/` root)

- [YARN_TS_SAWTOOTH_ARCHITECTURE.md](./YARN_TS_SAWTOOTH_ARCHITECTURE.md) — session / context architecture
- [YARN_TS_CONTEXT_TRUST.md](./YARN_TS_CONTEXT_TRUST.md) — trust envelopes for coder
- [YARN_OPENAI_COMPAT_AND_VALUE_ADD.md](./YARN_OPENAI_COMPAT_AND_VALUE_ADD.md) — OpenAI compatibility (retired-path notice + pointer to `base/yarn-ts`)
- [YARN_TOOL_COLLAPSE.md](./YARN_TOOL_COLLAPSE.md) — tool-call batching
- [YARN_SESSION_DEBUGGING.md](./YARN_SESSION_DEBUGGING.md) — troubleshooting
- [YARN_COST_ANALYSIS.md](./YARN_COST_ANALYSIS.md) — cost notes
- [YARN_PERFORMANCE_REVIEW_FINDINGS.md](./YARN_PERFORMANCE_REVIEW_FINDINGS.md) — performance review

**Redirects at `docs/` root:** [YARN_RUNTIME.md](../YARN_RUNTIME.md) (stub) · [YARN_CONTEXT_TRUST.md](../YARN_CONTEXT_TRUST.md) (stub)

## Milestone program (M1–M11, engineering archive)

Canonical copies live under **[`docs/development/`](../development/README.md#milestone-program-m1m11)**. Quick links:

- [WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md](../development/WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md)
- [VALIDATION_NORMALIZATION_M1.md](../development/VALIDATION_NORMALIZATION_M1.md)
- [TOOL_RESULT_REDUCTION_M2.md](../development/TOOL_RESULT_REDUCTION_M2.md)
- [DETERMINISTIC_POLICY_ENGINE_M4.md](../development/DETERMINISTIC_POLICY_ENGINE_M4.md)
- [PHASE_MODEL_ORCHESTRATOR_M5.md](../development/PHASE_MODEL_ORCHESTRATOR_M5.md)
- [SESSION_INTELLIGENCE_DASHBOARD_M6.md](../development/SESSION_INTELLIGENCE_DASHBOARD_M6.md)
- [CONTEXT_OPTIMIZATION_M10.md](../development/CONTEXT_OPTIMIZATION_M10.md)
- [SAFETY_HARDENING_M11.md](../development/SAFETY_HARDENING_M11.md)
