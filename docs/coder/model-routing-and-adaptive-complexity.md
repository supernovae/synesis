# Model Routing and Adaptive Complexity

## Objective

Route tasks through deterministic paths and model tiers (`synesis-pulse`, `synesis-core`, `synesis-horizon`) based on evidence, risk, and ambiguity.

## Runtime Modes

- **Explore:** discovery and option generation.
- **Planning:** convert exploration into plans, checkpoints, and decisions.
- **Implementation:** execute constrained steps and iterate.
- **Validation:** optimize for deterministic checks and closure.

## Decision Policy Matrix

Use the following path rules:

- **Deterministic Answer Path**
  - Preconditions: high-confidence evidence and deterministic/templated fix class.
  - Model use: optional constrained confirmation.
  - Output: actionable fix with explicit evidence references.

- **Constrained Prompt Path**
  - Preconditions: partial evidence or moderate uncertainty.
  - Model use: structured prompt with known/unknown fields and constraints.
  - Output: candidate implementation with validation plan.

- **Inference-First Path**
  - Preconditions: novelty, architecture tradeoffs, weak evidence.
  - Model use: broader synthesis, stronger retrieval, larger budget.
  - Output: alternatives, decision rationale, and verification strategy.

- **Abstain Path**
  - Preconditions: insufficient evidence and high potential downside.
  - Model use: ask targeted questions or require additional checks.
  - Output: explicit uncertainty plus next evidence actions.

## Escalation Rules

- Start with `synesis-pulse` for bounded/validation work.
- Use `synesis-core` as default balanced tier.
- Escalate to `synesis-horizon` for high risk, complex planning, or repeated failed verification.

## Tool-Layer Compatibility

Policy behavior must remain consistent across IDE, CLI, MCP, and OpenWebUI clients.

- Client adapters normalize request/response contracts before policy evaluation.
- Planning mode promotes exploration artifacts to structured plan outputs.
- Local tool capabilities can vary, but policy semantics must remain stable.
