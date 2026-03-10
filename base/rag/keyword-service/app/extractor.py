"""Keyword extraction: ngram candidates -> embed -> cosine ranking -> MMR.

Replicates KeyBERT's algorithm without PyTorch. The heavy lifting (embedding)
is delegated to the TEI embedder service over HTTP.
"""

from __future__ import annotations

import re

import numpy as np

from .embed_client import EmbedClient

_STOP_WORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "shall",
        "should",
        "may",
        "might",
        "must",
        "can",
        "could",
        "to",
        "of",
        "in",
        "for",
        "on",
        "with",
        "at",
        "by",
        "from",
        "as",
        "into",
        "through",
        "during",
        "before",
        "after",
        "above",
        "below",
        "between",
        "out",
        "off",
        "over",
        "under",
        "again",
        "further",
        "then",
        "once",
        "here",
        "there",
        "when",
        "where",
        "why",
        "how",
        "all",
        "each",
        "every",
        "both",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "no",
        "nor",
        "not",
        "only",
        "own",
        "same",
        "so",
        "than",
        "too",
        "very",
        "just",
        "because",
        "but",
        "and",
        "or",
        "if",
        "while",
        "about",
        "up",
        "it",
        "its",
        "this",
        "that",
        "these",
        "those",
        "i",
        "me",
        "my",
        "we",
        "our",
        "you",
        "your",
        "he",
        "him",
        "she",
        "her",
        "they",
        "them",
        "what",
        "which",
        "who",
        "whom",
    ]
)

_WORD_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9]\b|[a-zA-Z]\b")


def _candidate_ngrams(
    text: str,
    ngram_range: tuple[int, int] = (1, 2),
) -> list[str]:
    """Extract unique candidate ngrams from text, filtering stop words."""
    words = _WORD_RE.findall(text.lower())
    seen: set[str] = set()
    candidates: list[str] = []

    for n in range(ngram_range[0], ngram_range[1] + 1):
        for i in range(len(words) - n + 1):
            gram_words = words[i : i + n]
            if all(w in _STOP_WORDS for w in gram_words):
                continue
            if gram_words[0] in _STOP_WORDS or gram_words[-1] in _STOP_WORDS:
                continue
            gram = " ".join(gram_words)
            if gram not in seen and len(gram) > 1:
                seen.add(gram)
                candidates.append(gram)

    return candidates


def _mmr_selection(
    doc_embedding: np.ndarray,
    candidate_embeddings: np.ndarray,
    candidates: list[str],
    top_n: int = 8,
    diversity: float = 0.5,
) -> list[tuple[str, float]]:
    """Maximal Marginal Relevance selection for diverse keyword extraction."""
    doc_sim = candidate_embeddings @ doc_embedding
    selected_indices: list[int] = []
    remaining = list(range(len(candidates)))

    for _ in range(min(top_n, len(candidates))):
        if not remaining:
            break

        if not selected_indices:
            best = max(remaining, key=lambda i: float(doc_sim[i]))
        else:
            selected_embs = candidate_embeddings[selected_indices]
            best_score = -1e9
            best = remaining[0]
            for i in remaining:
                rel = float(doc_sim[i])
                red = float(np.max(candidate_embeddings[i] @ selected_embs.T))
                score = (1 - diversity) * rel - diversity * red
                if score > best_score:
                    best_score = score
                    best = i

        selected_indices.append(best)
        remaining.remove(best)

    return [(candidates[i], float(doc_sim[i])) for i in selected_indices]


def _cosine_selection(
    doc_embedding: np.ndarray,
    candidate_embeddings: np.ndarray,
    candidates: list[str],
    top_n: int = 8,
) -> list[tuple[str, float]]:
    """Simple top-N by cosine similarity to document."""
    sims = candidate_embeddings @ doc_embedding
    top_indices = np.argsort(sims)[::-1][:top_n]
    return [(candidates[i], float(sims[i])) for i in top_indices]


def extract_keywords(
    text: str,
    embedder: EmbedClient,
    *,
    top_n: int = 8,
    ngram_range: tuple[int, int] = (1, 2),
    use_mmr: bool = True,
    diversity: float = 0.5,
) -> list[tuple[str, float]]:
    """Extract keywords from a single document."""
    candidates = _candidate_ngrams(text, ngram_range)
    if not candidates:
        return []

    all_texts = [text[:500], *candidates]
    embeddings = embedder.embed(all_texts)
    doc_emb = embeddings[0]
    cand_embs = embeddings[1:]

    if use_mmr:
        return _mmr_selection(doc_emb, cand_embs, candidates, top_n, diversity)
    return _cosine_selection(doc_emb, cand_embs, candidates, top_n)


def extract_keywords_batch(
    texts: list[str],
    embedder: EmbedClient,
    *,
    top_n: int = 8,
    ngram_range: tuple[int, int] = (1, 2),
    use_mmr: bool = True,
    diversity: float = 0.5,
) -> list[list[tuple[str, float]]]:
    """Extract keywords from multiple documents in a single embed pass."""
    if not texts:
        return []

    all_candidates: list[list[str]] = []
    embed_texts: list[str] = []
    doc_indices: list[int] = []
    cand_ranges: list[tuple[int, int]] = []

    for doc_text in texts:
        cands = _candidate_ngrams(doc_text, ngram_range)
        all_candidates.append(cands)
        doc_indices.append(len(embed_texts))
        embed_texts.append(doc_text[:500])
        start = len(embed_texts)
        embed_texts.extend(cands)
        cand_ranges.append((start, start + len(cands)))

    if not embed_texts:
        return [[] for _ in texts]

    embeddings = embedder.embed(embed_texts)
    results: list[list[tuple[str, float]]] = []

    for i, (cands, (cstart, cend)) in enumerate(zip(all_candidates, cand_ranges)):
        if not cands:
            results.append([])
            continue

        doc_emb = embeddings[doc_indices[i]]
        cand_embs = embeddings[cstart:cend]

        if use_mmr:
            results.append(_mmr_selection(doc_emb, cand_embs, cands, top_n, diversity))
        else:
            results.append(_cosine_selection(doc_emb, cand_embs, cands, top_n))

    return results
