# Plan: Federated RAG and Strategic Advisor Node

**Status:** Implemented (2025-02-25)

Phases 1–5 complete. Convention-based collection resolution: no manual mapping.  
**Created:** 2025-02-25  
**Goal:** Scale Synesis RAG to platform-aware (OpenShift/Red Hat vs Vanilla K8s vs COTS) without breaking the existing Supervisor→Planner→Context Curator→Worker flow.

---

## Executive Summary

We will add a **Strategic Advisor** node and **Multi-Index Federated RAG** so Synesis can:

1. **Detect platform scope** (OpenShift, Vanilla K8s, COTS) from the user's task
2. **Route retrieval** to specialized SOP indices instead of one generic bucket
3. **Surface knowledge gaps** when RAG confidence is low (Safety-II "what falls through")
4. **Proactively suggest** platform-specific upsells ("I can also generate Tekton Pipeline…")

Existing workflow remains intact: we add plumbing and a new node; we do not change the core loop.

---

## Current Architecture (Baseline)

| Component | Location | Current Behavior |
|-----------|----------|------------------|
| **Entry Classifier** | `nodes/entry_classifier.py` | Deterministic: task_size, target_language, rag_mode, bypass_supervisor |
| **Supervisor** | `nodes/supervisor.py` | Parses intent, calls `select_collections_for_task()`, fetches RAG, routes to planner or context_curator |
| **select_collections_for_task** | `rag_client.py` | Language + keyword-based: `{target_language}_v1`, `code_*`, `patterns_*`, `apispec_*` when k8s_keywords hit |
| **Context Curator** | `nodes/context_curator.py` | Builds ContextPack from rag_results, applies min_score (0.6), budget eviction, conflict detection |
| **Respond** | `graph.py` | Assembles final response; surfaces `budget_alert` and `context_resync_message` from context_pack |
| **Open WebUI** | SSE + content | Uses `event: status` for node progress; budget_alert appears in response content |

**Gap today:** No platform-specific routing (OpenShift vs Vanilla K8s). Low-score RAG is excluded but not logged as a "knowledge gap" or surfaced to the user.

---

## Proposed Architecture

### 1. Strategic Advisor Node

**Placement:** Insert between Entry Classifier and Supervisor (and before context_curator when trivial bypasses Supervisor).

- **Input:** `task_description`, `target_language`, `task_size`, `messages`
- **Output (new state fields):**
  - `platform_context`: str — domain from fast LLM classifier (e.g., `openshift`, `kubernetes`, `python_web`, `embedded_garmin`, `synthesizer_music`, `generic`)
  - `active_sop_refs`: list[str] — suggested collection names for RAG (mapped from platform_context)
  - `advisory_message`: str | None — proactive suggestion (e.g., "I can also generate Tekton…")
  - `incomplete_knowledge`: bool — set when downstream signals low RAG confidence (see §3)

**Implementation:** **Fast LLM classifier** (see Appendix B). Single completion, ~10 tokens, fast model. No rigid keyword mapping — the model infers domain from task_description. Handles OpenShift, K8s, Garmin, synthesizers, or any domain. Fallback to "generic" on timeout/error.

**Platform → collection mapping:** When platform_context matches known domains, prefer specialized SOP collections:
- `openshift`, `ocp`, `rosa`, `hcp` → RH_OPENSHIFT_SOP
- `kubernetes`, `k8s`, `eks`, `gke` → VANILLA_K8S_SOP
- `argocd` etc. → COTS_EXTENSIONS
- `generic` or unknown → `{lang}_v1` (current behavior)

---

### 2. Federated Index Model

| Index Name | Content | Trigger |
|------------|---------|---------|
| **RH_OPENSHIFT_SOP** | SCC, Routes, BuildConfigs, ImageStreams, Tekton | platform_context=openshift_* |
| **VANILLA_K8S_SOP** | Ingress, PodSecurity, standard kubectl manifests | platform_context=vanilla_k8s |
| **COTS_EXTENSIONS** | ArgoCD, Tekton, etc. | Tool-specific keywords |
| **KNOWLEDGE_GAPS** / synesis_knowledge_backlog | Failed retrievals, unknown queries | Self-healing loop (§3) |

**Migration path:** Initially, map `RH_OPENSHIFT_SOP` → existing `apispec_*` or `arch_standards_v1` until dedicated SOP collections exist. New indexers can be added incrementally.

---

### 3. Knowledge Gap Hook (Context Curator)

When the Context Curator's top RAG rerank score is **< 0.6**:

1. Set `incomplete_knowledge: true` on state
2. Append to `advisory_message` (or new `knowledge_gap_message`):  
   *"I don't have the definitive Red Hat SOP for [X] yet; I will answer using general standards, but I've flagged this for my knowledge base update."*
3. **Publish** the query + metadata to `synesis_knowledge_backlog` (new Milvus collection or simple log/queue for now)
4. **Telemetry:** Log `context_curator_knowledge_gap` with query snippet, collections queried, max_score

