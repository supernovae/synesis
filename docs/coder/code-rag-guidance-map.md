# Code-RAG Guidance -> Synesis Implementation Map

This note maps practical code-RAG recommendations to concrete repository changes in this rollout.

## 1) Selective retrieval for coding intents

Guidance: retrieval should be intent-aware; coding tasks should prioritize code evidence without dropping docs.

Implemented:
- Query-time coding intent detection and code-score bias in `base/planner-ts/src/retrieval/unified.ts`.
- Two-bucket evidence assembly for coding queries:
  - `primary_code` (code-signal-heavy RAG hits)
  - `supporting_docs` (explanatory/context docs)

## 2) Code as first-class metadata, not opaque text

Guidance: persist explicit code signals to improve filtering/ranking and observability.

Implemented:
- NornicDB schema v19 fields in:
  - `base/rag/indexer/app/schema.py`
  - `base/rag/indexer/app/nornic_writer.py`
- New fields:
  - `has_code`
  - `code_signal_count`
  - `code_density`
  - `code_language`
- Pipeline population in `base/rag/indexer/app/pipeline.py`.

## 3) Improve extraction quality before gating

Guidance: avoid losing code blocks during HTML-to-markdown extraction.

Implemented:
- Markdown selection fallback in `base/rag/indexer/app/handlers/web_page.py`:
  - compares trafilatura output vs crawler markdown
  - chooses richer candidate (code fences + structure aware)
- Coverage in `base/rag/indexer/tests/test_web_page_handler.py`.

## 4) Better diagnostics for "0 chunks"

Guidance: distinguish parse success from dedup/gate rejections.

Implemented:
- Added explicit counters in indexer stats (`pipeline.py`):
  - `parsed_total`
  - `dedup_skipped`
  - `gate_rejected`
  - `gatekeeper_skipped_docs`
  - `written_total`

## 5) Source-native ingestion for Go core docs/code

Guidance: avoid relying only on rendered websites for code corpora; ingest source-native artifacts where available.

Implemented:
- Updated Go corpus bootstrap in `bootstrap/corpus/lang-go.yaml`:
  - moved CodeReviewComments to `github_markdown` (wiki markdown source)
  - added `github_code` sources for Go stdlib/core slices and Go doc comment package
  - kept web docs as supplemental evidence.

## 6) Crawl policy controls for Tier-1 sources

Guidance: aggressive defaults with profile-specific control beats ad hoc depth spikes.

Implemented:
- Raised global defaults in `base/rag/indexer/app/crawl_config.py`.
- Added profile-based knobs (`reference`, `tutorial`, `blog`) and wired Go corpus entries to profiles.

## Current Follow-Ups

- Add task-level evaluation harness for coding queries (`hit@k` symbol/file + answer quality deltas).
- Continue expanding language-specific symbol resolution where tree-sitter support is available.
