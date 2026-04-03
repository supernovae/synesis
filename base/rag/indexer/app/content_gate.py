"""Deterministic content gate for RAG ingestion quality control.

Two layers:
  Layer 1 (page-level): URL filtering, page quality scoring, doc-type
  classification, and child-follow decisions.  Used by web-fetching handlers.

  Layer 2 (chunk-level): Universal text quality scoring that runs in the
  pipeline for ALL handlers.  Catches marketing, thin, and boilerplate
  content from any source type.

No LLM calls — pure heuristics (string matching, regex, counting).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from urllib.parse import unquote, urlparse, urlunparse

logger = logging.getLogger("synesis.indexer.content_gate")

# ═══════════════════════════════════════════════════════════════════════
# Default signal lists (overridable via crawl_policy.yaml)
# ═══════════════════════════════════════════════════════════════════════

ALLOW_PATH_SIGNALS: list[str] = [
    "/docs/",
    "/documentation/",
    "/guide/",
    "/guides/",
    "/manual/",
    "/reference/",
    "/api/",
    "/spec/",
    "/tutorial/",
    "/learn/",
    "/architecture/",
    "/framework/",
    "/book/",
    "/resources/",
    "/how-to/",
    "/concepts/",
    "/overview/",
    "/getting-started/",
    "/quickstart/",
    "/best-practices/",
    "/patterns/",
]

BLOCK_PATH_SIGNALS: list[str] = [
    "/about",
    "/contact",
    "/careers",
    "/jobs",
    "/team",
    "/company",
    "/press",
    "/events",
    "/community",
    "/forums",
    "/login",
    "/signup",
    "/pricing",
    "/partners",
    "/newsletter",
    "/privacy",
    "/terms",
    "/legal",
    "/cookies",
    "/support/tickets",
    "/case-study",
    "/case-studies",
    "/webinar",
    "/demo",
    "/trial",
    "/subscribe",
    "/unsubscribe",
    "/account",
    "/settings",
    "/profile",
    "/cart",
    "/checkout",
    "/shop",
    "/store",
]

BLOCKED_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".svg",
        ".ico",
        ".webp",
        ".bmp",
        ".css",
        ".js",
        ".mjs",
        ".ts",
        ".jsx",
        ".tsx",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".otf",
        ".zip",
        ".tar",
        ".gz",
        ".bz2",
        ".rar",
        ".7z",
        ".exe",
        ".msi",
        ".dmg",
        ".deb",
        ".rpm",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".wmv",
        ".flv",
        ".webm",
        ".xml",
        ".rss",
        ".atom",
    }
)

MARKETING_PHRASES: list[str] = [
    "request a demo",
    "book a demo",
    "schedule a demo",
    "start your free trial",
    "free trial",
    "try for free",
    "get started for free",
    "sign up free",
    "trusted by",
    "loved by",
    "used by leading",
    "enterprise-grade",
    "world-class",
    "best-in-class",
    "return on investment",
    "pricing plans",
    "see pricing",
    "compare plans",
    "contact sales",
    "talk to sales",
    "request a quote",
    "customer success stories",
    "customer testimonials",
    "as seen in",
    "featured in",
    "subscribe to our newsletter",
    "join our mailing list",
    "all rights reserved",
]

EPISTEMIC_PHRASES: list[str] = [
    "architecture",
    "design pattern",
    "best practice",
    "implementation",
    "configuration",
    "deployment",
    "api reference",
    "function signature",
    "parameters",
    "example",
    "code sample",
    "tutorial",
    "how to",
    "step by step",
    "walkthrough",
    "overview",
    "introduction",
    "getting started",
    "concepts",
    "fundamentals",
    "principles",
    "troubleshooting",
    "debugging",
    "error handling",
    "security",
    "authentication",
    "authorization",
    "performance",
    "optimization",
    "scaling",
    "migration",
    "specification",
    "protocol",
    "standard",
    "algorithm",
    "data structure",
    "theorem",
    "proof",
    "methodology",
    "framework",
    "analysis",
    "evaluation",
    "definition",
    "notation",
    "terminology",
]

BOILERPLATE_PHRASES: list[str] = [
    "all rights reserved",
    "cookie policy",
    "cookie preferences",
    "privacy policy",
    "terms of service",
    "terms of use",
    "subscribe to our",
    "sign up for our",
    "follow us on",
    "connect with us",
    "skip to content",
    "skip to main",
    "back to top",
    "powered by",
    "share this",
    "tweet this",
    "share on",
]


# ═══════════════════════════════════════════════════════════════════════
# Data structures
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class GatePolicy:
    """Configuration for content gate decisions. Load from YAML or use defaults."""

    allow_path_signals: list[str] = field(default_factory=lambda: list(ALLOW_PATH_SIGNALS))
    block_path_signals: list[str] = field(default_factory=lambda: list(BLOCK_PATH_SIGNALS))
    blocked_extensions: frozenset[str] = BLOCKED_EXTENSIONS
    max_depth: int = 2
    min_page_quality: float = 0.35
    follow_threshold: float = 0.45
    marketing_phrases: list[str] = field(default_factory=lambda: list(MARKETING_PHRASES))
    epistemic_phrases: list[str] = field(default_factory=lambda: list(EPISTEMIC_PHRASES))
    allow_blog: bool = True
    allowed_hosts: list[str] = field(default_factory=list)
    allowed_prefixes: list[str] = field(default_factory=list)
    blocked_prefixes: list[str] = field(default_factory=list)
    min_chunk_quality: float = 0.25
    min_chunk_words: int = 30
    min_chunk_words_absolute: int = 8
    boilerplate_phrases: list[str] = field(default_factory=lambda: list(BOILERPLATE_PHRASES))

    @classmethod
    def from_yaml(cls, path: str) -> GatePolicy:
        """Load policy from a YAML file, merging with defaults."""
        from pathlib import Path

        import yaml

        p = Path(path)
        if not p.is_file():
            logger.warning("Policy file not found: %s — using defaults", path)
            return cls()

        try:
            data = yaml.safe_load(p.read_text()) or {}
        except Exception as e:
            logger.warning("Failed to load policy %s: %s — using defaults", path, e)
            return cls()

        kwargs: dict = {}
        for fld in cls.__dataclass_fields__:
            if fld in data:
                val = data[fld]
                if fld == "blocked_extensions":
                    val = frozenset(val)
                kwargs[fld] = val
        return cls(**kwargs)


@dataclass
class PageVerdict:
    """Result of page-level quality gate evaluation."""

    url: str
    canonical_url: str
    quality_score: float
    doc_type: str
    should_index: bool
    should_follow_children: bool
    rejection_reason: str


@dataclass
class ChunkVerdict:
    """Result of chunk-level quality gate evaluation."""

    quality_score: float
    should_index: bool
    rejection_reason: str


# ═══════════════════════════════════════════════════════════════════════
# Layer 1: URL normalization and filtering
# ═══════════════════════════════════════════════════════════════════════


def _url_matches_any_allowed_prefix(url: str, prefixes: list[str]) -> bool:
    """Match full URL or path against allowed_prefixes (supports https://… entries)."""
    u = url.strip()
    parsed = urlparse(u)
    path_l = parsed.path.lower()
    full_l = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".lower().rstrip("/")
    for raw in prefixes:
        p = (raw or "").strip()
        if not p:
            continue
        pl = p.lower().rstrip("/")
        if pl.startswith("http://") or pl.startswith("https://"):
            if u.lower().startswith(pl) or full_l.startswith(pl):
                return True
        elif path_l.startswith(pl.lower()):
            return True
    return False


def normalize_url(url: str) -> str:
    """Strip fragments, trailing slash, querystring, percent-decode."""
    parsed = urlparse(unquote(url.strip()))
    path = parsed.path.rstrip("/") or "/"
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            path,
            "",
            "",
            "",
        )
    )