**Existing behavior preserved:** Chunks below min_score are still excluded. We add a signal and advisory; we do not change eviction logic.

---

### 4. Open WebUI Exposure of Knowledge Gaps

**Yes, this is possible.** Two approaches:

| Approach | How | Reliability |
|----------|-----|--------------|
| **A. Content-based** | Append `advisory_message` / `knowledge_gap_message` to the final response (like `budget_alert`) | ✅ Always works. Open WebUI renders whatever we put in the message. |
| **B. SSE event** | Emit `event: advisory` or `event: knowledge_gap` with JSON payload | ⚠️ Depends on Open WebUI's event handling. Their `event: status` is used for progress; custom events may need a plugin. |

**Recommendation:** Implement **A** first (content-based). It reuses the existing `budget_alert` pattern in `respond_node` and requires no Open WebUI changes. **B** can be explored later if we add an Open WebUI plugin.

---

### 5. Proactive "Extend and Embellish"

When platform_context is OpenShift and the task involves builds/deploys:

- Advisor sets `advisory_message`:  
  *"Proactive Tip: I can also generate the Tekton Pipeline to automate this in your OpenShift project. Would you like to extend this solution?"*

This is optional polish for Phase 2+; the core value is routing + knowledge gaps.

---

## State Schema Changes

Add to `GraphState` and `SynesisState`:

```python
platform_context: str = ""           # openshift_ai | vanilla_k8s | cots | generic
active_sop_refs: list[str] = []     # Suggested collections for this turn
advisory_message: str = ""          # Proactive suggestion or knowledge-gap notice
incomplete_knowledge: bool = False   # True when RAG max score < threshold
knowledge_gap_message: str = ""     # User-facing "I've flagged this for update"
```

---

## Graph Wiring (Non-Breaking)

**Current:**
```
Entry → Supervisor → (Planner | context_curator) → Worker → ...
```

**Proposed:**
```
Entry → Strategic Advisor → Supervisor → (Planner | context_curator) → Worker → ...
```

- For **trivial** (bypass_supervisor): Entry → Advisor → context_curator. Advisor sets platform_context="generic" and no-op for trivial.
- For **non-trivial**: Advisor runs first, sets platform_context and active_sop_refs. Supervisor uses them in `select_collections_for_task`.

**Supervisor / RAG changes:**  
Refactor `select_collections_for_task(task_type, target_language, task_description, platform_context=None)` to accept `platform_context`. When provided, prefer `active_sop_refs` or map platform_context → federated collections.

---

## Phased Implementation

| Phase | Scope | Risk |
|-------|-------|------|
| **1. Foundation** | Add state fields; extend `select_collections_for_task` to accept platform_context; create no-op mapping (current collections). | Low |
| **2. Strategic Advisor** | New node; deterministic platform detection; wire into graph. | Low |
| **3. Federated indices** | Create RH_OPENSHIFT_SOP, VANILLA_K8S_SOP, COTS_EXTENSIONS (or alias existing). Indexer jobs for SOP content. | Medium |
| **4. Knowledge gap** | Context Curator: emit KnowledgeGapSignal when max_score < 0.6; advisory_message; optional backlog writer. | Low |
| **5. Open WebUI** | Respond: append advisory_message + knowledge_gap_message to content (like budget_alert). | Low |
| **6. Proactive upsells** | Advisor: conditional advisory_message for OpenShift + build/deploy. | Low |

---

## Conflicts and Mitigations

| Risk | Mitigation |
|------|------------|
| **Context smearing** (OpenShift + Vanilla mixed) | Sovereign Invariant: prioritize OpenShift when both detected; explicit collection ordering. |
| **New node latency** | Advisor is deterministic (no LLM); target < 5ms. |
| **Backlog storage** | Start with logging + optional Milvus collection; avoid blocking the main path. |
| **Open WebUI display** | Use content-based advisory (no dependency on custom events). |

---

## Resolved Questions (2025-02-25)

| Question | Decision |
|----------|----------|
| **Indexer content** | Use Red Hat / OpenShift SOPs from GitHub. Create new indexer like architecture; add `github_repo` source type. Sources: `openshift/runbooks`, `red-hat-storage/ocs-sop`, plus ROSA/HCP materials. |
| **Knowledge backlog** | Milvus collection. Logs/S3 don't scale for "what don't we know?" queries; Milvus enables semantic search over gaps. |
| **Platform detection** | **Fast LLM classifier.** Deterministic keywords are too rigid. Use a fast model to infer domain from task_description — works for OpenShift, K8s, Garmin watch, synthesizers, or any domain without manual hierarchy mapping. |
| **Trivial path** | Run Advisor for trivial but no-op (platform_context="generic") to keep graph uniform. |

---

## Appendix A: SOP Indexer Spec

New indexer: `base/rag/indexers/sop/` (same structure as architecture).

**sources.yaml format:**

