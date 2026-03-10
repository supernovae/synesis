# RAG Retrieval Architecture — Design Patterns for Production Systems

## Retrieval Pipeline Stages

A production RAG system has four stages, each with distinct failure modes and optimization levers:

### Stage 1: Query Understanding

Transform the user's natural language query into effective retrieval queries. A single user prompt may require multiple retrieval queries targeting different knowledge domains.

**Concrete approach**: Decompose multi-section prompts into per-section queries. For "design an architecture with model selection and failure modes," generate separate queries: "model selection strategy production AI" and "AI assistant failure modes detection." This produces higher-recall retrieval than a single concatenated query.

**Anti-pattern**: Using the raw user prompt as the retrieval query. Long prompts dilute the embedding signal — the vector represents the average of all topics, matching none well.

### Stage 2: Retrieval

Fetch candidate passages from the vector store. Hybrid retrieval (vector + keyword) outperforms either alone for technical content.

**Concrete implementation**:
- **Vector search**: Embed the query with the same model used for indexing (e.g., all-MiniLM-L6-v2, 384-dim). Retrieve top-20 candidates with cosine similarity.
- **BM25 keyword search**: Run a parallel BM25 query against the same corpus. Retrieve top-20 candidates.
- **Reciprocal Rank Fusion (RRF)**: Merge the two result sets using RRF with k=60. This is robust to score distribution differences between vector and keyword search.

**Why hybrid over vector-only**: Technical content contains precise terms (API names, error codes, configuration keys) that keyword search handles better than semantic similarity. Pure vector search may return passages about "similar concepts" while missing the exact answer.

**Why Milvus over Elasticsearch for this**: Milvus supports filtered vector search natively — query "model tiering" filtered to `domain=infrastructure` in a single operation. Elasticsearch requires a two-phase query (filter then dense_vector), which is slower and harder to tune.

### Stage 3: Re-Ranking

Re-score the top candidates using a cross-encoder or application-specific signals. This is where retrieval quality jumps from "good" to "great."

**Concrete approach**:
- **Cross-encoder re-ranking**: Use a cross-encoder model (e.g., ms-marco-MiniLM-L-6-v2) to re-score top-20 candidates against the original query. Reduces to top-5 passages.
- **Domain gravity**: Boost passages from domains matching the classified intent. If the query is classified as "infrastructure," passages from `domain=infrastructure` get a 1.5x score multiplier.
- **Recency bias**: For technology topics, prefer passages from documents updated within the last 12 months. Stale documentation is worse than no documentation.

**Cost**: Cross-encoder adds ~50ms per query (batch of 20 passages). Acceptable for non-trivial queries; skip for trivial/fast-path queries.

### Stage 4: Context Assembly

Pack selected passages into the prompt with appropriate framing. Order and framing matter more than most practitioners realize.

**Concrete approach**:
- Place the most relevant passage first (primacy bias in attention).
- Separate passages with clear source attribution: `[Source: architecture/adr-002.md]`.
- Cap total context at 30% of the model's context window to leave room for the system prompt and generation.
- If passages conflict, include both with a note: "Note: These sources may present different perspectives."

**Anti-pattern**: Stuffing all retrieved passages into the prompt without curation. This wastes context window and confuses the model with redundant or contradictory information.

## Technology Comparison for Vector Search

| Feature | Milvus | Elasticsearch | Weaviate | Pinecone |
|---------|--------|---------------|----------|----------|
| Hybrid search (vector + BM25) | Via application layer | Native (8.x+) | Native | Sparse + dense |
| Kubernetes-native | Yes (Helm/Operator) | Yes (ECK) | Yes (Helm) | SaaS only |
| Filtered vector search | Native, single query | Two-phase | Native | Native |
| Operational complexity | Medium (Standalone: low) | High (cluster management) | Medium | None (managed) |
| Cost (self-hosted) | Low (single pod for <5M vectors) | High (3+ node cluster) | Medium | N/A (SaaS pricing) |
| Max vectors (single node) | ~10M (Standalone) | ~5M (with dense_vector) | ~5M | Unlimited (managed) |

**Recommendation for teams <100 engineers with budget constraints**: Milvus Standalone. Single pod deployment, S3-backed storage, handles the scale of internal documentation + code for organizations up to ~500 engineers. Graduate to Milvus Distributed only when query volume or vector count justifies it.

## Chunking Strategy

How you split documents matters as much as how you retrieve them.

**For code**: Use AST-aware chunking. Split at function/class boundaries, not arbitrary line counts. Each chunk should be a self-contained unit (function + docstring + imports). Tool: tree-sitter parsers per language.

**For documentation**: Split at heading boundaries (H2 or H3). Each chunk should cover one concept. Include the parent heading chain as metadata for context: "Architecture > Model Selection > Tiering Strategy."

**For ADRs and decision records**: Keep the full ADR as a single chunk (typically 300-800 tokens). The decision + context + consequences must stay together to be useful.

**Chunk size target**: 200-500 tokens per chunk for documentation, 100-300 tokens for code (function-level). Chunks >800 tokens dilute the embedding signal; chunks <100 tokens lack sufficient context.