def url_passes_filter(
    url: str,
    policy: GatePolicy,
    seed_host: str = "",
) -> tuple[bool, str]:
    """Check if URL passes allow/block rules. Returns (passes, reason)."""
    parsed = urlparse(url)
    path = parsed.path.lower()
    host = (parsed.hostname or "").lower()

    if seed_host and host and host != seed_host.lower():
        return False, f"off-host: {host} != {seed_host}"

    if policy.allowed_hosts and not any(h in host for h in policy.allowed_hosts):
        return False, f"host not in allowlist: {host}"

    for ext in policy.blocked_extensions:
        if path.endswith(ext):
            return False, f"blocked extension: {ext}"

    explicit_prefix_match = False
    if policy.allowed_prefixes:
        explicit_prefix_match = _url_matches_any_allowed_prefix(url, policy.allowed_prefixes)
        if not explicit_prefix_match:
            return False, f"not under allowed prefix: {url[:120]}"

    for bp in policy.blocked_prefixes:
        if path.startswith(bp):
            return False, f"blocked prefix: {bp}"

    if not policy.allow_blog and ("/blog" in path or "/news" in path):
        return False, "blog/news blocked by policy"

    # Explicit allowlist prefixes are curator-selected scope and should take
    # precedence over broad denylist path signals like "/blog".
    if not explicit_prefix_match:
        for sig in policy.block_path_signals:
            if sig in path:
                return False, f"blocked path signal: {sig}"

    return True, ""


