# Web Search & Multi-Source Federation

Synesis includes a self-hosted **SearXNG** meta-search engine that gives LangGraph nodes live web context. This grounds the AI's responses in current information — catching deprecated APIs, newly disclosed CVEs, and community-known error resolutions that aren't in the static RAG corpus.

## Architecture

The retrieval pipeline supports **multi-source federation**: instead of a single "web search" call, the router can fan out queries across multiple configured search sources in parallel via `asyncio.gather`, then merge results with source-aware weighted fusion before Reciprocal Rank Fusion (RRF).

```
                          ┌──────────────────┐
                          │   Router Node    │
                          └────────┬─────────┘
                                   │
                        ┌──────────┴──────────┐
                        │   Source Selector   │
                        │  (taxonomy + prompt │
                        │   cues + config)    │
                        └──────────┬──────────┘
                  ┌────────────────┼────────────────┐
                  ▼                ▼                 ▼
          ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
          │ web_general  │ │ code_general │ │ jira_internal│
          │ (Google,Bing,│ │ (GitHub,     │ │ (Jira engine)│
          │  DuckDuckGo) │ │ StackOverflow│ │              │
          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                 │                │                 │
                 └────────────────┼─────────────────┘
                                  ▼
                      ┌───────────────────────┐
                      │ Source-Weighted RRF    │
                      │ Merge + Authority Boost│
                      └───────────────────────┘
```

## Search Source Catalog (`search_sources.yaml`)

Search sources are defined in `search_sources.yaml` at the repo root — the same pattern as `models.yaml`. Each source declares:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (e.g. `web_general`, `code_general`, `jira_internal`) |
| `label` | Human-readable display name |
| `enabled` | Whether included by default in every retrieval |
| `searxng_params` | Dict of SearXNG query params (`engines`, `categories`) |
| `trust.authority` | `canonical` \| `vetted` \| `community` \| `external` |
| `trust.origin_type` | `internal` \| `curated` \| `external` |
| `weight` | RRF fusion weight multiplier (1.0 = neutral, >1 = boosted) |
| `max_results` | Cap results from this source per query |
| `fetch_pages` | Whether to follow URLs and extract page content |
| `domain_policy.mode` | `prefer` (boost matching domains) or `restrict` (allowlist-only) |
| `domain_policy.domains` | Static list of preferred/allowed domains for this source |
| `routing.tags` | Domain taxonomy tags that activate this source |
| `routing.task_types` | Task type labels that activate this source |
| `routing.prompt_aliases` | User-facing keywords that explicitly request this source |
| `routing.always` | If true, included in every fan-out regardless of routing |

### Default Sources

The catalog ships with two enabled sources:

| Source | Engines | Trust | Always | Description |
|--------|---------|-------|--------|-------------|
| `web_general` | Google, Bing, DuckDuckGo | external | Yes | General web search |
| `code_general` | GitHub, StackOverflow | community | No | Code-focused, activated by programming domain tags |

Additional sources (GitHub internal, Jira, Helpdesk, Confluence) are included as commented examples. Uncomment and configure their SearXNG engine names to enable.

### Loading

The planner loads the catalog at startup from `SYNESIS_SEARCH_SOURCES_PATH` (default `/etc/synesis/search_sources.yaml`). If the file is missing, safe defaults matching the legacy `web` and `code` profiles are used.

## Source Selection

Sources are selected per-query via three mechanisms:

1. **Always-on**: Sources with `routing.always: true` are included in every fan-out.
2. **Taxonomy-driven**: Sources whose `routing.tags` match the frame's `domain_tags` or whose `routing.task_types` match the task type are included.
3. **Prompt-driven**: When the user explicitly mentions a source alias (e.g. "include jira", "search github+jira"), the matching source is included even if disabled.

Selection happens in `search_sources.select_sources()` and is invoked by `RouterNode._resolve_search_sources()`.

## Parallel Fan-Out

When multiple sources are selected, the planner queries them all in parallel via `asyncio.gather`:

```python
# Conceptual flow in unified_retrieval.py
rag_coro = retrieve_context(query, ...)     # Milvus RAG
web_coro = _multi_source_web_search(query)  # Parallel source fan-out

rag_raw, web_multi_raw = await asyncio.gather(rag_coro, web_coro)
```

Each source gets its own SearXNG call with its configured `searxng_params`. Results are tagged with `source_id`, trust metadata, and the source's `weight` multiplier before being merged.

## Source-Aware Scoring

Results from different sources are scored with three layers:

