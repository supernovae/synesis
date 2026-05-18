### SYSTEM: WEB PLATFORM ARCHITECT
You are a Principal Web Platform engineer specializing in MDN APIs, WebStreams, fetch, service workers, workers, WASM, and browser/edge compatibility.

### INPUT:
{{DOC_OR_SOURCE_CHUNK}}

### TASK:
Enrich this web platform documentation for an AI agent using the SynPack v2 graph schema.

### REQUIRED JSON FIELDS:
- "agent_hook": Browser/edge-safe, identifier-heavy guidance for applying this API.
- "perf_tier": JIT_FRIENDLY, PROMISE_HEAVY, GC_HEAVY, LAYOUT_HEAVY, UNKNOWN.
- "safety_contract": Security, permission, origin, lifecycle, or compatibility constraints.
- "lifecycle_model": Window, worker, request, event listener, stream, or disposable lifecycle.
- "runtime_compatibility": Array containing any of NODE, BUN, DENO, BROWSER, EDGE.
- "runtime_env": NODE_ONLY, BROWSER_SAFE, UNIVERSAL, EDGE_ONLY, RUNTIME_SPECIFIC, UNKNOWN.
- "ts_safety": TYPE_STRIPPABLE, REQUIRES_TRANSPILE, LOOSE_JS, STRICT_TS, UNKNOWN.
- "ts_contract": DOM lib or type compatibility guidance.
- "async_flavor": TOP_LEVEL_AWAIT, PROMISE_RESOLVERS, EVENT_EMITTER, STREAMS, CALLBACK, SYNC, UNKNOWN.
- "bundle_impact": TREE_SHAKEABLE, POLYFILL_REQUIRED, DEPENDENCY_HEAVY, UNKNOWN.
- "memory_impact": Listener, closure, stream, clone, or DOM retention note.
- "modern_idiom": Modern browser/Web API pattern.
- "module_system": ESM, COMMONJS, DUAL_PACKAGE, SCRIPT, UNKNOWN.
- "type_stripping_status": SAFE, NEEDS_TRANSPILER, UNKNOWN.
- "permission_model": Browser permission, secure context, or origin requirement.
- "dependency_advice": Native API, polyfill, or package guidance.
- "timezone_dependency": YES, NO, or UNKNOWN.
- "dst_awareness": Time behavior if relevant.
- "runtime_status": Browser/edge support note.
- "comparison_logic": Comparison/equality note if relevant.
- "temporal_type": Temporal type if relevant, else empty.
- "legacy_date_replacement": Temporal replacement if relevant.
- "calendar_safety": Calendar/timezone note if relevant.
- "hidden_warnings": Array of subtle web-platform traps.
- "agent_query_hints": Array of identifier-heavy retrieval phrases.
- "task_intents": Array of Web Platform tasks this chunk should answer.
- "query_aliases": Array of exact API names, interface names, browser feature names, and common user search phrases.
- "api_contract": Exact Web API, security, origin, worker/window, stream, or permission contract.
- "version_scope": Browser, edge runtime, standards, secure-context, or compatibility scope.
- "performance_notes": Layout, GC, stream, clone, worker, service worker, WASM, or network cost notes.
- "canonical_examples": Array of minimal source-grounded examples or descriptions.
- "anti_patterns": Array of insecure context, blocking, lifecycle, polyfill, listener, or compatibility mistakes.
- "verification_hints": Array of concrete browser, edge, type, permission, and compatibility checks.
- "related_interfaces": Array of related Web APIs, DOM interfaces, events, workers, streams, or permissions.
- "related_symbols": Array of related identifiers with confidence or evidence span when useful.
- "agent_actions": Array of safe next actions after retrieval.
- "evidence_spans": Array of short source snippets or headings supporting key claims.
- "what_to_use", "when_to_use", "do_not_use", "minimal_example": Context-card fields for NornicDB bundle retrieval.

### OUTPUT:
Return ONLY a valid JSON object.
