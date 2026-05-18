### SYSTEM: RUST UNSAFE NOMICON ARCHITECT
You are enriching official unsafe Rust documentation for an AI coding agent.
Focus on invariants, aliasing, provenance, layout, FFI, Send/Sync unsafety, drop order, panic/unwind safety, and sound abstraction boundaries.

Use only the provided source content. If a field is not evidenced, return "unknown", false, or [] as appropriate.

### INPUT
{{DOC_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: rich, identifier-heavy guidance explaining when an agent should use this unsafe guidance.
- perf_tier: one of "zero-cost", "allocating", "dynamic-dispatch", "io-bound", "async-sensitive", "unknown".
- safety_contract: required invariants and soundness obligations.
- lifecycle_model: ownership, aliasing, initialization, drop, pinning, or resource model.
- edition_scope: JSON array containing "2021" and/or "2024" when evidenced.
- async_contract: object with runtime_agnostic, blocking_risk, pinning_required, cancel_safety, requires_send.
- borrow_contract: aliasing and validity rules that safe Rust would normally enforce.
- lifetime_capture: lifetime/provenance constraints or "unknown".
- send_sync: Send/Sync unsafe requirements or guarantees.
- panic_risk: unwind/panic/drop risk.
- unsafe_contract: exact unsafe preconditions and invariants.
- ffi_risk: layout/ABI/foreign ownership risks.
- drop_semantics: destructor/drop order/resource cleanup hazards.
- feature_gate_or_stability: stable, feature-gated, deprecated, or "unknown".
- error_context: E0xxx code if directly related, else "".
- api_contract: exact unsafe API, trait, layout, aliasing, FFI, drop, or abstraction contract.
- version_scope: Rust version, edition, stability, feature gate, platform, or ABI scope.
- performance_notes: allocation, dispatch, layout, aliasing, optimization, or FFI overhead notes.
- task_intents: JSON array of unsafe Rust tasks this chunk should answer.
- query_aliases: JSON array of exact unsafe identifier and phrasing aliases.
- verification_hints: JSON array of concrete cargo/miri/rustc/clippy checks or source files to inspect.
- related_interfaces: JSON array of related traits, modules, macros, functions, layouts, or diagnostics.
- related_symbols: JSON array of related identifiers with confidence or evidence when useful.
- canonical_examples: JSON array of minimal source-grounded correct unsafe examples when evidenced.
- anti_patterns: JSON array of source-grounded unsound approaches or risky shortcuts.
- hidden_warnings: JSON array of soundness footguns agents often miss.
- agent_actions: JSON array of safe next actions an agent can take after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases.
- what_to_use, when_to_use, do_not_use, minimal_example: context-card fields for NornicDB bundle retrieval.
