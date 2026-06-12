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

## Coder Design Goals

Coder should behave like a senior engineering assistant: finish scoped work
end-to-end when the environment allows it, verify meaningful changes before
claiming completion, repair avoidable failures, and report concrete blockers
when it cannot proceed. The runtime should make that behavior the easiest path
through deterministic interfaces, durable state, bounded verification loops, and
clear telemetry.

Design constraints:

- Prefer small, reviewable patches without lowering the quality bar.
- Treat "done" as request satisfied plus relevant verification, not just a
  successful model response.
- Prefer deterministic harness rules and structured diagnostics over larger
  prompts when behavior can be made explicit.
- Keep retries, cleanup, and critic passes bounded so quality enforcement does
  not become an infinite loop.
- Use telemetry and eval outcomes to promote, adjust, or roll back behavior.

Research anchors are collected in
[`AWESOME_PAPERS.MD`](../AWESOME_PAPERS.MD#agent-coding-and-interfaces-selected-non-arxiv).

## Document Map

- [`constraint-governance.md`](./constraint-governance.md)
- [`context-and-recall-architecture.md`](./context-and-recall-architecture.md)
- [`model-routing-and-adaptive-complexity.md`](./model-routing-and-adaptive-complexity.md)
- [`language-and-toolchain-intelligence.md`](./language-and-toolchain-intelligence.md)
- [`rag-schema-and-knowledge-sources.md`](./rag-schema-and-knowledge-sources.md)
- [`admin-control-plane-and-constitutions.md`](./admin-control-plane-and-constitutions.md)
- [`observability-verification-and-evals.md`](./observability-verification-and-evals.md)
- [`GOVERNOR_HARNESS.md`](./GOVERNOR_HARNESS.md)
- [`GOVERNOR_PAUSE_ENVELOPE.md`](./GOVERNOR_PAUSE_ENVELOPE.md)
- [`../clients/PI.md`](../clients/PI.md) — Pi harness setup with OIDC against the coder frontend
- [`qwen-stability-feedback-loop.md`](./qwen-stability-feedback-loop.md)
- [`GIT_FIRST_POLICY_MODES.md`](./GIT_FIRST_POLICY_MODES.md)
- [`../../base/yarn-ts/src/reduction/README.md`](../../base/yarn-ts/src/reduction/README.md)

## Runtime & operations (moved here from `docs/` root)

- [YARN_TS_SAWTOOTH_ARCHITECTURE.md](./YARN_TS_SAWTOOTH_ARCHITECTURE.md) — session / context architecture
- [YARN_TS_CONTEXT_TRUST.md](./YARN_TS_CONTEXT_TRUST.md) — trust envelopes for coder
- [YARN_OPENAI_COMPAT_AND_VALUE_ADD.md](./YARN_OPENAI_COMPAT_AND_VALUE_ADD.md) — OpenAI compatibility (retired-path notice + pointer to `base/yarn-ts`)
- [YARN_TOOL_COLLAPSE.md](./YARN_TOOL_COLLAPSE.md) — tool-call batching
- [TOKEN_ECONOMICS_HARDENING.md](./TOKEN_ECONOMICS_HARDENING.md) — provider-cache economics, telemetry, and validation
- [../CODER_AGENT_ITERATION_PLAYBOOK.md](../CODER_AGENT_ITERATION_PLAYBOOK.md) — coder status, snapshots, tracing, and Admin metric reference
- [YARN_SESSION_DEBUGGING.md](./YARN_SESSION_DEBUGGING.md) — troubleshooting
- [YARN_COST_ANALYSIS.md](./YARN_COST_ANALYSIS.md) — cost notes
- [YARN_PERFORMANCE_REVIEW_FINDINGS.md](./YARN_PERFORMANCE_REVIEW_FINDINGS.md) — performance review
- [../../base/yarn-ts/README.md#markdown-response-style](../../base/yarn-ts/README.md#markdown-response-style) — markdown response style modes and operator override

## Consolidated Feature Areas

Maintained feature references:

- Validation normalization and reducers: [`base/yarn-ts/src/reduction/README.md`](../../base/yarn-ts/src/reduction/README.md)
- Working frame, project manifest, recall, and structural index: [`context-and-recall-architecture.md`](./context-and-recall-architecture.md)
- Model routing and phase policy: [`model-routing-and-adaptive-complexity.md`](./model-routing-and-adaptive-complexity.md)
- Governor, pause envelope, and safety: [`GOVERNOR_HARNESS.md`](./GOVERNOR_HARNESS.md), [`GOVERNOR_PAUSE_ENVELOPE.md`](./GOVERNOR_PAUSE_ENVELOPE.md)
- Verification and evals: [`observability-verification-and-evals.md`](./observability-verification-and-evals.md), [`../development/TESTING.md#97-harness-trust-kpi-lane-coder-reliability`](../development/TESTING.md#97-harness-trust-kpi-lane-coder-reliability)
- Agent-facing retrieval packs: [`rag-schema-and-knowledge-sources.md`](./rag-schema-and-knowledge-sources.md), [`../SYNPACKS.md`](../SYNPACKS.md)