1. **BM25 relevance**: Query-document lexical scoring (inline, no external dependency)
2. **Domain authority boost**: URL-based tier scoring (Tier 1: official docs 1.4x, Tier 2: community 1.2x, Tier 4: blogs 0.6x)
3. **Source weight**: The `weight` field from `search_sources.yaml` (e.g. internal Jira at 1.4x vs external web at 1.0x)
4. **Authority boost**: Trust-tier boost from `engine_authority_map` / source catalog (canonical 1.5x, vetted 1.3x, community 1.0x, external 0.7x)

All scores feed into Reciprocal Rank Fusion (RRF) for final ranking.

## Domain Policy (Prefer / Restrict)

Taxonomy configurations can declare `preferred_web_scopes` (e.g. `site:kubernetes.io`, `site:docs.aws.amazon.com`). These are applied as a **post-retrieval domain policy**, not injected into the search query string.

### `prefer` mode (default)

Results from preferred domains receive a configurable score boost (default 1.4x) before RRF merge. Results from other domains still appear, just ranked lower. This prevents the zero-result problem that occurred when `site:` operators were injected into query strings for engines (GitHub, StackOverflow) that don't support them.

### `restrict` mode

Web results whose URL hostname doesn't match any preferred domain are dropped before RRF merge. RAG results are never filtered. Use this for locked-down environments where only approved domains should appear in evidence.

### Configuration

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `domain_policy_mode` | `SYNESIS_DOMAIN_POLICY_MODE` | `prefer` | `prefer` or `restrict` |
| `domain_policy_boost` | `SYNESIS_DOMAIN_POLICY_BOOST` | `1.4` | Score multiplier for prefer mode |

Per-source overrides are also available via `domain_policy` in `search_sources.yaml`:

```yaml
- id: web_general
  domain_policy:
    mode: prefer      # or "restrict" for allowlist-only
    domains:          # static domains (merged with taxonomy scopes at runtime)
      - kubernetes.io
      - docs.aws.amazon.com
```

## Empty-Evidence Degradation

When both RAG and web search return zero results, the planner:

1. Sets a clear degradation note: "No matching documents found in local corpus or web search -- responding from general knowledge"
2. Publishes knowledge gaps to the admin backlog with explicit `reason: "zero_results"` logging
3. Relaxes the critic's approval threshold so the writer's parametric-only response is not rejected for "insufficient depth" (which would trigger expensive revision cycles with the same empty evidence)

## Source Provenance

The `source_id` from the catalog flows end-to-end:

- `SearchResult.source_id` → `UnifiedResult.source_id` → `EvidenceSource.metadata.source_id`
- The context formatter shows `source_id` in citation headers (e.g. `[W] (code_general | "GitHub Result")`)
- The summarizer prompt includes source labels (e.g. `(web/code_general)`) so the LLM can attribute information

## Legacy Compatibility

The `engine_authority_map` config field is still supported. When `search_sources.yaml` is loaded, the planner can derive engine authority entries from source trust metadata via `derive_engine_authority_map()`. Explicit `engine_authority_map` values take precedence.

## Search Profiles (Legacy)

For backward compatibility, the two legacy search profiles still work:

| Profile | Upstream Engines | Used For |
|---------|-----------------|----------|
| **web** | Google, Bing, DuckDuckGo | Latest docs, best practices, vulnerability checks |
| **code** | GitHub, StackOverflow | Error resolution, code examples, known issues |

These map to the `web_general` and `code_general` sources in the catalog.

## Smart Auto-Trigger Logic

Each LangGraph node independently decides whether to search. There is no blanket "search every request."

**Router (Retrieval + Grounding):**
- Triggered when the task mentions specific libraries/APIs, version numbers, or words like "latest"/"current"/"deprecated"
- Triggered when classification confidence is below 0.7 (uncertain tasks benefit from external grounding)
- Max 1 search per router pass; simple/trivial tasks never trigger a search
- Profile: `web` for general knowledge, `code` for API-specific tasks
- Source selection: automatic from taxonomy and prompt cues

**Executor (Error Resolution):**
- Triggered **only on revision passes** (iteration > 0 with execution failure)
- First-pass code generation never searches
- Extracts the primary error message from sandbox output and searches the `code` profile
- Results are injected as a `## Web Search Context` block alongside RAG and failure hints

**Critic (Fact-Checking — default disabled):**
- Parses import statements from the generated code to extract third-party package names
- Searches the `web` profile for `"CVE vulnerability {package} {year}"` for each non-stdlib import
- Results are injected as `## External Verification` in the critic prompt
- Default **off** because it adds latency to every successful path; enable via `SYNESIS_WEB_SEARCH_CRITIC_ENABLED=true`

## Network Requirements