# ═══════════════════════════════════════════════════════════════════════
# Layer 1: Page-level quality scoring
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class PageFeatures:
    """Extracted features from a page for scoring."""

    url_path: str = ""
    title: str = ""
    headings: list[str] = field(default_factory=list)
    word_count: int = 0
    code_block_count: int = 0
    heading_count: int = 0
    internal_link_count: int = 0
    total_link_count: int = 0
    text_sample: str = ""


def extract_page_features(html: str, url: str = "") -> PageFeatures:
    """Extract scoring features from HTML. Requires beautifulsoup4."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        logger.warning("beautifulsoup4 not installed — page scoring unavailable")
        return PageFeatures(url_path=urlparse(url).path)

    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    headings: list[str] = []
    for h in soup.find_all(re.compile(r"^h[1-3]$")):
        headings.append(h.get_text(strip=True))

    visible_text = soup.get_text(separator=" ", strip=True)
    words = visible_text.split()

    code_blocks = len(soup.find_all("pre")) + len(soup.find_all("code"))

    all_links = soup.find_all("a", href=True)
    seed_host = urlparse(url).hostname or ""
    internal_links = 0
    for a in all_links:
        href_host = urlparse(a["href"]).hostname
        if href_host is None or href_host == seed_host:
            internal_links += 1

    return PageFeatures(
        url_path=urlparse(url).path,
        title=title,
        headings=headings,
        word_count=len(words),
        code_block_count=code_blocks,
        heading_count=len(headings),
        internal_link_count=internal_links,
        total_link_count=len(all_links),
        text_sample=visible_text[:2000],
    )


def score_page(features: PageFeatures, policy: GatePolicy) -> float:
    """Score a page 0.0-1.0 based on weighted heuristics."""
    score = 0.0
    path_lower = features.url_path.lower()

    if any(sig in path_lower for sig in policy.allow_path_signals):
        score += 0.15

    title_lower = features.title.lower()
    _DOC_TITLE_TERMS = (
        "documentation",
        "guide",
        "reference",
        "tutorial",
        "api",
        "manual",
        "overview",
    )
    if any(t in title_lower for t in _DOC_TITLE_TERMS):
        score += 0.10

    if features.heading_count >= 2:
        score += 0.10
    elif features.heading_count >= 1:
        score += 0.05

    if features.code_block_count > 0:
        score += 0.10

    if 200 <= features.word_count <= 10000:
        score += 0.15
    elif 100 <= features.word_count < 200:
        score += 0.05

    if features.word_count < 100:
        score -= 0.15

    if features.total_link_count > 0:
        doc_link_ratio = features.internal_link_count / features.total_link_count
        if doc_link_ratio > 0.3:
            score += 0.05

    if features.word_count > 0:
        link_density = features.total_link_count / max(features.word_count / 50, 1)
        if link_density > 0.5:
            score -= 0.10

    text_lower = features.text_sample.lower()
    marketing_hits = sum(1 for p in policy.marketing_phrases if p in text_lower)
    if marketing_hits >= 3:
        score -= 0.20
    elif marketing_hits >= 1:
        score -= 0.10

    epistemic_hits = sum(1 for p in policy.epistemic_phrases if p in text_lower)
    if epistemic_hits >= 3:
        score += 0.10
    elif epistemic_hits >= 1:
        score += 0.05

    return max(0.0, min(1.0, score))


# ═══════════════════════════════════════════════════════════════════════
# Layer 1: Doc-type classification
# ═══════════════════════════════════════════════════════════════════════

DOC_TYPE_FOLLOWABLE: frozenset[str] = frozenset({"reference", "how_to", "tutorial", "explanation", "framework", "blog"})


def classify_doc_type(
    url: str,
    title: str,
    headings: list[str],
    text_sample: str = "",
) -> str:
    """Classify page into a doc type using deterministic rules."""
    path = urlparse(url).path.lower()
    title_lower = title.lower()
    h1 = headings[0].lower() if headings else ""
    all_h = " ".join(h.lower() for h in headings)

    if ("/api/" in path or "/reference/" in path) and any(
        kw in all_h for kw in ("parameters", "returns", "arguments", "endpoint", "method")
    ):
        return "reference"
    if "/reference" in path:
        return "reference"

    if "/how-to/" in path or title_lower.startswith("how to") or h1.startswith("how to"):
        return "how_to"

    if "/tutorial" in path or "tutorial" in title_lower or "getting started" in title_lower:
        return "tutorial"

    if "/blog/" in path or path == "/blog" or "/news/" in path:
        return "blog"

    _MARKETING_TITLES = {"pricing", "plans", "enterprise", "request a demo", "free trial"}
    if any(t in title_lower for t in _MARKETING_TITLES):
        return "marketing"

    if any(seg in path for seg in ("/terms", "/privacy", "/legal", "/cookies", "/tos")):
        return "legal"

    if any(seg in path for seg in ("/community", "/forum", "/discuss", "/forums")):
        return "community"

    if "arxiv.org" in url or "abstract" in h1:
        return "paper"

    if "/framework" in path or "framework" in title_lower:
        return "framework"

    if any(sig in path for sig in ("/docs/", "/guide/", "/learn/", "/concepts/")):
        return "explanation"

    return "explanation"


# ═══════════════════════════════════════════════════════════════════════
# Layer 1: Full page evaluation
# ═══════════════════════════════════════════════════════════════════════


def evaluate_page(
    url: str,
    html: str,
    policy: GatePolicy,
    depth: int = 0,
) -> PageVerdict:
    """Full page-level evaluation: features -> score -> type -> verdict."""
    canonical = normalize_url(url)
    features = extract_page_features(html, url)
    quality = score_page(features, policy)
    doc_type = classify_doc_type(url, features.title, features.headings, features.text_sample)

    should_index = True
    rejection_reason = ""

    if quality < policy.min_page_quality:
        should_index = False
        rejection_reason = f"quality {quality:.2f} < threshold {policy.min_page_quality}"
    elif doc_type in ("marketing", "legal"):
        should_index = False
        rejection_reason = f"doc_type={doc_type}"
    elif doc_type == "blog" and not policy.allow_blog:
        should_index = False
        rejection_reason = "blog content not allowed"
    elif doc_type == "community":
        should_index = False
        rejection_reason = "community/forum content excluded"

    # Seed pages for curated prefixes should still be traversable even when
    # their index/list page quality is low, because child pages often contain
    # the actual high-signal content.
    is_curated_seed = bool(policy.allowed_prefixes and _url_matches_any_allowed_prefix(url, policy.allowed_prefixes))
    follow_quality_ok = quality >= policy.follow_threshold or (is_curated_seed and depth == 0)
    should_follow = follow_quality_ok and doc_type in DOC_TYPE_FOLLOWABLE and depth < policy.max_depth

    return PageVerdict(
        url=url,
        canonical_url=canonical,
        quality_score=quality,
        doc_type=doc_type,
        should_index=should_index,
        should_follow_children=should_follow,
        rejection_reason=rejection_reason,
    )


# ═══════════════════════════════════════════════════════════════════════
# Thin-content rescue signals
#
# Short chunks (<min_chunk_words) that contain structural value markers
# are rescued instead of dropped. Distinguishes "thin but valuable"
# (code, formulas, tables, definitions) from "thin and worthless"
# (boilerplate, nav, legal).
# ═══════════════════════════════════════════════════════════════════════

_CODE_FENCE_RE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~", re.MULTILINE)
_INDENTED_CODE_RE = re.compile(r"(?:^    \S.+$\n?){2,}", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`[^`]+`")
_MATH_BLOCK_RE = re.compile(r"\$\$.+?\$\$", re.DOTALL)
_MATH_INLINE_RE = re.compile(r"(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)")
_LATEX_CMD_RE = re.compile(
    r"\\(?:frac|sum|int|prod|lim|begin|end|alpha|beta|gamma|theta|lambda|sigma|nabla|partial|infty|sqrt|mathbb|mathrm|text)\b"
)
_TABLE_ROW_RE = re.compile(r"^\|.+\|$", re.MULTILINE)
_DEFINITION_RE = re.compile(r"(?:^|\n)\s*(?:\*\*[^*]+\*\*|__[^_]+__)\s*[:\u2014\u2013\-]", re.MULTILINE)
_CLI_FLAG_RE = re.compile(r"(?:^|\s)--?\w[\w-]*(?:=\S+)?")
_FIGURE_REF_RE = re.compile(r"(?:Figure|Table|Equation|Fig\.|Eq\.)\s+\d+", re.IGNORECASE)
# Structured reference rescue: headings and API/example markers (legitimate short technical chunks)
_HEADING_LINE_RE = re.compile(r"^(?:#{1,6}\s+.+|\*\*[^*]+\*\*\s*$|__[^_]+__\s*$)", re.MULTILINE)
_API_EXAMPLE_RE = re.compile(
    r"\b(?:parameters?|returns?|arguments?|endpoint|method|syntax|signature|api\s*reference"
    r"|(?:example|sample)\s+(?:code|output|request|response|usage|query|config))\b",
    re.IGNORECASE,
)


@dataclass
class RescueResult:
    """Outcome of thin-content rescue signal detection."""

    signals: list[str]
    bonus: float
    has_code: bool = False
    has_formula: bool = False


def _detect_rescue_signals(text: str) -> RescueResult:
    """Check a thin chunk for structural value markers that justify indexing."""
    signals: list[str] = []
    bonus = 0.0

    if _CODE_FENCE_RE.search(text) or _INDENTED_CODE_RE.search(text):
        signals.append("code_block")
        bonus += 0.15

    inline_code_count = len(_INLINE_CODE_RE.findall(text))
    word_count = len(text.split())
    if inline_code_count >= 3 or (word_count > 0 and inline_code_count / max(word_count, 1) > 0.15):
        signals.append("inline_code")
        bonus += 0.10

    if _MATH_BLOCK_RE.search(text) or _MATH_INLINE_RE.search(text) or _LATEX_CMD_RE.search(text):
        signals.append("formula")
        bonus += 0.15

    table_rows = len(_TABLE_ROW_RE.findall(text))
    if table_rows >= 2:
        signals.append("table")
        bonus += 0.10

    if _DEFINITION_RE.search(text):
        signals.append("definition")
        bonus += 0.08

    cli_flags = len(_CLI_FLAG_RE.findall(text))
    if cli_flags >= 2:
        signals.append("cli")
        bonus += 0.10

    if _FIGURE_REF_RE.search(text):
        signals.append("figure_ref")
        bonus += 0.05

    if _HEADING_LINE_RE.search(text):
        signals.append("heading")
        bonus += 0.06

    if _API_EXAMPLE_RE.search(text):
        signals.append("api_example")
        bonus += 0.08

    has_code = "code_block" in signals or "inline_code" in signals
    has_formula = "formula" in signals

    return RescueResult(
        signals=signals,
        bonus=min(bonus, 0.30),
        has_code=has_code,
        has_formula=has_formula,
    )


# ═══════════════════════════════════════════════════════════════════════
# Layer 2: Chunk-level quality scoring (universal — all handlers)
# ═══════════════════════════════════════════════════════════════════════

_SENTENCE_RE = re.compile(r"[.!?]\s+[A-Z]")
_URL_RE = re.compile(r"https?://\S+")


def score_chunk(
    text: str,
    section: str = "",
    heading_path: str = "",
    policy: GatePolicy | None = None,
) -> ChunkVerdict:
    """Universal chunk quality check. Runs for ALL handlers in pipeline."""
    if policy is None:
        policy = GatePolicy()

    text_lower = text.lower()
    words = text.split()
    word_count = len(words)
    score = 0.0

    if word_count < policy.min_chunk_words:
        rescue = _detect_rescue_signals(text)
        boilerplate_hits = sum(1 for p in policy.boilerplate_phrases if p in text_lower)

        if word_count < policy.min_chunk_words_absolute:
            if not rescue.has_code and not rescue.has_formula:
                return ChunkVerdict(
                    quality_score=0.0,
                    should_index=False,
                    rejection_reason=f"thin+empty: {word_count} words < {policy.min_chunk_words_absolute}",
                )

        if rescue.signals:
            rescued_score = 0.10 + rescue.bonus
            return ChunkVerdict(
                quality_score=rescued_score,
                should_index=True,
                rejection_reason="",
            )

        if boilerplate_hits > 0:
            return ChunkVerdict(
                quality_score=0.0,
                should_index=False,
                rejection_reason=f"thin+boilerplate: {word_count} words, {boilerplate_hits} boilerplate hits",
            )

        if word_count < 15:
            return ChunkVerdict(
                quality_score=0.0,
                should_index=False,
                rejection_reason=f"thin+short: {word_count} words, no rescue signals",
            )

        return ChunkVerdict(
            quality_score=0.10,
            should_index=True,
            rejection_reason="",
        )

    if 50 <= word_count <= 5000:
        score += 0.20
    elif policy.min_chunk_words <= word_count < 50:
        score += 0.10

    if _SENTENCE_RE.search(text):
        score += 0.10

    epistemic_hits = sum(1 for p in policy.epistemic_phrases if p in text_lower)
    if epistemic_hits >= 2:
        score += 0.15
    elif epistemic_hits >= 1:
        score += 0.08

    marketing_hits = sum(1 for p in policy.marketing_phrases if p in text_lower)
    if marketing_hits >= 3:
        score -= 0.25
    elif marketing_hits >= 1:
        score -= 0.12

    boilerplate_hits = sum(1 for p in policy.boilerplate_phrases if p in text_lower)

    # Structural signal: heading_path, section, strong epistemic content, or
    # code/table/definition markers.  When present, cap the boilerplate penalty
    # so incidental "contact us" in an otherwise good doc chunk does not force
    # rejection.  Truly junk-heavy chunks (boilerplate ratio > 20%) still get
    # the full penalty.
    has_structural_signal = bool(
        section
        or heading_path
        or epistemic_hits >= 2
        or _CODE_FENCE_RE.search(text)
        or _TABLE_ROW_RE.search(text)
        or _DEFINITION_RE.search(text)
    )
    junk_heavy = word_count > 0 and boilerplate_hits / max(word_count / 30, 1) > 0.2
    if has_structural_signal and not junk_heavy:
        effective_bp_hits = min(boilerplate_hits, 1)
    else:
        effective_bp_hits = boilerplate_hits

    if effective_bp_hits >= 3:
        score -= 0.20
    elif effective_bp_hits >= 1:
        score -= 0.08

    url_count = len(_URL_RE.findall(text))
    if word_count > 0 and url_count / max(word_count / 20, 1) > 0.5:
        score -= 0.10

    if section or heading_path:
        score += 0.05

    score = max(0.0, min(1.0, score))

    if score < policy.min_chunk_quality:
        parts = [f"chunk quality {score:.2f} < {policy.min_chunk_quality}"]
        if marketing_hits >= 1:
            parts.append(f"marketing:{marketing_hits}")
        if boilerplate_hits >= 1:
            parts.append(f"boilerplate:{boilerplate_hits}")
        return ChunkVerdict(
            quality_score=score,
            should_index=False,
            rejection_reason=" | ".join(parts),
        )

    return ChunkVerdict(quality_score=score, should_index=True, rejection_reason="")
