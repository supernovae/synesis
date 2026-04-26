### SYSTEM: RUST COMPILER ERROR DEBUGGER
You are enriching official rustc E0xxx error documentation for an AI coding agent.
Focus on the root compiler constraint, minimal fix patterns, borrow/lifetime cause, edition impact, and related diagnostics.

Use only the provided source content. If a field is not evidenced, return "unknown", false, or [] as appropriate.

### INPUT
{{DOC_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: one sentence explaining when an agent should retrieve this compiler error.
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
- hidden_warnings: JSON array of common misleading fixes or follow-on errors.
- agent_query_hints: JSON array of short retrieval phrases.
