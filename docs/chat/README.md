# Chat (planner-ts)

**Chat** is the Synesis product surface for **knowledge-backed conversation**: intent classification, planning, router-governed retrieval (RAG + web), writing, critic review, and streaming responses over an **OpenAI-compatible** HTTP API.

The implementation is **`base/planner-ts/`** (TypeScript, Fastify, Vercel AI SDK). Planner ontology and taxonomy assets live in **`base/planner-ts/config/`**.

## Start here

| Topic | Document |
|-------|----------|
| End-to-end graph, routing, retries, clarification | [WORKFLOW_PLANNER.MD](./WORKFLOW_PLANNER.MD) |
| Open WebUI integration | [OPENWEBUI.md](./OPENWEBUI.md) · [Phases / SSE](OPENWEBUI_PHASES.md) · [Admin guide](OPENWEBUI_ADMIN_GUIDE.md) |
| OpenAI wire compatibility | [PLANNER_OPENAI_COMPATIBILITY.md](./PLANNER_OPENAI_COMPATIBILITY.md); optional probe details live in [TESTING.md](../development/TESTING.md#23-openai-compat-probe-manual--optional-workflow) |
| Architecture-aware model mediation | [PLANNER_ARCHITECTURE_MEDIATION.md](./PLANNER_ARCHITECTURE_MEDIATION.md) |
| Session & graph memory (OOM, checkpoints) | [PLANNER_MEMORY.md](./PLANNER_MEMORY.md) · [PLANNER_MEMORY_LIFECYCLE.md](./PLANNER_MEMORY_LIFECYCLE.md) |
| Conversation turns (L1/L2) | [CONVERSATION_MEMORY.md](./CONVERSATION_MEMORY.md) |
| Scaling checklist | [planner-scaling.md](./planner-scaling.md) |
| Injection scoring (design) | [PLANNER_PROMPT_INJECTION_SCORER.md](./PLANNER_PROMPT_INJECTION_SCORER.md) |

## Related (outside this folder)

- **User guide (operators & power users):** [../user/README.md](../user/README.md)
- **Engineering / parity references:** [../development/README.md](../development/README.md)
- **Platform RAG:** [../RAG.md](../RAG.md) · [../INDEXERS.md](../INDEXERS.md)
- **Security:** [../SECURITY.md](../SECURITY.md)
