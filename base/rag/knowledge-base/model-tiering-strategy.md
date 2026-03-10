# Model Tiering Strategy for Production AI Assistants

## The Problem with "Use a Large Model"

Generic advice to "use GPT-4 / Claude / 70B" ignores cost, latency, and operational constraints that dominate production deployments. Real systems need a tiering strategy that maps model size to task complexity.

## Concrete Tiering Framework

### Tier 1: Routing and Classification (1B–8B)

**Use case**: Intent classification, task routing, confidence scoring, simple structured output.

**Recommended models**:
- Llama 3.1 8B Instruct (general-purpose routing)
- Qwen2.5-1.5B (ultra-low-latency classification when accuracy requirements are modest)

**Hardware**: Single GPU (L4, T4, or shared L40S). <100ms inference for short prompts.

**Why 8B not 1B for routing**: 1B models fail on ambiguous intents (e.g., "design an architecture" classified as "explain" instead of "plan"). 8B provides sufficient instruction-following for structured JSON output with 95%+ accuracy on a curated evaluation set.

**Cost**: ~$0.15/hr on spot L4 instance. Handles 50-100 requests/second at short context.

### Tier 2: General Response Generation (14B–32B)

**Use case**: Code generation, documentation writing, multi-section analysis, technical explanations.

**Recommended models**:
- Qwen3-32B FP8 (best quality-per-GPU-dollar on single L40S)
- Qwen2.5-Coder-32B (code-specialized tasks)
- DeepSeek-Coder-V2-Lite-Instruct (16B, good code quality at lower cost)

**Hardware**: Single L40S (48GB VRAM). FP8 quantization fits 32B with room for KV cache. Time-to-first-token: 1-3s depending on context length.

**Why 32B not 14B**: 14B models (Qwen2.5-14B, CodeLlama-34B) produce acceptable code for single-file tasks but struggle with: (a) maintaining coherence across multi-section outputs, (b) following complex constraint sets, (c) producing architecturally sophisticated responses. 32B closes this gap at ~2x the cost.

**Why 32B not 70B**: 70B requires 2x L40S with tensor parallelism (pipeline or TP=2). This doubles GPU cost and adds 30-50% latency overhead from inter-GPU communication. For 80% of tasks, 32B quality matches 70B. The remaining 20% (complex architecture, nuanced code review) benefit from better prompting, RAG grounding, and critic loops rather than raw model scale.

**Cost**: ~$1.20/hr on spot L40S. Handles 5-15 concurrent requests depending on context length.

### Tier 3: Complex Reasoning (70B+)

**Use case**: Multi-step planning with dependencies, cross-domain synthesis, tasks where Tier 2 consistently underperforms after prompt optimization.

**Recommended models**:
- Llama 3.1 70B Instruct (broad capability)
- Qwen2.5-72B-Instruct (strong multilingual, good structured output)
- DeepSeek-V3 (671B MoE, ~37B active parameters — trades memory for quality)

**Hardware**: 2-4x L40S or 2x A100 (80GB). Time-to-first-token: 3-8s.

**When to escalate from Tier 2**: When the critic node scores responses below threshold on complex tasks after 2+ revision cycles. This is a runtime signal, not a static routing rule.

**Cost**: ~$2.50-5.00/hr depending on GPU type and parallelism. Reserve for <5% of traffic.

## Decision Framework for Model Selection

| Factor | Favors Smaller Model | Favors Larger Model |
|--------|---------------------|---------------------|
| Task complexity | Simple, single-step | Multi-section, cross-domain |
| Latency requirement | <1s TTFT | 3-5s acceptable |
| Concurrent users | High (>20 simultaneous) | Low (<5 simultaneous) |
| Output length | <500 tokens | >2000 tokens |
| Constraint density | Few constraints | Many interacting constraints |
| Budget | Limited GPU budget | GPU cost is secondary |

## Anti-Patterns

1. **"Just use the biggest model"**: Wastes 70-80% of GPU budget on tasks that 8B handles perfectly.
2. **"7B vs 8B is a meaningful distinction"**: Parameter count differences under 2x are noise. Evaluate on your specific tasks, not parameter counts.
3. **"Quantization always hurts quality"**: FP8 quantization on modern architectures (Qwen3, Llama 3.1) shows <1% degradation on standard benchmarks while halving memory requirements.
4. **"Fine-tuning replaces model size"**: LoRA adapters improve task-specific formatting and style but do not add knowledge or reasoning capacity. A fine-tuned 8B still cannot match base 32B on complex multi-step reasoning.
