# RAG ingestion — cost and throughput notes

## Token model (semantic gatekeeper)

Let:

- **D** = documents processed with gatekeeper enabled  
- **T_in** ≈ 1.5k–4k tokens per call (system + instructions + document excerpt)  
- **T_out** ≈ 300–800 tokens (structured JSON)

**Document-level gatekeeper:** total ≈ **D × (T_in + T_out)**.

**Per-chunk gatekeeper (avoid as default):** if **C** chunks ≈ **C × (T_in + T_out)** — grows linearly with chunks and dominates cost at large **C**.

## Levers

1. **Skip gatekeeper** for high-trust `authority` (`SYNESIS_INDEXER_GATEKEEPER_SKIP_AUTHORITY`).
2. **Cap excerpt length** (implemented in indexer gatekeeper module).
3. **Cheaper / faster inference** for bulk (Groq-class APIs vs in-cluster vLLM) — trade latency and $/M tokens.
4. **Batch offline replay** on rented GPU for catch-up after large corpus additions.

## Illustrative order of magnitude

Prices change; treat as intuition only. At ~**$0.05/M input** and ~**$0.08/M output** token rates, **1M document-level** calls with ~2k in + 500 out is on the order of **~$100–150** for that step alone. **Per-chunk** over the same corpus with hundreds of millions of chunks is orders of magnitude higher—hence hierarchical design.
