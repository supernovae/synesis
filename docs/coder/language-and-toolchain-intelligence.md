# Language and Toolchain Intelligence

## Scope

Initial top-10 coverage:

- TypeScript/JavaScript
- Python
- Go
- Terraform
- Java
- SQL
- C#
- Rust
- Bash
- YAML/Kubernetes

## Per-Language Support Contract

Each language pack should define:

- canonical diagnostics inputs (compiler, linter, formatter, tests, runtime)
- deterministic parse and normalization adapters
- recommended fix templates/recipes
- verification commands and pass criteria
- fallback behavior when parse confidence is low

## Deterministic-First Behavior

- Prefer deterministic error family resolution when a known pattern matches.
- Use constrained prompt generation when evidence is incomplete.
- Escalate model tier only when deterministic confidence or verification confidence is low.

## Conformance Matrix

Track each language pack by:

- parsing coverage
- reducer coverage
- verification reliability
- false certainty rate
- latency and token efficiency

Language packs are versioned to prevent silent regressions and support staged rollouts.
