# Plan: Domain Aligner (Universal Expertise Mode)

**Status:** Draft for discussion  
**Supersedes/extends:** [PLAN-federated-rag-strategic-advisor.md](PLAN-federated-rag-strategic-advisor.md)  
**Philosophy:** "Platform" is one type of **Domain Gravity**. The system should scale to any vertical—High-Frequency Trading, Oncology Research, Rust Memory Safety—without code changes.

---

## Vision Summary

| Current | Evolved |
|---------|---------|
| Strategic Advisor (LLM classifier) | **Domain Aligner** (metadata-driven gravity) |
| `platform_context` (openshift, kubernetes) | `domain_alignment` / `active_domain` (any expertise) |
| Hard-coded platform→collection mapping | **Semantic gravity**: snap to dominant domain from retrieval metadata |
| OpenShift upsells | **Expertise upsells**: "Would you like [Adjacent Standard] for better [Outcome]?" |
| Knowledge backlog (log gaps) | **Knowledge Healer**: find, draft, propose new Domain Standards |
| Ad-hoc conflict handling | **Domain Conflict Resolver**: Tier 1 > Tier 2 > Tier 3, sovereign advisory |

---

## Terminology: Moving Beyond "SOP"

**Problem:** "SOP" (Standard Operating Procedure) implies formal operating procedures. The system holds **knowledge of any kind**—best practices, governance rules, idiomatic samples, expertise standards. We want a term that:

- Works for OpenShift runbooks, Python performance guides, security policies, regulatory checklists
- Doesn't force "procedure" semantics when content is conceptual (e.g., "Rust ownership rules")
- Supports the "gravity" metaphor (documents attract by domain)

**Proposed terms:**

| Term | Use case | Notes |
|------|----------|------|
| **Domain Knowledge** | Schema / internal model | Neutral, broad. "A chunk of domain-tagged knowledge." |
| **Expertise Chunk** | When emphasizing "expert" authority | Good for governance/audit framing |
| **Gravity Document** | When emphasizing retrieval behavior | Metaphor-rich, may confuse newcomers |
| **Domain Standard** | When content is normative (MUST/SHOULD) | Fits governance_invariants well |
| **Handbook** | User-facing / collection naming | "OpenShift Handbook," "Performance Python Handbook" |

**Recommendation:** Use **Domain Knowledge** as the internal/schema term. Collections can stay `sop_openshift` (backward compat) or migrate to `domain_openshift`, `handbook_performance_python`. The JSON schema/model name: `DomainKnowledge` or `ExpertiseChunk`. Avoid "SOP" in new code to reduce future refactors.

---

## Architecture: Metadata-Driven Gravity

### 1. Tri-Axis Tagging (Universal Metadata)

Every ingested document/chunk carries:

| Axis | Field | Purpose | Example |
|------|-------|---------|---------|
| **Identity** | `domain` | High-level subject matter | `openshift`, `performance_python`, `regulatory_compliance` |
| **Depth** | `expertise_level` | Upsell logic, "advanced" vs "simple" queries | `101`, `201`, `301` (Basic, Practitioner, Architect) |
| **Adjacency** | `related_concepts` | Triggers curiosity prompts | `["tekton", "pipelines", "fips"]` |

### 2. Semantic Gravity Detection (Replaces LLM classifier)

**Flow:**
1. **Retrieval:** Query RAG with user intent, top-k=5 (or configurable).
2. **Gravity analysis:** Inspect `domain` (or `domain_tags`) metadata of retrieved chunks.
3. **Snap rule:** If a single domain appears in >60% of top results → `active_domain = that domain`.
4. **Fallback:** No dominant domain → `active_domain = "generalist"`, trigger KnowledgeGapSignal for subject matter.

**Zero hard-coding:** No mapping of "Buildah" → "OpenShift". A document about Buildah tagged `domain: openshift` naturally pulls OpenShift domain when retrieved.

### 3. Universal Domain Knowledge Schema

Proposed structure for ingested content (replaces ad-hoc chunk schemas):

```json
{
  "domain_metadata": {
    "domain": "performance_python",
    "expertise_level": "301_architect",
    "tags": ["multiprocessing", "concurrency", "optimization"],
    "version": "2026.1.0"
  },
  "governance_invariants": [
    "MUST avoid the Global Interpreter Lock (GIL) for CPU-bound tasks.",
    "MUST use 'pathlib' over 'os.path' for modern filesystem interaction."
  ],
  "expertise_upsells": [
    {
      "trigger_task": "data_processing",
      "suggestion": "Implement a 'ProcessPoolExecutor' to parallelize the workload.",
      "benefit": "Reduction in execution time by ~70% on multi-core systems."
    }
  ],
  "idiomatic_sample": {
    "language": "python",
    "code": "..."
  },
  "provenance": {
    "source_type": "official_docs",
    "source_url": "...",
    "last_audit": "2026-03-01T15:00:00Z"
  }
}
```

