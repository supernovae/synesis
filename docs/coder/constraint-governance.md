# Constraint Governance

## Purpose

Define how Synesis Coder/Yarn uses constraints to improve reliability and precision without reducing developer flexibility.

## Operating Posture

- Constraints are **guiding defaults**.
- Constraints become **hard checks** only for safety, compliance, and runtime integrity.
- Deterministic components must support abstention when confidence is insufficient.
- Local team conventions remain valid and are layered on top of platform governance.

## Capability Maturity Ladder

1. **Base Mode:** minimal policy, model-first reasoning.
2. **Guided Mode:** ambiguity framing and structured evidence.
3. **Governed Mode:** constitutions, org policy, stronger verification.
4. **Assured Mode:** strict controls for high-risk environments.

## Ambiguity Governance Contract

- **Known:** evidence-backed facts (compiler, linter, tests, runtime errors, policy metadata).
- **Unknown:** unresolved facts requiring retrieval or additional checks.
- **Know Better:** concrete actions that convert unknowns into knowns.

Required runtime behavior:

- Route high-confidence knowns to deterministic or constrained response paths.
- Route weak evidence to model inference with explicit uncertainty framing.
- Record transitions: `known -> unknown -> know_better -> resolved`.

## Governance Precedence

1. Safety/compliance hard constraints
2. **Filesystem sandbox** — project-root boundary, cross-project config isolation, system path blocking. See [`YARN_PATH_SANDBOX.md`](YARN_PATH_SANDBOX.md).
3. Active org/tenant constitutions
4. Team/project constitutions
5. Local tool rules (`AGENTS.md`, tool-local config, prompt guidance)
6. Session-specific user preferences

## Why Top-Down Plus Bottom-Up

- Top-down governance provides consistency, traceability, and cross-client reliability.
- Bottom-up rules provide local productivity and context specialization.
- Combined approach avoids both rule sprawl and over-centralized rigidity.
