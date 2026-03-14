# Synesis Makefile
# Run from project root.
# Prerequisites: pip install -r base/planner/requirements-test.txt (from base/planner)

.PHONY: mock-tests online-tests tests help
.PHONY: bench-retrieval bench-llm-judge bench-corpus-audit bench-chunking
.PHONY: curator-discover curator-report

# ── Unit / Integration Tests ─────────────────────────────────────────────────

# Offline tests: routing, API contract, E2E with mocked LLMs. No network or real services.
mock-tests:
	cd base/planner && python -m pytest tests/test_graph_routing.py tests/test_routing_parity.py tests/test_api.py tests/test_e2e_graph.py -v

# Online tests: hit live planner via oc port-forward. Requires:
#   oc port-forward svc/synesis-planner 8000:8000 -n synesis-planner
online-tests:
	python scripts/validate-intent-live.py --url http://localhost:8000

# All unit/mock tests (alias)
tests: mock-tests

# ── Retrieval Benchmarks ─────────────────────────────────────────────────────
# All benchmarks require port-forward to Milvus + embedder:
#   oc port-forward svc/synesis-milvus 19530:19530 -n synesis-rag
#   oc port-forward svc/embedder 8082:8080 -n synesis-rag

# Hybrid retrieval regression test (fails on >5% quality drop from baseline)
bench-retrieval:
	python benchmarks/retrieval/bench_hybrid.py

# Same with LLM-judged relevance labels (higher quality)
bench-retrieval-llm:
	python benchmarks/retrieval/bench_hybrid.py --use-llm-labels

# ── Corpus Quality Tools ─────────────────────────────────────────────────────
# Also requires port-forward to LiteLLM gateway for LLM calls:
#   oc port-forward svc/litellm-proxy 4000:4000 -n synesis-gateway

# Generate LLM-judged relevance labels (replaces naive overlap heuristic)
bench-llm-judge:
	python benchmarks/corpus/llm_judge.py

# Per-domain corpus coverage audit (identifies weak domains and dead-weight)
bench-corpus-audit:
	python benchmarks/corpus/audit_corpus.py

# Corpus audit with LLM-generated queries (richer coverage but costs more)
bench-corpus-audit-llm:
	python benchmarks/corpus/audit_corpus.py --llm-url http://localhost:4000/v1

# Chunk size parameter sweep (one-time diagnostic)
bench-chunking:
	python benchmarks/corpus/bench_chunking.py

# ── Auto-Curation ────────────────────────────────────────────────────────────
# Also requires port-forward to SearXNG:
#   oc port-forward svc/searxng 8888:8080 -n synesis-search

# Discover sources for weak domains, output proposed_sources.yaml
curator-discover:
	python tools/curator/curator_agent.py

# Show audit report summary (no side effects)
curator-report:
	@python -c "import json; r=json.load(open('benchmarks/corpus/corpus_audit_report.json')); \
	print(f\"Strong: {r['summary']['strong']}, Adequate: {r['summary']['adequate']}, \
	Weak: {r['summary']['weak']}, Empty: {r['summary']['empty']}\"); \
	print(f\"Weak: {', '.join(r['weak_domains'][:15])}\"); \
	print(f\"Empty: {', '.join(r['empty_domains'][:15])}\")"

help:
	@echo "── Tests ──"
	@echo "  mock-tests            - Offline tests (routing, API, E2E with mocks)"
	@echo "  online-tests          - Validation against live planner (oc port-forward)"
	@echo "  tests                 - Alias for mock-tests"
	@echo ""
	@echo "── Retrieval Benchmarks (requires Milvus + embedder port-forward) ──"
	@echo "  bench-retrieval       - Hybrid retrieval regression test"
	@echo "  bench-retrieval-llm   - Same with LLM-judged relevance labels"
	@echo ""
	@echo "── Corpus Quality (requires Milvus + embedder + LiteLLM port-forward) ──"
	@echo "  bench-llm-judge       - Generate LLM-judged relevance labels"
	@echo "  bench-corpus-audit    - Per-domain coverage audit"
	@echo "  bench-corpus-audit-llm - Audit with LLM-generated queries"
	@echo "  bench-chunking        - Chunk size parameter sweep (diagnostic)"
	@echo ""
	@echo "── Auto-Curation (requires SearXNG + LiteLLM port-forward) ──"
	@echo "  curator-discover      - Find sources for weak domains"
	@echo "  curator-report        - Show audit report summary"
