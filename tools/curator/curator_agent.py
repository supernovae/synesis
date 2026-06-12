#!/usr/bin/env python3
"""Auto-curation agent: discover high-quality sources for under-served taxonomy domains.

Reads the corpus audit report, identifies weak/empty domains, discovers candidate
sources via web search + LLM suggestion, evaluates them, and outputs
proposed_ingestion_items.yaml for human review.

Usage:
    python curator_agent.py [--audit-report PATH] [--taxonomy PATH]
                            [--llm-url URL] [--model MODEL]
                            [--searxng-url URL] [--max-domains N]
                            [--output proposed_ingestion_items.yaml]

Prerequisites:
    - Port-forward to SearXNG: oc port-forward svc/searxng 8888:8080 -n synesis-search
    - Provide an OpenAI-compatible LLM endpoint (for example planner-ts /v1)
    - Run audit_corpus.py first to generate the audit report
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import yaml

DEFAULT_MODEL = "synesis-general"


# ---------------------------------------------------------------------------
# Web search via SearXNG
# ---------------------------------------------------------------------------


def searxng_search(
    query: str,
    searxng_url: str,
    max_results: int = 10,
) -> list[dict[str, str]]:
    """Search via SearXNG JSON API. Returns list of {title, url, snippet}."""
    try:
        resp = httpx.get(
            f"{searxng_url}/search",
            params={
                "q": query,
                "format": "json",
                "categories": "general",
                "language": "en",
                "safesearch": 1,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = []
        for r in data.get("results", [])[:max_results]:
            results.append(
                {
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "snippet": r.get("content", ""),
                }
            )
        return results
    except Exception as e:
        print(f"  SearXNG search failed: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


def llm_complete(prompt: str, llm_url: str, model: str, max_tokens: int = 500) -> str:
    try:
        resp = httpx.post(
            f"{llm_url}/chat/completions",
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.3,
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  LLM call failed: {e}", file=sys.stderr)
        return ""


def llm_suggest_sources(domain_path: str, llm_url: str, model: str) -> list[str]:
    """Ask LLM to suggest authoritative sources for a domain."""
    prompt = (
        f"List the 10 most authoritative, freely available online resources for learning about "
        f"'{domain_path}'. Include official documentation, tutorials, and reference guides. "
        f"Prefer primary sources (official docs, academic sites) over aggregators (Medium, Reddit). "
        f"Return one URL per line, nothing else."
    )
    content = llm_complete(prompt, llm_url, model, max_tokens=400)
    urls = []
    for line in content.splitlines():
        line = line.strip().lstrip("0123456789.-) ")
        if line.startswith("http"):
            urls.append(line)
        elif "http" in line:
            # Extract URL from surrounding text
            for word in line.split():
                if word.startswith("http"):
                    urls.append(word.rstrip(".,;)"))
                    break
    return urls[:10]


def llm_evaluate_source(
    title: str,
    snippet: str,
    url: str,
    domain_path: str,
    llm_url: str,
    model: str,
) -> dict[str, Any]:
    """Ask LLM to evaluate a source's quality for a domain. Returns score + rationale."""
    prompt = (
        f"Evaluate this web resource for someone studying '{domain_path}'.\n\n"
        f"Title: {title}\n"
        f"URL: {url}\n"
        f"Snippet: {snippet[:500]}\n\n"
        f"Rate quality 1-5:\n"
        f"  1 = spam/marketing/irrelevant\n"
        f"  2 = tangentially related, low quality\n"
        f"  3 = relevant but not authoritative\n"
        f"  4 = good quality, useful reference\n"
        f"  5 = authoritative primary source (official docs, academic)\n\n"
        f"Respond in this exact format:\n"
        f"Score: N\n"
        f"Rationale: one sentence explanation"
    )
    content = llm_complete(prompt, llm_url, model, max_tokens=100)

    score = 3
    rationale = ""
    for line in content.splitlines():
        line = line.strip()
        if line.lower().startswith("score:"):
            for ch in line:
                if ch in "12345":
                    score = int(ch)
                    break
        elif line.lower().startswith("rationale:"):
            rationale = line.split(":", 1)[1].strip()

    return {"score": score, "rationale": rationale}


