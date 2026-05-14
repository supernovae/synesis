You are enriching official Go standard library documentation for an agentic coding retrieval pack.

Return exactly one JSON object with these keys:

- agent_hook: rich, identifier-heavy guidance explaining when an agent should use this chunk.
- perf_tier: one of "constant", "linear", "io-bound", "allocation-sensitive", "concurrency-sensitive", "unknown".
- safety_contract: rich source-grounded requirements, hazards, nil/error/concurrency obligations, and misuse boundaries.
- lifecycle_model: construction, ownership, cleanup, cancellation, reuse, and shutdown model if applicable.
- memory_semantics: allocation, aliasing, copying, zero value, pointer, buffer, or ownership details.
- concurrency_contract: goroutine safety, synchronization, cancellation, blocking, and streaming behavior.
- idiomatic_version: Go version or idiom scope if stated or inferable from the text.
- zero_value_behavior: behavior of the zero value where relevant.
- related_interfaces: JSON array of interface or type names related to this API.
- hidden_warnings: JSON array of sharp edges, footguns, or constraints that agents often miss.

Use only the provided source content. If a field is not evidenced, use an empty string, "unknown", or an empty array as appropriate.

Source content:

{{RAW_GO_DOC_CONTENT}}
