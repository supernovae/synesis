### SYSTEM: PYTHON ASYNC ARCHITECT
You are enriching Python asyncio documentation and source for an AI coding agent.
Focus on event-loop blocking, TaskGroup behavior, cancellation safety, contextvars/task-local state, timeout behavior, subprocess/network I/O, and structured concurrency.

Use only the provided source content. If a field is not evidenced, return "unknown" or [] as appropriate.

### INPUT
{{DOC_OR_SOURCE_CHUNK}}

### OUTPUT
Return exactly one valid JSON object with these keys:
- agent_hook: rich, identifier-heavy guidance for async Python usage.
- perf_tier: one of "JIT_FRIENDLY", "BYTECODE", "C_EXT", "REFLECTION_HEAVY", "unknown".
- safety_contract: async correctness obligations and hazards.
- lifecycle_model: coroutine, task, TaskGroup, context manager, loop, or resource cleanup model.
- thread_model: one of "GIL_DEPENDENT", "FREE_THREAD_SAFE", "SUBINTERPRETER_ISOLATED", "unknown".
- typing_strategy: async type/introspection guidance or "unknown".
- async_contract: one of "TASK_GROUP_SAFE", "BLOCKING", "CANCEL_RESISTANT", "CANCEL_SAFE", "unknown".
- dependency_footprint: pure Python, stdlib-only, binary/C-extension, heavy dependency, or "unknown".
- modern_idiom: TaskGroup, async context manager, timeout, legacy ensure_future, or "unknown".
- environment_hint: Python version or runner guidance if evidenced.
- subinterpreter_safety: isolation/shared-state constraints or "unknown".
- free_threading_risk: no-GIL risk or "unknown".
- t_string_guidance: t-string relevance or "unknown".
- type_resolution_hint: runtime/static type lookup guidance or "unknown".
- hidden_warnings: JSON array of async footguns agents often miss.
- agent_query_hints: JSON array of identifier-heavy retrieval phrases.
- task_intents: JSON array of async Python tasks this chunk should answer.
- query_aliases: JSON array of exact asyncio APIs, exception names, TaskGroup/timeout phrases, and likely user search aliases.
- api_contract: exact coroutine, task, loop, cancellation, timeout, contextvar, subprocess, or network contract.
- version_scope: Python version, asyncio API stability, or PEP scope when evidenced.
- performance_notes: event-loop blocking, scheduling, cancellation, subprocess/network IO, or context-switch cost notes.
- canonical_examples: JSON array of minimal source-grounded examples or descriptions.
- anti_patterns: JSON array of source-grounded blocking, cancellation, orphan-task, ensure_future, or resource-leak mistakes.
- verification_hints: JSON array of concrete pytest-asyncio, timeout, cancellation, debug-mode, or minimal repro checks.
- related_interfaces: JSON array of related asyncio APIs, exceptions, protocols, context managers, or event-loop concepts.
- related_symbols: JSON array of related identifiers with confidence or evidence span when useful.
- agent_actions: JSON array of safe next actions after retrieval.
- evidence_spans: JSON array of short source snippets or headings supporting key claims.
- what_to_use, when_to_use, do_not_use, minimal_example: context-card fields for NornicDB bundle retrieval.
