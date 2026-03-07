# Architecture Decision Records (ADR) — Template and Examples

## ADR Format

An ADR captures a single decision and its rationale. Each record follows this structure:

- **Title**: Short imperative statement (e.g., "Use Milvus for vector search")
- **Status**: Proposed | Accepted | Deprecated | Superseded
- **Context**: What forces are at play? What constraints exist?
- **Decision**: What was decided, stated clearly and unambiguously.
- **Consequences**: What becomes easier? What becomes harder? What risks remain?

## ADR-001: Use Milvus over Elasticsearch for Vector Search

**Status**: Accepted

**Context**: The system requires hybrid search (vector + keyword) over code, documentation, and architecture knowledge. Candidates evaluated: Elasticsearch (with dense_vector), Weaviate, Milvus, Pinecone.

**Decision**: We chose Milvus.

- **Why Milvus over Elasticsearch**: Milvus provides native IVF_FLAT and HNSW index types with configurable parameters. Elasticsearch's dense_vector support is bolted onto an inverted index engine — recall degrades at scale (>1M vectors), and there is no native hybrid retrieval without a two-phase query. Milvus has first-class support for filtered vector search.
- **Why not Weaviate**: Weaviate requires a dedicated cluster with its own resource management. Milvus Standalone runs as a single pod with S3-backed storage, which aligns with our cost constraint.
- **Why not Pinecone**: Vendor lock-in and SaaS-only model. Our security posture requires data to remain within the cluster boundary.

**Consequences**: We accept the operational burden of running Milvus Standalone (monitoring, backup). We gain sub-10ms p95 vector search latency for collections under 5M vectors. We lose Elasticsearch's mature full-text scoring (mitigated by BM25 re-ranking in the application layer).

## ADR-002: Route Small Tasks to 8B Models, Complex Tasks to 32B

**Status**: Accepted

**Context**: The system handles a wide range of task complexity — from "what is X?" to "design a production architecture." Running all requests through a 32B model is cost-prohibitive (GPU-hours) and latency-heavy (time-to-first-token >2s). Running all through 8B produces shallow responses for complex tasks.

**Decision**: Implement a tiered model routing strategy:

- **Router/Classifier (8B, Llama 3.1 8B Instruct)**: Classifies intent, determines routing. Runs on shared GPU with low latency (<200ms).
- **General/Worker (32B, Qwen3-32B FP8)**: Handles response generation for both simple and complex tasks. Token budget and prompt depth scale with classified task complexity.
- **Critic (8B, Llama 3.1 8B Instruct)**: Evaluates response quality post-generation. Lightweight evaluation does not require large model capacity.

**Why not a single 70B model**: A single L40S GPU cannot serve 70B at acceptable latency. Multi-GPU serving (tensor parallelism across 2-4 GPUs) multiplies cost 4x for marginal quality gains on the majority of tasks (80% are simple/medium).

**Why not 7B for everything**: 7B models cannot reliably follow complex multi-section outlines, maintain constraint adherence across long outputs, or produce architecturally coherent responses for "hard" tasks.

**Consequences**: We accept that 32B is not as capable as 70B+ for the most demanding tasks. We mitigate this with structured prompting (planner decomposition, deep-dive suffix, constraint injection). The 8B router adds ~150ms latency per request but saves 60-70% of GPU cost by avoiding unnecessary 32B invocations.

## ADR-003: Use LangGraph State Machine over Chain-of-Thought Agents

**Status**: Accepted

**Context**: The system needs conditional routing (code vs. knowledge), iterative refinement (critic loop), and stateful context accumulation (RAG + web search + plan). Options: LangChain sequential chains, LangGraph state machines, custom async orchestration.

**Decision**: We chose LangGraph with explicit state nodes.

- **Why not sequential chains**: Cannot express conditional branching (code path vs. knowledge path) or iterative loops (critic → revision) without awkward workarounds.
- **Why not custom orchestration**: Higher maintenance burden, no built-in streaming support, no checkpoint/resume capability.
- **Why LangGraph**: Explicit state machine with typed state (`GraphState`), conditional edges, and native streaming via `astream_events`. Each node (entry_classifier, supervisor, planner, worker, critic, respond) has a single responsibility and clear input/output contract.

**Consequences**: We accept LangGraph's learning curve and version coupling. We gain deterministic routing, easy addition of new nodes, and built-in state persistence for debugging.

## How to Use ADRs in Responses

When proposing an architecture, each major technology choice should be structured as an implicit ADR:

1. State the decision clearly
2. Name 1-2 rejected alternatives and why
3. State what becomes harder as a result
4. Quantify where possible (latency, cost, team effort)
