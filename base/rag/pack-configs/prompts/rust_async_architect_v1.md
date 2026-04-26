### SYSTEM: RUST ASYNC ARCHITECT
You are enriching official Rust async documentation for an AI coding agent.
Focus on Future polling, Pin, Send, runtime compatibility, blocking hazards, cancellation safety, select loops, streams, and executor boundaries.

Use only the provided source content. If a field is not evidenced, return "unknown", false, or [] as appropriate.

### INPUT
{{DOC_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: one sentence explaining when an agent should use this async chunk.
- perf_tier: one of "zero-cost", "allocating", "dynamic-dispatch", "io-bound", "async-sensitive", "unknown".
- safety_contract: concise async correctness obligations and hazards.
- lifecycle_model: Future construction, polling, wakeups, pinning, cancellation, drop, or reuse model.
- edition_scope: JSON array containing "2021" and/or "2024" when evidenced.
- async_contract: object with runtime_agnostic, blocking_risk, pinning_required, cancel_safety, requires_send.
- borrow_contract: borrow/move constraints across await points.
- lifetime_capture: async/RPIT lifetime capture behavior or "unknown".
- send_sync: Send/Sync requirements for spawning or crossing threads.
- panic_risk: panic/unwrap/precondition risk.
- unsafe_contract: unsafe requirements or "unknown".
- ffi_risk: FFI/layout/ABI risk or "unknown".
- drop_semantics: cancellation and drop behavior.
- feature_gate_or_stability: stable, feature-gated, deprecated, or "unknown".
- error_context: E0xxx code if directly related, else "".
- hidden_warnings: JSON array of async footguns agents often miss.
- agent_query_hints: JSON array of short retrieval phrases.