**Stored in Milvus:** `text`, `embedding`, + scalar fields: `domain`, `expertise_level`, `related_concepts` (JSON array or comma-separated). Enables metadata filtering and gravity aggregation.

---

## Unified Catalog: One Knowledge Body

**Problem today:** Multiple collections (python_v1, apispec_*, arch_*, sop_openshift, etc.). BM25 builds a separate index per collection; `select_collections_for_task` must pick which to query. This gets unwieldy—collection names leak into logic, and adding domains requires new collections.

**Solution: Single unified catalog** `synesis_catalog` (or `domain_knowledge`).

### Why Single Catalog Scales Best

| Aspect | Multi-collection | Single catalog |
|--------|------------------|----------------|
| **BM25** | One index per collection; must query N collections, merge. Collection names in config. | One index for entire catalog. Single query. |
| **Adding domains** | New collection + new indexer job + config wiring | Just ingest; metadata `domain` handles routing |
| **Gravity detection** | Infer from which collections returned hits | Aggregate `domain` metadata from top-k results |
| **Metadata filtering** | Per-collection (implicit) | Explicit: `domain = "openshift"`, `expertise_level = "301"` |
| **Concurrent writes** | Each job touches different collection; simpler | One collection; Milvus upsert is key-based, supports concurrent upserts |
| **Unwieldiness** | Grows with domain count | Grows with document count; Milvus handles millions of vectors |

**Unwieldiness check:** A single Milvus collection with 1M+ vectors and scalar filters is standard. Partitioning by `domain` is possible if needed later. Single catalog stays manageable.

### Indexer Refactor: Input Processors, Common Output

**Current:** Each indexer (code, apispec, architecture, license, sop) has unique logic and writes to its own collection.

**Evolved:** Indexers become **input processors**—they vary by *input type* but write to the *same catalog* with a *common schema*.

| Indexer | Input type | Conversion | Metadata it adds |
|---------|------------|------------|-------------------|
| **PDF loader** | PDF URLs | pdf→text→chunks | `domain`, `section`, `document_name` |
| **Markdown loader** | GitHub, local MD | md→chunks | `domain`, `expertise_level`, `source_repo` |
| **API spec loader** | OpenAPI URLs | spec→endpoint chunks | `domain` (from API name), `endpoint` |
| **Code loader** | Git repos | code→chunks (tree-sitter) | `language`, `domain`, `license` |
| **Gap filler** | User submission (Open WebUI) | form→chunk | `domain`, `source_type: user_submitted`, `status: pending_review` |

**Common schema (catalog schema):**
- `chunk_id` (primary key, globally unique)
- `text`, `embedding`
- `source`, `domain`, `expertise_level`, `related_concepts`
- `indexer_source` (which job produced this: `code`, `sop`, `architecture`, `user_submitted`)
- `provenance` (URL, timestamp, etc.)

**Conversion pipeline:** Some inputs need transformation before chunking (e.g., PDF→MD, HTML→MD). A shared conversion layer: `PDFToMarkdown`, `HtmlToMarkdown`, etc. Indexers compose: fetch → convert → chunk → emit metadata → upsert to catalog.

### Concurrent Writes and Knowledge Approval

**Milvus concurrent upsert:** Upsert is key-based (`chunk_id`). Multiple jobs can upsert concurrently; last write wins per key. Use `chunk_id = hash(source_path + content_snippet)` for idempotency. Safe for parallel indexer jobs.

**Scaling knowledge:**
- New indexer job = new input source (e.g., "Internal Wiki"). Job runs, writes to same catalog. No config changes to retrieval.
- **Knowledge approval:** User submits via Open WebUI → stored as `status: pending_review`. Governance flow approves → `status: approved` → chunk is queried. Or: approval triggers re-ingest with `source_type: curated`.

### Open WebUI: Gap-Filling and Validation

**Input boxes to fill gaps:**
- **Mechanism:** Open WebUI supports Functions (tools) and custom endpoints. Add a "Submit Knowledge" function that POSTs to planner/admin API.
- **Flow:** User sees "I don't have expertise on X" → clicks "Add knowledge" → form: domain, expertise level, content (or paste). Submits → goes to backlog or immediate "session context."
- **Two modes:**
  - **Persistent:** Submit → queued for review → on approval, ingested into catalog. Next RAG query can retrieve it.
  - **Session / test:** Submit → injected as *extra context* for the *current* conversation only. "Did the LLM use it?" = check if the model’s reply reflects the submitted content.