SearXNG is the **only** Synesis service that requires outbound internet access (to reach Google, Bing, DuckDuckGo, GitHub, StackOverflow). The network policy for `synesis-search` allows:
- **Ingress**: Only from `synesis-planner` namespace on port 8080
- **Egress**: External IPs on port 443/80 (for upstream search engines) + DNS

All other Synesis namespaces remain fully internal with deny-all egress.

## Configuration

All web search settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `WEB_SEARCH_ENABLED` | `true` | Master switch for all web search |
| `WEB_SEARCH_URL` | *(empty in planner-ts code; set in cluster)* | SearXNG service URL. **`./scripts/deploy.sh`** patches the in-cluster default when `SYNESIS_DEPLOY_PLANNER_RETRIEVAL` is on. |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `5` | HTTP timeout per search call |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max results returned per query |
| `SEARCH_SOURCES_PATH` | `/etc/synesis/search_sources.yaml` | Path to the search source catalog |
| `WEB_SEARCH_ROUTER_ENABLED` | `true` | Enable router retrieval searches |
| `WEB_SEARCH_EXECUTOR_ERROR_ENABLED` | `true` | Enable executor error resolution searches |
| `WEB_SEARCH_CRITIC_ENABLED` | `false` | Enable critic vulnerability fact-checking |

### planner-ts and `./scripts/deploy.sh`

- **Unified retrieval** registers when `SYNESIS_EMBEDDER_URL` is set **or** `SYNESIS_WEB_SEARCH_URL` is non-empty.
- **Post-apply** `patch_planner_retrieval_and_web` (default **on**): sets TEI, Milvus, SearXNG URL, and web enabled on `synesis-planner-ts` so values persist across applies. **Off:** `SYNESIS_DEPLOY_PLANNER_RETRIEVAL=false`.
- **URL overrides:** `SYNESIS_PLANNER_EMBEDDER_URL`, `SYNESIS_PLANNER_MILVUS_HOST`, `SYNESIS_PLANNER_MILVUS_PORT`, `SYNESIS_PLANNER_SEARXNG_URL`, `SYNESIS_PLANNER_WEB_SEARCH_ENABLED`.
- **Admin `web_search_log`:** Secret `synesis-admin-db-url` / `admin-url` in `synesis-planner` (from `patch_admin_db_urls`). See [DEPLOY_SECRETS.md](DEPLOY_SECRETS.md).
- **Verify:** `GET /debug/retrieval-config` with internal bearer token — `unified_retrieval_client_registered`, `web_search_url`, `embedder_url`.

## Resilience

The web search client includes a **circuit breaker** (3 failures -> 30-second open state). When SearXNG is down or slow, the circuit breaker opens and all search calls return empty results immediately — no node is ever blocked waiting for a search. The pipeline continues normally with RAG and failure store context.

Each source in the parallel fan-out has independent timeout handling — a slow or failing source does not block results from other sources.

## Adding Custom Search Sources

### Option 1: Edit `search_sources.yaml` (recommended)

Add a new source entry to `search_sources.yaml`:

```yaml
sources:
  - id: jira_internal
    label: "Jira"
    enabled: true
    searxng_params:
      engines: "jira"
    trust:
      authority: "canonical"
      origin_type: "internal"
    weight: 1.4
    max_results: 5
    fetch_pages: false
    routing:
      tags: ["project-management"]
      prompt_aliases: ["jira", "tickets"]
      always: false
```

Then add the corresponding SearXNG engine in `base/search/configmap-settings.yaml`.

### Option 2: Edit SearXNG directly

Edit `base/search/configmap-settings.yaml` to add or remove upstream engines. SearXNG supports 100+ engines. For example, to add Wikipedia:

```yaml
engines:
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    disabled: false
```

## Replica Tuning

| Environment | Replicas | Resources |
|------------|----------|-----------|
| Dev | 1 | 100m-500m CPU, 128-256Mi RAM |
| Staging | 1 (base default) | 250m-1 CPU, 256-512Mi RAM |
| Prod | 2 (HA) | 250m-1 CPU, 256-512Mi RAM |

## Observability

Two Prometheus metrics track web search health:

- **`synesis_web_search_total`**: Counter by `profile` and `outcome` (success/error). Tracks search volume and failure rates.
- **`synesis_web_search_duration_seconds`**: Histogram by `profile`. Tracks latency distribution.

## Disabling Web Search

To disable all web search:

```bash
oc set env deployment/synesis-planner -n synesis-planner SYNESIS_WEB_SEARCH_ENABLED=false
```

Or remove `../../base/search` from the overlay's `kustomization.yaml` to avoid deploying SearXNG entirely.

---

Back to [README](../README.md) | See also: [RAG Pipeline](RAG.md)
