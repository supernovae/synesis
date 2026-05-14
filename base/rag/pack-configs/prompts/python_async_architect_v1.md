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