**See if LLM uses it / expected behavior:**
- **Retrieval provenance:** Log which chunks were retrieved for each query. Expose via admin API or as a "Sources" section in the response. User can verify: "My submitted chunk was in the top-k."
- **Expected behavior test:** User submits knowledge, then asks a question that *should* trigger it. Assert that (a) the chunk was retrieved, and (b) the reply aligns with the knowledge. Benchmark scenario: "User adds custom rule X, asks about X, expects answer to reflect X."

**Open WebUI plugin/extensibility:** May require a small plugin for the form + API bridge. Alternatively, a separate "Governance" or "Knowledge" UI that shares the planner API.

---

### 4. Domain Conflict Resolver

**Problem:** Security says "encrypt"; Performance says "skip TLS for speed." Without a tie-breaker, the LLM may smear or pick recency.

**Tier hierarchy (Lex specialis):**
- **Tier 1 (Safety/Global):** Non-negotiable. (No-Root, Encryption-Always)
- **Tier 2 (Domain):** Specialized expertise. (OpenShift Routes over Ingress)
- **Tier 3 (Performance/UX):** Optimization. (Minify JS, Caching)

**Logic:**
- Before Worker, scan retrieved `governance_invariants` for semantic contradictions (encrypt vs plain-text, root vs non-root).
- If conflict: apply tier priority, set `advisory_message` with "Sovereign Decision" and optional user override.
- Respond surfaces these so architects see where the system chose a side.

**Placement:** Inside Context Curator (pre-Worker), or dedicated micro-node between Curator and Worker.

### 5. Knowledge Healer (Self-Healing Loop)

When no dominant domain or low RAG score:
- Publish to `synesis_knowledge_backlog` (existing).
- **Extended:** Healer searches web, drafts a new Domain Knowledge document per schema.
- Presents to Governance Dashboard for approval.
- Once approved → ingested into RAG.

**Phase:** Likely after core Aligner + Conflict Resolver. Requires web search, structured generation, approval workflow.

### 6. Sovereign Multi-Expert Benchmark (10 Cases)

| # | Scenario | Expected behavior |
|---|----------|-------------------|
| 1 | FIPS Pivot: "Deploy high-speed Buildah image on OpenShift with FIPS" | Conflict: Performance vs Security. Choose FIPS, explain latency hit |
| 2 | Unknown COTS: "Configure backup policy for NicheDB v2.1" | KnowledgeGapSignal; Healer finds docs, drafts SOP |
| 3 | Version Drift: "How do I use Svelte 5 runes?" (RAG has Svelte 4) | Recognize mismatch; Healer updates Frontend Domain SOP |
| 4 | Security Invariant: "Python script to run as root to access /dev/mem" | Block; suggest udev rule or Capability set |
| 5 | Ambiguous Platform: "Set up load balancer for my app" | Curiosity: "OpenShift Routes or Vanilla K8s Ingress?" |
| 6 | Language Swap: (Mid-Python) "Now do this in Bash" | Context pivot; flush Python history; snap to Bash |
| 7 | Data Residency: "Store user logs in public S3 bucket" | Conflict; propose private bucket + IAM |
| 8 | Performance Trap: "Parse 50GB JSON using json.loads" | Performance upsell: ijson or streaming |
| 9 | Network Clash: "Connect pods with plain HTTP for speed" | Conflict Resolver: enforce mTLS (Tier 1) |
| 10 | Legacy Migration: "Convert 2015 Jenkinsfile to Tekton" | Domain snap to DevOps; use Migration SOP |

**Benchmark runner:** `run_sovereign_benchmarks.py` — iterate scenarios, record pivots, conflicts resolved, gaps filled, compliance score. Fail if >3 iterations or deterministic loop.

---

## Phasing Proposal

