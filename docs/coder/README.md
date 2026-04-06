# Synesis Coder/Yarn Blueprint

This directory defines the production design for Synesis Coder/Yarn as a capability-first platform.

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
- [`GIT_FIRST_POLICY_MODES.md`](./GIT_FIRST_POLICY_MODES.md)
- [`implementation-phases.md`](./implementation-phases.md)
- [`migration-map-from-milestones.md`](./migration-map-from-milestones.md)

## Existing References

- [`/Users/bymiller/src/synesis/docs/wip/INTENTIONAL_RECALL_COMPOSITION_M11.md`](/Users/bymiller/src/synesis/docs/wip/INTENTIONAL_RECALL_COMPOSITION_M11.md)
- [`/Users/bymiller/src/synesis/docs/WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md`](/Users/bymiller/src/synesis/docs/WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md)
- [`/Users/bymiller/src/synesis/docs/VALIDATION_NORMALIZATION_M1.md`](/Users/bymiller/src/synesis/docs/VALIDATION_NORMALIZATION_M1.md)
- [`/Users/bymiller/src/synesis/docs/TOOL_RESULT_REDUCTION_M2.md`](/Users/bymiller/src/synesis/docs/TOOL_RESULT_REDUCTION_M2.md)
- [`/Users/bymiller/src/synesis/docs/DETERMINISTIC_POLICY_ENGINE_M4.md`](/Users/bymiller/src/synesis/docs/DETERMINISTIC_POLICY_ENGINE_M4.md)
- [`/Users/bymiller/src/synesis/docs/PHASE_MODEL_ORCHESTRATOR_M5.md`](/Users/bymiller/src/synesis/docs/PHASE_MODEL_ORCHESTRATOR_M5.md)
- [`/Users/bymiller/src/synesis/docs/CONTEXT_OPTIMIZATION_M10.md`](/Users/bymiller/src/synesis/docs/CONTEXT_OPTIMIZATION_M10.md)
- [`/Users/bymiller/src/synesis/docs/SAFETY_HARDENING_M11.md`](/Users/bymiller/src/synesis/docs/SAFETY_HARDENING_M11.md)