# ---------------------------------------------------------------------------
# Source discovery pipeline
# ---------------------------------------------------------------------------


def discover_sources_for_domain(
    domain_key: str,
    domain_config: dict,
    searxng_url: str,
    llm_url: str,
    model: str,
) -> list[dict[str, Any]]:
    """Discover and evaluate candidate sources for a single domain."""
    path = domain_config.get("path", domain_key)
    hints = domain_config.get("query_expansion_hints", [])
    web_scopes = domain_config.get("preferred_web_scopes", [])

    # Build search queries from taxonomy metadata
    search_queries = [
        f"{path.split('>')[-1].strip()} documentation tutorial",
        f"{path.split('>')[-1].strip()} best practices guide",
    ]
    for hint in hints[:3]:
        search_queries.append(f"{hint} documentation")
    if web_scopes:
        scope_q = " ".join(web_scopes[:2])
        search_queries.append(f"{path.split('>')[-1].strip()} {scope_q}")

    # Collect unique URLs from web search
    seen_urls: set[str] = set()
    candidates: list[dict[str, str]] = []

    for q in search_queries:
        results = searxng_search(q, searxng_url, max_results=5)
        for r in results:
            url = r["url"]
            domain_part = urlparse(url).netloc
            if url not in seen_urls and domain_part not in seen_urls:
                seen_urls.add(url)
                seen_urls.add(domain_part)
                candidates.append(r)

    # LLM-suggested sources
    llm_urls = llm_suggest_sources(path, llm_url, model)
    for url in llm_urls:
        if url not in seen_urls:
            seen_urls.add(url)
            candidates.append({"title": "", "url": url, "snippet": "LLM-suggested source"})

    # Evaluate each candidate
    evaluated = []
    for c in candidates[:15]:
        eval_result = llm_evaluate_source(
            c["title"],
            c["snippet"],
            c["url"],
            path,
            llm_url,
            model,
        )
        evaluated.append(
            {
                "title": c["title"] or urlparse(c["url"]).netloc,
                "url": c["url"],
                "snippet": c["snippet"][:200],
                "quality_score": eval_result["score"],
                "rationale": eval_result["rationale"],
            }
        )

    # Sort by quality score descending
    evaluated.sort(key=lambda x: x["quality_score"], reverse=True)
    return evaluated


