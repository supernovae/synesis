# Chat (planner-ts)

**Chat** is the Synesis product surface for **knowledge-backed conversation**: intent classification, planning, router-governed retrieval (RAG + web), writing, critic review, and streaming responses over an **OpenAI-compatible** HTTP API.

The implementation is **`base/planner-ts/`** (TypeScript, Fastify, LangGraph). The `base/planner/` tree holds **YAML ontology and taxonomy assets** consumed by planner-ts — not a separate Python chat runtime.

## Start here

| Topic | Document |
|-------|----------|
| End-to-end graph, routing, retries, clarification | [WORKFLOW_PLANNER.MD](./WORKFLOW_PLANNER.MD) |
| Open WebUI integration | [OPENWEBUI.md](./OPENWEBUI.md) · [Phases / SSE](OPENWEBUI_PHASES.md) · [Admin guide](OPENWEBUI_ADMIN_GUIDE.md) |
| OpenAI wire compatibility & probes | [PLANNER_OPENAI_COMPATIBILITY.md](./PLANNER_OPENAI_COMPATIBILITY.md) · [OPENAI_COMPAT_PROBING.md](./OPENAI_COMPAT_PROBING.md) |
| Prefix / KV cache & LiteLLM | [PLANNER_PREFIX_KV_CACHE.md](./PLANNER_PREFIX_KV_CACHE.md) |
| Session & graph memory (OOM, checkpoints) | [PLANNER_MEMORY.md](./PLANNER_MEMORY.md) · [PLANNER_MEMORY_LIFECYCLE.md](./PLANNER_MEMORY_LIFECYCLE.md) |
| Conversation turns (L1/L2) | [CONVERSATION_MEMORY.md](./CONVERSATION_MEMORY.md) |
| Scaling checklist | [planner-scaling.md](./planner-scaling.md) |
| Injection scoring (design) | [PLANNER_PROMPT_INJECTION_SCORER.md](./PLANNER_PROMPT_INJECTION_SCORER.md) |

## Related (outside this folder)

- **User guide (operators & power users):** [../user/USERGUIDE.md](../user/USERGUIDE.md)
- **Feature / parity tracker (engineering):** [../development/chat-planner-ts-feature-tracker.md](../development/chat-planner-ts-feature-tracker.md)
- **Platform RAG:** [../RAG.md](../RAG.md) · [../INDEXERS.md](../INDEXERS.md)
- **Security:** [../SECURITY.md](../SECURITY.md)
