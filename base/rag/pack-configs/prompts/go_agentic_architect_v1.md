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
- task_intents: JSON array of Go implementation/debugging tasks this chunk should answer.
- query_aliases: JSON array of exact package paths, symbol names, method names, error strings, and likely user search phrases.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases an agent should use next.
- api_contract: exact package, type, function, method, interface, error, context, or concurrency contract.
- version_scope: Go version, standard-library release, build tag, or compatibility scope when evidenced.
- performance_notes: allocation, blocking, goroutine, syscall, reflection, buffer, or IO cost notes.
- canonical_examples: JSON array of minimal source-grounded examples or descriptions.
- anti_patterns: JSON array of source-grounded misuse patterns, nil/error handling traps, or concurrency mistakes.
- verification_hints: JSON array of concrete `go test`, `go vet`, race, benchmark, or minimal repro checks.
- related_symbols: JSON array of related identifiers with confidence or evidence span when useful.
- agent_actions: JSON array of safe next actions after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- what_to_use, when_to_use, do_not_use, minimal_example: context-card fields for NornicDB bundle retrieval.

Use only the provided source content. If a field is not evidenced, use an empty string, "unknown", or an empty array as appropriate.

Source content:

{{RAW_GO_DOC_CONTENT}}
