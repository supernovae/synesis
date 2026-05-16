### SYSTEM: RUST COMPILER ERROR DEBUGGER
You are enriching official rustc E0xxx error documentation for an AI coding agent.
Focus on the root compiler constraint, minimal fix patterns, borrow/lifetime cause, edition impact, and related diagnostics.

Use only the provided source content. If a field is not evidenced, return "unknown", false, or [] as appropriate.

### INPUT
{{DOC_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: rich, identifier-heavy guidance explaining when an agent should retrieve this compiler error.
- perf_tier: "unknown" unless performance is directly involved.
- safety_contract: the compiler rule being enforced and the safe repair direction.
- lifecycle_model: ownership/borrow/lifetime/drop model implicated by the error.
- edition_scope: JSON array containing "2021" and/or "2024" when evidenced.
- async_contract: object with runtime_agnostic, blocking_risk, pinning_required, cancel_safety, requires_send.
- borrow_contract: the borrow-checker logic behind the diagnostic.
- lifetime_capture: temporary, elided, named, async, or RPIT lifetime rule involved.
- send_sync: Send/Sync requirement if relevant.
- panic_risk: panic risk if relevant, else "unknown".
- unsafe_contract: unsafe implication if relevant, else "unknown".
- ffi_risk: FFI/layout/ABI risk if relevant, else "unknown".
- drop_semantics: drop/destructor/resource effect if relevant.
- feature_gate_or_stability: stable, edition-specific, feature-gated, deprecated, or "unknown".
- error_context: the E0xxx code.
- api_contract: exact compiler rule, syntax, trait, lifetime, type, or borrow-checker contract.
- version_scope: Rust version, edition, stability, feature gate, or diagnostic scope.
- performance_notes: "unknown" unless the diagnostic directly affects allocation, dispatch, IO, async, or compile-time cost.
- task_intents: JSON array of compiler-error tasks this chunk should answer.
- query_aliases: JSON array including the E0xxx code, diagnostic wording, and likely user phrasing.
- verification_hints: JSON array of concrete cargo/rustc/clippy checks or minimal repro steps.
- related_interfaces: JSON array of related traits, modules, syntax forms, or diagnostics.
- related_symbols: JSON array of related identifiers with confidence or evidence when useful.
- canonical_examples: JSON array of minimal source-grounded corrected examples when evidenced.
- anti_patterns: JSON array of misleading fixes or code shapes that trigger/fail to fix the diagnostic.
- hidden_warnings: JSON array of common misleading fixes or follow-on errors.
- agent_actions: JSON array of safe next actions an agent can take after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases.
