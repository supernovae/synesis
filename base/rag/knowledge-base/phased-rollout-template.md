# 90-Day Phased Rollout Template for AI Assistants

## Principles

1. **Ship something useful in 30 days or cancel.** If the team cannot see value in the first month, organizational patience will evaporate.
2. **Scope v1 ruthlessly.** Every feature not in v1 is a feature you can add in v2 with real usage data. Every feature in v1 is a feature you must maintain, debug, and support from day 1.
3. **Measure from day 1.** If you cannot measure whether the system is helping, you cannot justify its existence. Define success metrics before writing code.
4. **Budget drives scope, not the reverse.** If the GPU budget supports one L40S, design for one L40S. Do not propose an architecture that requires 4 GPUs and then note "budget may be a constraint."

## Phase 1: Days 1–30 — Core Loop (MVP)

### Goal
A working assistant that answers questions about internal documentation with measurable quality.

### Deliverables
- **RAG pipeline**: Document ingestion (markdown, code), embedding, vector store (Milvus Standalone), retrieval endpoint.
- **Single model serving**: One general-purpose model (Qwen3-32B FP8 or equivalent) serving via vLLM on a single L40S.
- **Basic API**: FastAPI endpoint accepting questions, returning markdown responses with source citations.
- **Simple UI**: Connect to an existing chat UI (Open WebUI, or equivalent). Do not build a custom UI in phase 1.
- **Quality baseline**: Run 50 representative questions, establish baseline scores for relevance, accuracy, and completeness. This becomes the benchmark for all future changes.

### Explicitly NOT in Phase 1
- Code generation or execution sandbox
- Multi-model routing (use one model for everything)
- Critic/evaluation loop
- Custom fine-tuning or LoRA adapters
- Advanced security (beyond basic auth)
- Multi-turn conversation memory

### Success Criteria
- 70%+ of test questions receive a relevant answer (human evaluation, binary relevant/not-relevant)
- Time-to-first-token <3 seconds for 90% of queries
- System uptime >95% during working hours

### Risk Mitigations
- **Model doesn't fit on available GPU**: Use FP8 or AWQ quantization. If still too large, drop to 14B model.
- **RAG retrieval returns irrelevant results**: This is normal in v1. Log all queries and retrieval results for analysis. Fix in Phase 2.
- **Team doesn't use it**: Put the UI link in the daily standup channel. Assign 3-5 "champion" users to provide weekly feedback.

## Phase 2: Days 31–60 — Quality and Routing

### Goal
Improve response quality based on Phase 1 feedback. Add routing for different task types.

### Deliverables
- **Intent classification**: Route questions to appropriate handling (simple Q&A, code explanation, architecture discussion). Use an 8B model as router.
- **Planner node**: For complex multi-section requests, decompose into structured plan before generating.
- **Critic loop**: Post-generation quality check with revision capability. Start with simple heuristics (response length, structure compliance), graduate to LLM-based critic.
- **Improved RAG**: Fix the top 10 retrieval failures from Phase 1 logs. Add domain-specific chunking. Implement hybrid search (vector + BM25).
- **Streaming**: Implement SSE streaming for real-time response delivery. Users should see content appearing within 1-2 seconds.

### Explicitly NOT in Phase 2
- Code execution sandbox
- Custom model training
- Multi-model serving for generation (still one general-purpose model)
- Production security hardening

### Success Criteria
- Test score improvement: 80%+ relevant answers (up from 70% baseline)
- Complex query quality: 6/10 average score on 10 architecture-style prompts (human evaluation)
- Routing accuracy: 90%+ of queries classified to correct intent

## Phase 3: Days 61–90 — Production Hardening

### Goal
Make the system reliable enough for daily team use with appropriate safeguards.

### Deliverables
- **Code generation path**: Separate handling for code tasks with language detection, sandbox execution, and test validation.
- **Web search integration**: For queries requiring current information, search the web and inject results into context.
- **Monitoring and alerting**: Track latency p50/p95/p99, error rates, GPU utilization, retrieval quality metrics. Alert on degradation.
- **Security**: API authentication, rate limiting, PII detection in inputs, audit logging.
- **Documentation**: System architecture doc, runbook for common failures, model upgrade procedure.

### Explicitly NOT in Phase 3
- Multi-tenant isolation (unless required by org policy)
- Custom model fine-tuning (defer to Q2 based on usage patterns)
- Advanced agentic capabilities (tool use, multi-step planning with execution)
- Self-service knowledge ingestion (admin manages RAG pipeline manually)

### Success Criteria
- System uptime >99% during working hours
- p95 latency <10 seconds for complex queries, <3 seconds for simple queries
- Zero security incidents (PII leaks, unauthorized access)
- Weekly active users >20% of engineering team (16+ of 80 engineers)

## Anti-Patterns in Rollout Planning

1. **"We need all features before launch"**: Launch with 20% of features for 80% of value. The remaining 80% of features provide 20% of value and 5x the maintenance burden.
2. **"We'll figure out the timeline as we go"**: Every phase needs explicit calendar dates, not "when it's ready." Deadlines force scope decisions.
3. **"Phase 1 is just infrastructure"**: If Phase 1 doesn't produce a user-visible product, it's not Phase 1 — it's "Phase 0" and it should take 1 week, not 1 month.
4. **"We need a custom UI"**: In the first 90 days, use an existing chat UI. Building a custom UI burns 30-40% of Phase 1 effort on something that contributes 0% to response quality.
5. **"We can scale later"**: True, but design the data model and API contracts to support future scale. Rearchitecting the data layer in Phase 3 is expensive.
