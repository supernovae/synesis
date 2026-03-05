# Web Search (SearXNG)

Synesis includes a self-hosted **SearXNG** meta-search engine that gives LangGraph nodes live web context. This grounds the AI's responses in current information — catching deprecated APIs, newly disclosed CVEs, and community-known error resolutions that aren't in the static RAG corpus.

## How It Works

SearXNG is an open-source, privacy-respecting meta-search engine that aggregates results from multiple upstream search engines. Synesis deploys it as an internal service — no API keys, no external accounts, no tracking. The planner nodes query it via a simple JSON API.

## Search Profiles

Two query profiles are available, selected per-call based on the node's intent:

| Profile | Upstream Engines | Used For |
|---------|-----------------|----------|
| **web** | Google, Bing, DuckDuckGo | Latest docs, best practices, vulnerability checks, API grounding |
| **code** | GitHub, StackOverflow | Error resolution, code examples, known issues, community fixes |

## Smart Auto-Trigger Logic

Each LangGraph node independently decides whether to search. There is no blanket "search every request."

**Router (Context Discovery + Grounding):**
- Triggered when the task mentions specific libraries/APIs, version numbers, or words like "latest"/"current"/"deprecated"
- Triggered when classification confidence is below 0.7 (uncertain tasks benefit from external grounding)
- Max 1 search per router pass; simple/trivial tasks never trigger a search
- Profile: `web` for general knowledge, `code` for API-specific tasks

**Worker (Error Resolution):**
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
| `WEB_SEARCH_URL` | `http://searxng.synesis-search.svc.cluster.local:8080` | SearXNG service URL |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `5` | HTTP timeout per search call |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max results returned per query |
| `WEB_SEARCH_SUPERVISOR_ENABLED` | `true` | Enable router context discovery searches |
| `WEB_SEARCH_WORKER_ERROR_ENABLED` | `true` | Enable worker error resolution searches |
| `WEB_SEARCH_CRITIC_ENABLED` | `false` | Enable critic vulnerability fact-checking |

## Resilience

The web search client includes a **circuit breaker** (3 failures -> 30-second open state). When SearXNG is down or slow, the circuit breaker opens and all search calls return empty results immediately — no node is ever blocked waiting for a search. The pipeline continues normally with RAG and failure store context.

## Adding Custom Search Engines

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
