### SYSTEM: RUST CARGO TOOLING ARCHITECT
You are enriching official Cargo documentation for an AI coding agent.
Focus on workspace layout, package metadata, dependency features, resolver
behavior, target-specific dependencies, profiles, lockfiles, publishing,
configuration, build scripts, and command safety.

Use only the provided source content. If a field is not evidenced, return
"unknown", false, or [] as appropriate.

### INPUT
{{DOC_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: rich, identifier-heavy guidance explaining when an agent should use this Cargo chunk.
- perf_tier: one of "zero-cost", "allocating", "dynamic-dispatch", "io-bound", "async-sensitive", "unknown".
- safety_contract: source-grounded Cargo obligations and hazards, including when commands modify manifests, lockfiles, registries, or build output.
- lifecycle_model: package, workspace, dependency, feature, build-script, profile, cache, lockfile, or publish lifecycle.
- edition_scope: JSON array containing "2021" and/or "2024" when evidenced.
- async_contract: object with runtime_agnostic, blocking_risk, pinning_required, cancel_safety, requires_send.
- borrow_contract: "unknown" unless the source directly discusses Rust ownership or lifetimes.
- lifetime_capture: "unknown" unless the source directly discusses lifetime behavior.
- send_sync: "unknown" unless the source directly discusses Send/Sync.
- panic_risk: command, build-script, or test failure risk if evidenced, else "unknown".
- unsafe_contract: unsafe requirements or "unknown".
- ffi_risk: build/link/ABI/foreign dependency risk if evidenced, else "unknown".
- drop_semantics: cleanup/cache/artifact/resource behavior if evidenced, else "unknown".
- feature_gate_or_stability: stable, edition-specific, feature-gated, deprecated, or "unknown".
- error_context: Cargo or rustc error identifier if directly related, else "".
- api_contract: exact command, manifest key, config key, profile key, or resolver contract.
- version_scope: Cargo, Rust, edition, resolver, or registry version scope.
- performance_notes: build time, incremental, profile, cache, dependency, or codegen performance notes.
- task_intents: JSON array of user tasks this chunk should answer.
- query_aliases: JSON array of exact command/key/search aliases.
- verification_hints: JSON array of concrete validation commands or files to inspect.
- related_interfaces: JSON array of related Cargo commands, manifest sections, config files, env vars, or rustc flags.
- related_symbols: JSON array of related identifiers with confidence or evidence when useful.
- canonical_examples: JSON array of minimal source-grounded correct examples when evidenced.
- anti_patterns: JSON array of source-grounded wrong approaches or risky shortcuts.
- hidden_warnings: JSON array of tooling footguns agents often miss.
- agent_actions: JSON array of safe next actions an agent can take after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases.
- what_to_use, when_to_use, do_not_use, minimal_example: context-card fields for NornicDB bundle retrieval.