def generate_source_entry(
    candidate: dict[str, Any],
    domain_key: str,
) -> dict[str, Any]:
    """Generate an Admin ingestion bootstrap-compatible item."""
    return {
        "uri": candidate["url"],
        "handler": "web_page",
        "title": candidate["title"][:80],
        "domain": domain_key,
        "authority": "community",
        "origin_type": "external",
        "tags": [domain_key, "auto-curated"],
        "corpus_class": "hybrid",
        "languages": [],
        "artifact_kind": "docs",
        "content_profile": "reference",
        "freshness_sla_days": 180,
        "scope_tags": [domain_key, "auto-curated"],
        "constraint_kind": "guiding",
        "config": {
            "discovery": "sitemap_first",
            "follow_links": True,
            "respect_robots": True,
            "max_pages": 20,
        },
        "_curator_metadata": {
            "quality_score": candidate["quality_score"],
            "rationale": candidate["rationale"],
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Auto-curation agent for weak taxonomy domains")
    parser.add_argument(
        "--audit-report", default="benchmarks/corpus/corpus_audit_report.json", help="Path to corpus audit report"
    )
    parser.add_argument("--taxonomy", default="base/planner-ts/config/taxonomy_prompt_config.yaml")
    parser.add_argument("--llm-url", default="http://localhost:4000/v1")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--searxng-url", default="http://localhost:8888")
    parser.add_argument("--max-domains", type=int, default=10, help="Max number of weak domains to process")
    parser.add_argument("--min-quality", type=int, default=3, help="Min quality score (1-5) for proposed items")
    parser.add_argument("--output", default="tools/curator/proposed_ingestion_items.yaml")
    args = parser.parse_args()

    audit_path = Path(args.audit_report)
    if not audit_path.exists():
        print(f"ERROR: {audit_path} not found. Run audit_corpus.py first.", file=sys.stderr)
        sys.exit(1)

    taxonomy_path = Path(args.taxonomy)
    if not taxonomy_path.exists():
        print(f"ERROR: {taxonomy_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(audit_path) as f:
        audit = json.load(f)
    with open(taxonomy_path) as f:
        taxonomy = yaml.safe_load(f)

    # Collect weak + empty domains from audit
    target_domains = audit.get("weak_domains", []) + audit.get("empty_domains", [])
    target_domains = target_domains[: args.max_domains]

    if not target_domains:
        print("No weak or empty domains found in audit report. Corpus looks healthy!")
        sys.exit(0)

    print(f"Discovering sources for {len(target_domains)} weak/empty domains...")
    t0 = time.time()

    all_proposals: list[dict] = []

    for i, domain_key in enumerate(target_domains):
        domain_config = taxonomy.get(domain_key, {})
        if not isinstance(domain_config, dict):
            continue

        path = domain_config.get("path", domain_key)
        print(f"\n[{i + 1}/{len(target_domains)}] {domain_key} ({path})")

        candidates = discover_sources_for_domain(
            domain_key,
            domain_config,
            args.searxng_url,
            args.llm_url,
            args.model,
        )

        # Filter by quality threshold
        good = [c for c in candidates if c["quality_score"] >= args.min_quality]
        print(f"  Found {len(candidates)} candidates, {len(good)} pass quality threshold (>= {args.min_quality})")

        domain_entries = []
        for c in good[:5]:
            entry = generate_source_entry(c, domain_key)
            domain_entries.append(entry)
            print(f"    [{c['quality_score']}/5] {c['title'][:60]} — {c['url'][:80]}")

        if domain_entries:
            all_proposals.append(
                {
                    "domain": domain_key,
                    "path": path,
                    "sources": domain_entries,
                }
            )

    elapsed = time.time() - t0

    # Write proposed ingestion items.
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Flatten into Admin ingestion bootstrap-compatible items for reviewers.
    flat_items = []
    for proposal in all_proposals:
        for entry in proposal["sources"]:
            flat_items.append(entry)

    output_data = {
        "generated_by": "curator_agent.py",
        "domains_processed": len(all_proposals),
        "total_items": len(flat_items),
        "review_instructions": (
            "Review each entry below. Adjust 'authority' (community -> vetted) for "
            "high-quality sources and remove entries that do not meet standards. "
            "Import approved items through the Admin ingestion bootstrap endpoint "
            "or create them in the Admin ingestion queue."
        ),
        "proposals": all_proposals,
    }

    with open(output_path, "w") as f:
        yaml.dump(output_data, f, default_flow_style=False, sort_keys=False, width=120)

    print(f"\n=== Curator Agent Summary ({elapsed:.0f}s) ===")
    print(f"  Domains processed:  {len(all_proposals)}")
    print(f"  Items proposed:     {len(flat_items)}")
    print(f"  Output:             {output_path}")
    print("\n  Next steps:")
    print(f"    1. Review {output_path}")
    print("    2. Adjust authority levels for vetted sources")
    print("    3. Import approved entries through Admin ingestion bootstrap or UI")
    print("    4. Run the queue indexer to ingest new items")
    print("    5. Re-run audit_corpus.py to verify improvement")


if __name__ == "__main__":
    main()