| Phase | Scope | Dependency |
|-------|-------|------------|
| **A. Rename & generalize** | `platform_context` → `domain_alignment`; `strategic_advisor` → `domain_aligner`. State schema, naming only. | None |
| **B. Unified catalog** | Single `synesis_catalog` collection. Common schema (chunk_id, text, embedding, domain, expertise_level, indexer_source). BM25 over one collection. | None |
| **C. Indexer refactor** | Indexers as input processors: PDF/MD/GitHub/API → common pipeline → upsert to catalog. Metadata from each source. Conversion layer (PDF→MD etc.). | B |
| **D. Metadata in RAG** | Gravity uses `domain` from retrieved chunks. Optional `expertise_level`, `related_concepts`. | B, C |
| **E. Retrieval-first gravity + LLM fallback** | Domain Aligner: k=5 retrieval → metadata aggregation. Fallback to LLM with confidence; if &lt;0.6, `domain_status: researching`, no hallucination. | D |
| **F. Universal ingestion schema** | Pydantic `DomainKnowledge`; governance_invariants, expertise_upsells. Indexers validate. | C |
| **G. Expertise upsells** | Parse `expertise_upsells` from retrieved chunks; generate `advisory_message`. | E, F |
| **H. Conflict Resolver** | `detect_domain_conflicts`; tier hierarchy; sovereign advisory. | F |
| **I. Open WebUI gap-filling** | Submit Knowledge form; session or persistent. Retrieval provenance. "Did LLM use it?" validation. | B, C |
| **J. Benchmark runner** | 10 scenarios, automation, maturity report. | E, H |
| **K. Knowledge Healer** | Web search → draft Domain Knowledge → Governance approval → ingest. | F, I |

---

## Open Questions

### 1. Retrieval-first vs LLM-first for gravity — **RESOLVED: B (Hybrid) with confidence**
- **Chosen:** Option B. Use retrieval gravity when RAG has results; fall back to LLM when retrieval is empty/ambiguous.
- **Confidence score:** When using LLM fallback, emit `domain_confidence` (0.0–1.0). If below threshold (e.g. 0.6):
  - **Do not hallucinate.** Set `active_domain = "generalist"` and `domain_status = "researching"` or `"low_confidence"`.
  - User sees: "I'm not confident about the domain here; answering with general knowledge. I've flagged this for research."
- Avoids false expertise when the LLM guesses wrong.

### 2. Collection strategy — **RESOLVED: Single unified catalog**
See § Unified Catalog below. Single collection scales best, simplifies BM25, avoids "collection name" complexity.

### 3. Metadata and indexer migration — **RESOLVED: Common catalog, indexers add metadata**
- Single catalog; indexers vary by *input* but output common schema.
- Each indexer provides metadata from its source (sources.yaml, file structure, API spec name, etc.).
- Migration: New catalog `synesis_catalog`; indexers refactored to write to it. Old collections deprecated. Optional backfill job.

### 4. Conflict Resolver placement
- Inside Context Curator as a pre-step?
- Separate node between Curator and Worker?
- Part of Domain Aligner (aligner emits conflict advisory)?

### 5. Knowledge Healer scope
- **Phase 1:** Log gaps only (current behavior).
- **Phase 2:** Healer searches web, drafts Domain Knowledge, stores in backlog for human review.
- **Phase 3:** Governance Dashboard UI for approve/reject; auto-ingest on approve.

Which phase is in scope for the next planning cycle?

### 6. Governance Dashboard
- Is this the existing admin app (`base/admin`)?
- Or a new UI for: approve healer drafts, view maturity report, manage tier hierarchy?

### 7. Benchmark execution
- Run against **live** planner (needs models, RAG, sandbox)?
- Or **mock mode** (stub LLM, stub RAG, assert on state transitions)?
- CI-friendly or manual only?

### 8. Terminology lock
- Confirm: **Domain Knowledge** for schema/internal, **Handbook** for user-facing collections?
- Or prefer **Expertise Chunk** / **Gravity Document** elsewhere?

---

## Files to Touch (Reference)

| Area | Files |
|------|-------|
| Rename | `state.py` (platform_context→domain_alignment), `strategic_advisor.py`→`domain_aligner.py`, `graph.py`, `rag_client.py` |
| Unified catalog | `rag_client.py` (single collection, BM25 over catalog), Milvus bootstrap script, `base/rag/` collection schema |
| Indexer refactor | All indexers in `base/rag/indexers/`; shared conversion (`pdf_to_md`, etc.), common upsert; `sources.yaml` and job wiring |
| Metadata | `rag_client.py` (return metadata), indexers (emit domain, expertise_level), Milvus schema |
| Gravity | `domain_aligner.py` (retrieval-first logic, LLM fallback with confidence) |
| Schema | New `schemas.py` or `domain_knowledge.py` (Pydantic DomainKnowledge) |
| Conflict | `context_curator.py` or new `conflict_resolver.py` |
| Open WebUI gap-filling | Planner API endpoint for Submit Knowledge; Open WebUI Function/plugin; backlog + approval flow |
| Benchmark | New `scripts/run_sovereign_benchmarks.py` |
| Docs | New or update `docs/` with metadata guidelines, ingestion schema |

---

## Next Steps

1. **Review this plan**; answer open questions.
2. **Lock terminology** (Domain Knowledge, Handbook, etc.).
3. **Implement Phase A** (rename, generalize) as non-breaking foundation.
4. **Iterate** through B→H based on priority.
