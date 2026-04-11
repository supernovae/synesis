# Yarn Runtime — Cost Analysis & Caching Strategy

Living document tracking API costs per developer session, breakeven analysis between API and local GPU, and prefix caching efficiency.

## Provider Pricing (as of March 2026)

### DeepInfra — Qwen3-Coder-480B-A35B-Instruct-Turbo

| Token Type | Price per 1M |
|-----------|-------------|
| Input (uncached) | $0.22 |
| Input (cached) | $0.022 |
| Output | $1.00 |

Source: [DeepInfra pricing](https://deepinfra.com/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo)

Cached tokens are **10x cheaper** than uncached. This is the primary lever.

### Local vLLM (future)

| Instance | GPU | VRAM | Cost/hr | Cost/month |
|----------|-----|------|---------|------------|
| g6e.2xlarge | 1x L40S | 48GB | ~$0.80 | ~$576 |
| g6e.2xlarge (2x) | 2x L40S | 96GB | ~$1.60 | ~$1,152 |
| g7e.xlarge | 1x H100 | 80GB | ~$3.50 | ~$2,520 |

Qwen3-Coder-480B-A35B (35B active params FP8) needs ~70GB VRAM. Fits on 1x H100 or 2x L40S.

---

## Token Usage Baselines

Based on [Claude Code token analysis](https://docs.bswen.com/blog/2026-03-10-claude-code-token-usage-per-request/) (100M tokens tracked across 1,289 requests):

| Metric | Value |
|--------|-------|
| Avg tokens per request | ~78,000 |
| Input:Output ratio | 166:1 (99.4% input) |
| Cacheable token ratio | 84% (with proper prefix management) |
| Requests per dev per hour | ~10 |
| Requests per dev per day | ~80 |

---

## Why Caching Matters

IDE agent sessions are extremely input-heavy. The model re-reads:
- System prompt and safety constraints
- Tool definitions (MCP tool schemas)
- Full conversation history
- File contents, diffs, test output

Most of this content is identical across consecutive requests within a session. The Yarn buffer's three-zone layout exploits this.

### Buffer Layout

```
[PINNED ZONE - always cache hit]
  System prompt (~500 tokens)
  Tool definitions (~2,000 tokens)
  Memory replay summary (~1,000 tokens)

[STABLE ZONE - cache hit for all previous turns]
  Turn 1: user + assistant (~5,000 tokens)
  Turn 2: user + tool_call + tool_result + assistant (~8,000 tokens)
  ...
  Turn N-1: full exchange

[DELTA ZONE - cache miss]
  Turn N: new user message (~3,000 tokens)
```

### Projected Cache Hit Rates

| Session Phase | Cache Hit Rate | Explanation |
|--------------|---------------|-------------|
| Turns 1-2 | ~40% | Only pinned zone shared |
| Turns 3-10 | ~75-85% | Growing stable zone |
| Turns 10+ | ~85-92% | Large stable prefix |
| **Weighted average** | **~80-85%** | |

---

## Per-Request Cost

Typical request: 78K input tokens, 1K output tokens.

### Without Caching (naive rebuild)

| Component | Calculation | Cost |
|-----------|-------------|------|
| Input | 78K * $0.22/M | $0.0172 |
| Output | 1K * $1.00/M | $0.001 |
| **Total** | | **$0.018** |

### With Yarn Caching (80% hit rate)

| Component | Calculation | Cost |
|-----------|-------------|------|
| Cached input | 62.4K * $0.022/M | $0.0014 |
| Uncached input | 15.6K * $0.22/M | $0.0034 |
| Output | 1K * $1.00/M | $0.001 |
| **Total** | | **$0.006** |

**Savings: 3x cheaper with 80% cache hit rate.**

### With 90% Cache Hit

| Component | Calculation | Cost |
|-----------|-------------|------|
| Cached input | 70.2K * $0.022/M | $0.0015 |
| Uncached input | 7.8K * $0.22/M | $0.0017 |
| Output | 1K * $1.00/M | $0.001 |
| **Total** | | **$0.004** |

---

## Per-Developer Estimates

Assuming 80 requests/day (10/hr * 8hr):

| Scenario | Per Request | Per Day | Per Month |
|----------|-------------|---------|-----------|
| No caching (baseline) | $0.018 | $1.44 | ~$31 |
| 80% cache hit | $0.006 | $0.48 | ~$10 |
| 90% cache hit | $0.004 | $0.32 | ~$7 |

Compare to Claude Code API: ~$6/dev/day, ~$100-200/dev/month.

---

## Breakeven: API vs Local GPU

| Team Size | DeepInfra (80% cache) | 2x g6e.2xlarge | Winner |
|-----------|----------------------|----------------|--------|
| 1 dev | $10/mo | $1,152/mo | **API** |
| 5 devs | $50/mo | $1,152/mo | **API** |
| 10 devs | $100/mo | $1,152/mo | **API** |
| 25 devs | $250/mo | $1,152/mo | **API** |
| 50 devs | $500/mo | $1,152/mo | **API** |
| 100 devs | $1,000/mo | $1,152/mo | **API** |
| 115+ devs | $1,150+/mo | $1,152/mo | **Local** |

**Conclusion**: DeepInfra is dramatically cheaper for teams under ~115 developers. The crossover point depends on actual usage intensity.

### Factors that favor API longer:
- No GPU ops overhead (driver updates, OOM debugging)
- No idle cost (pay-per-token, not pay-per-hour)
- Automatic model updates
- Multi-region availability

### Factors that favor local sooner:
- Heavy usage developers (>200 req/day)
- Data sovereignty requirements
- Predictable monthly cost
- Lower latency (skip network hop)

---

## Tracking Plan

The `yarn_usage_log` table captures per-request data:

```sql
SELECT
    date_trunc('day', created_at) AS day,
    COUNT(*) AS requests,
    SUM(tokens_in) AS total_input,
    SUM(tokens_cached) AS total_cached,
    SUM(tokens_out) AS total_output,
    SUM(cost_usd) AS total_cost,
    AVG(tokens_cached::float / NULLIF(tokens_in, 0)) AS avg_cache_hit_rate
FROM yarn_usage_log
WHERE provider = 'deepinfra'
GROUP BY 1
ORDER BY 1 DESC;
```

Admin UI dashboard will visualize these metrics (Phase 3).

---

Back to [README](../../README.md) | See also: [Coder docs](README.md) · [Runtime redirect](../YARN_RUNTIME.md)