```yaml
github_repos:
  - repo: "openshift/runbooks"
    branch: "master"
    path: "alerts"           # Recursively fetch .md under alerts/
    collection: "rh_openshift_sop"
    tags: ["ocp", "runbooks", "alerts"]

  - repo: "red-hat-storage/ocs-sop"
    branch: "main"
    path: "sop"               # ODF SOP documents
    collection: "rh_openshift_sop"
    tags: ["ods", "ocs", "storage"]

  # ROSA/HCP: terraform-rhcs-rosa-hcp, CSA-RH/rosa-hcp-fast-deploy have
  # scripts/docs; add when we have markdown SOP content.
```

**Implementation:** Use GitHub API (`/repos/{owner}/{repo}/contents/{path}`) to list files recursively; fetch `download_url` for each `.md`. Reuse architecture indexer's `parse_markdown` and `MilvusWriter`. Add `github_repos` loader in indexer app.

**Known SOP sources:**
- [openshift/runbooks](https://github.com/openshift/runbooks) — OCP alert runbooks (alerts/operator_name/*.md)
- [red-hat-storage/ocs-sop](https://github.com/red-hat-storage/ocs-sop) — ODF SOPs (sop/ directory)
- ROSA/HCP: No dedicated SOP repo; deployment docs in terraform-rhcs-rosa-hcp, rosa-hcp-fast-deploy; add as we find markdown content

---

## Appendix B: Fast LLM Classifier Spec

**Goal:** Infer `platform_context` / domain from `task_description` without rigid keyword mapping. Handles OpenShift, K8s, Garmin, synthesizers, etc.

**Model choice:** Use a fast model from the gateway (e.g., Qwen3-8B, or whatever is configured for low-latency). Avoid the heavy Worker/Critic models.

**Prompt (minimal, ~50 tokens):**
```
Classify the user's task domain. Reply with exactly one word or short phrase (lowercase, no punctuation).
Examples: openshift, kubernetes, python_web, embedded_garmin, synthesizer_music, generic
Task: {task_description[:300]}
Domain:
```

**Output:** Strip whitespace, lowercase. Map to `platform_context` (fallback "generic" if empty or parse error).

**Performance:** Single completion, max_tokens=10, temperature=0. Config: `LITELLM_STRATEGY=fastest` or dedicated fast model in gateway.

**Fallback:** If LLM unavailable or timeout, use "generic" and log. Never block the graph.

---

## Appendix C: Knowledge Backlog Milvus Schema

**Collection:** `synesis_knowledge_backlog`

| Field | Type | Notes |
|-------|------|-------|
| chunk_id | VARCHAR(64) | Hash of query+timestamp |
| query | VARCHAR(1024) | User query that triggered gap |
| task_description | VARCHAR(512) | Truncated task |
| collections_queried | VARCHAR(256) | Comma-separated |
| max_score | FLOAT | Top rerank score (why we flagged) |
| platform_context | VARCHAR(64) | From Advisor |
| timestamp | INT64 | Unix |
| embedding | FLOAT_VECTOR | Embed query for similarity search |
| language | VARCHAR(32) | target_language |

**Use cases:**
- Admin dashboard: "What questions are we failing to answer?"
- Semantic search: Find similar gaps before adding new SOPs
- Periodic job: Export gaps for manual SOP authoring

---

## Files to Touch (Reference)

| File | Changes |
|------|---------|
| `state.py` | Add platform_context, active_sop_refs, advisory_message, incomplete_knowledge, knowledge_gap_message |
| `graph.py` | Add strategic_advisor node; wire Entry → Advisor → ...; respond_node: append advisory + knowledge_gap |
| `rag_client.py` | Refactor select_collections_for_task(platform_context=); add platform → collection mapping |
| `nodes/strategic_advisor.py` | **New** — fast LLM classifier for platform/domain detection |
| `nodes/context_curator.py` | Knowledge gap: when max score < 0.6, set incomplete_knowledge, advisory_message, publish to backlog |
| `nodes/supervisor.py` | Pass platform_context into select_collections_for_task |
| `config.py` | advisor_model (fast), curator_knowledge_gap_threshold, knowledge_backlog_enabled |
| `main.py` | NODE_STATUS_MESSAGES["strategic_advisor"] = "Detecting platform…" |
| **SOP Indexer** | |
| `base/rag/indexers/sop/` | **New** — GitHub-repo SOP indexer (Dockerfile, job.yaml, kustomization, app/) |
| `base/rag/indexers/sop/sources.yaml` | openshift/runbooks, red-hat-storage/ocs-sop |
| `base/rag/indexers/sop/app/indexer.py` | Fetch .md from GitHub API, parse, embed, upsert to rh_openshift_sop |
| `base/rag/indexers/kustomization.yaml` | Add `sop` resource |

---

## Next Steps

1. Review this plan; confirm phasing and open questions.
2. Implement Phase 1 (state + select_collections_for_task extension).
3. Implement Phase 2 (Strategic Advisor node + graph wiring).
4. Iterate on Phases 3–6 as needed.
