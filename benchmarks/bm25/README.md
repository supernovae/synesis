# Native retrieval benchmark data

This directory contains the stable query set and reviewed relevance labels for
the production NornicDB native hybrid-search benchmark in
`benchmarks/retrieval/bench_hybrid.py`.

The runtime benchmark calls `/nornicdb/search`, so query embedding, BM25,
equal-weight RRF fusion, long-query handling, and configured stage-2 reranking
are evaluated as one production path. Promote a baseline only after reviewing
the corpus version and judgments:

```bash
python benchmarks/retrieval/bench_hybrid.py --update-baseline
```

Use `benchmarks/corpus/llm_judge.py` to generate a second label set with an
OpenAI-compatible judge. Human review remains required before promotion.
