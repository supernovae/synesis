"""Low-latency query normalization and typo correction.

Deterministic preprocessing pipeline that:
1. Normalizes whitespace and Unicode
2. Detects protected tokens (code, URLs, versions, jargon)
3. Flags suspicious tokens via OOV + edit-distance heuristics
4. Generates correction candidates from the domain lexicon
5. Scores and selects the best candidate above a confidence threshold

The domain lexicon is compiled once at startup from existing config
(intent_weights keywords, taxonomy query_expansion_hints, plugin keywords).
No LLM calls, no network, no new dependencies — stdlib only.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher, get_close_matches
from typing import Any

logger = logging.getLogger("synesis.query_normalizer")

# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CorrectionCandidate:
    text: str
    score: float
    changed_tokens: tuple[tuple[str, str], ...]
    reason: str


@dataclass(frozen=True)
class QueryNormalization:
    original_query: str
    normalized_query: str
    corrected_query_candidates: tuple[CorrectionCandidate, ...]
    selected_query: str
    correction_confidence: float
    correction_reason: str
    changed_tokens: tuple[str, ...]
    protected_tokens: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Protected token patterns — tokens matching these are never corrected
# ---------------------------------------------------------------------------

_PROTECTED_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^https?://"),
    re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"),
    re.compile(r"^[a-z]+[A-Z]\w*$"),
    re.compile(r"^\w+_\w+_\w*$"),
    re.compile(r"^[a-z]+-[a-z]+-[a-z]"),
    re.compile(r"^v?\d+\.\d+"),
    re.compile(r"[/\\]"),
    re.compile(r"^\.\w+$"),
    re.compile(r"^[A-Z][A-Z0-9_]{2,}$"),
    re.compile(r"^\d+$"),
    re.compile(r"^__\w+__$"),
    re.compile(r"^-{1,2}\w"),
]

_REPEATED_CHAR_RE = re.compile(r"(.)\1{2,}")
_WORD_TOKEN_RE = re.compile(r"[a-zA-Z0-9_.\-]+|[^\s]")
_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff\u00ad]")

# Common English words — a small set covering frequent terms that should
# not be flagged as OOV. Kept minimal; the domain lexicon covers tech terms.
_COMMON_ENGLISH = frozenset(
    w.strip()
    for w in ["a", "about", "above", "accept", "access", "across", "act", "action", "actual", "add", "added", "after", "again", "against", "age", "ago", "agree", "ahead", "allow", "almost", "along", "already", "also", "always", "am", "among", "amount", "an", "and", "another", "answer", "any", "anyone", "anything", "appear", "approach", "area", "aren't", "around", "as", "ask", "at", "available", "away", "back", "bad", "base", "based", "be", "because", "become", "been", "before", "began", "begin", "behind", "being", "believe", "below", "best", "better", "between", "big", "bit", "body", "book", "both", "bring", "brought", "build", "building", "built", "business", "but", "buy", "by", "call", "came", "can", "can't", "cannot", "care", "case", "cause", "certain", "change", "changed", "check", "child", "children", "choice", "choose", "city", "claim", "class", "clear", "close", "code", "come", "common", "community", "company", "compare", "complete", "computer", "concern", "condition", "connect", "consider", "contain", "continue", "control", "cost", "could", "couldn't", "country", "course", "cover", "create", "current", "cut", "data", "day", "deal", "decide", "decision", "deep", "describe", "design", "detail", "develop", "development", "did", "didn't", "difference", "different", "difficult", "direction", "discover", "do", "does", "doesn't", "doing", "don't", "door", "down", "draw", "drive", "drop", "during", "each", "early", "east", "easy", "economic", "economy", "edge", "effect", "effort", "eight", "either", "else", "end", "energy", "enough", "enter", "entire", "environment", "especially", "even", "evening", "event", "eventually", "ever", "every", "everyone", "everything", "evidence", "example", "exist", "expect", "experience", "explain", "face", "fact", "fall", "family", "far", "fast", "feel", "few", "field", "fight", "figure", "fill", "final", "finally", "find", "fine", "finish", "first", "five", "floor", "follow", "food", "for", "force", "form", "forward", "found", "four", "free", "friend", "from", "front", "full", "fund", "further", "game", "gave", "general", "generate", "get", "girl", "give", "glass", "go", "goal", "going", "gone", "good", "got", "government", "great", "green", "group", "grow", "growth", "guess", "guy", "had", "hadn't", "half", "hand", "happen", "hard", "has", "hasn't", "have", "haven't", "having", "he", "head", "health", "hear", "heart", "heavy", "help", "her", "here", "here's", "herself", "high", "him", "himself", "his", "history", "hit", "hold", "home", "hope", "hot", "hotel", "hour", "house", "how", "how's", "however", "huge", "human", "hundred", "idea", "if", "image", "imagine", "impact", "important", "improve", "in", "include", "increase", "indeed", "indicate", "industry", "information", "inside", "instead", "interest", "into", "involve", "is", "isn't", "issue", "it", "it's", "item", "its", "itself", "job", "join", "just", "keep", "key", "kid", "kind", "know", "knowledge", "land", "language", "large", "last", "late", "later", "lead", "learn", "least", "leave", "left", "less", "let", "let's", "level", "life", "light", "like", "likely", "line", "list", "listen", "little", "live", "long", "look", "lose", "loss", "lot", "low", "machine", "made", "main", "maintain", "major", "make", "manage", "management", "many", "market", "material", "matter", "may", "maybe", "me", "mean", "measure", "meet", "member", "memory", "mention", "method", "might", "million", "mind", "minute", "miss", "model", "modern", "moment", "money", "month", "more", "morning", "most", "move", "movement", "much", "must", "my", "myself", "name", "natural", "near", "nearly", "necessary", "need", "network", "never", "new", "news", "next", "nice", "night", "no", "none", "nor", "north", "not", "note", "nothing", "notice", "now", "number", "occur", "of", "off", "offer", "office", "often", "oh", "ok", "old", "on", "once", "one", "only", "open", "operation", "option", "or", "order", "organization", "other", "others", "our", "out", "outside", "over", "own", "page", "part", "particular", "particularly", "partner", "party", "pass", "past", "pattern", "pay", "people", "per", "performance", "perhaps", "period", "person", "pick", "picture", "piece", "place", "plan", "play", "player", "please", "point", "policy", "political", "poor", "popular", "position", "positive", "possible", "power", "practice", "prepare", "present", "pressure", "pretty", "prevent", "price", "private", "probably", "problem", "process", "produce", "product", "production", "professional", "program", "project", "property", "prove", "provide", "public", "pull", "purpose", "push", "put", "quality", "question", "quickly", "quite", "range", "rate", "rather", "reach", "read", "ready", "real", "reality", "realize", "really", "reason", "receive", "recent", "recently", "record", "red", "reduce", "reflect", "region", "relate", "relationship", "remain", "remember", "remove", "report", "represent", "require", "research", "resource", "respond", "response", "rest", "result", "return", "reveal", "right", "rise", "risk", "road", "rock", "role", "room", "rule", "run", "safe", "same", "save", "say", "scene", "school", "science", "score", "sea", "season", "seat", "second", "section", "security", "see", "seek", "seem", "sell", "send", "senior", "sense", "series", "serious", "serve", "service", "set", "setting", "setup", "seven", "several", "shake", "shall", "shape", "share", "she", "short", "shot", "should", "shouldn't", "show", "side", "sign", "significant", "similar", "simple", "simply", "since", "single", "sit", "site", "situation", "six", "size", "skill", "small", "so", "social", "society", "soldier", "some", "someone", "something", "sometimes", "son", "soon", "sort", "source", "south", "space", "speak", "special", "specific", "speech", "spend", "stage", "stand", "standard", "start", "state", "statement", "station", "stay", "step", "still", "stock", "stop", "store", "story", "strategy", "street", "strong", "structure", "student", "study", "stuff", "style", "subject", "success", "such", "suddenly", "suffer", "suggest", "summer", "support", "sure", "surface", "system", "table", "take", "talk", "task", "teach", "team", "technology", "tell", "ten", "tend", "term", "test", "than", "thank", "that", "that's", "the", "their", "them", "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've", "thing", "think", "third", "this", "those", "though", "thought", "thousand", "threat", "three", "through", "throughout", "throw", "thus", "time", "to", "today", "together", "tonight", "too", "top", "total", "tough", "toward", "town", "trade", "traditional", "training", "travel", "treat", "treatment", "tree", "trial", "trip", "trouble", "true", "truth", "try", "turn", "tv", "twelve", "two", "type", "under", "understand", "unit", "until", "up", "upon", "us", "use", "used", "using", "usually", "value", "various", "very", "view", "violence", "visit", "voice", "vote", "wait", "walk", "wall", "want", "war", "watch", "water", "way", "we", "we'd", "we'll", "we're", "we've", "weapon", "wear", "week", "weight", "well", "were", "weren't", "west", "western", "what", "what's", "when", "when's", "where", "where's", "whether", "which", "while", "white", "who", "who's", "whole", "whom", "why", "why's", "wide", "wife", "will", "win", "wind", "window", "wish", "with", "within", "without", "woman", "wonder", "won't", "word", "work", "worker", "working", "world", "worry", "would", "wouldn't", "write", "writer", "wrong", "yeah", "year", "yes", "yet", "you", "you'd", "you'll", "you're", "you've", "young", "your", "yours", "yourself", "yourselves", "able", "account", "achieve", "acknowledge", "activity", "actually", "address", "adjust", "administration", "advantage", "advertising", "advice", "affect", "afford", "agree", "agreement", "analysis", "analyze", "apply", "argument", "arrange", "assessment", "assign", "assumption", "attempt", "attention", "attract", "author", "automatic", "aware", "background", "base", "basis", "begin", "behavior", "belief", "belong", "beneath", "benefit", "besides", "beyond", "block", "board", "borrow", "bottom", "brain", "branch", "break", "broad", "broken", "budget", "build", "button", "calculate", "campaign", "candidate", "capable", "capacity", "capture", "category", "challenge", "channel", "chapter", "characteristic", "charge", "chemical", "chief", "circle", "citizen", "claim", "classic", "clean", "client", "climb", "collection", "combine", "comfortable", "comment", "commission", "commit", "communication", "comparison", "compete", "competition", "complex", "complexity", "component", "comprehensive", "concept", "conduct", "confidence", "confirm", "conflict", "connect", "connection", "consequence", "consistent", "constant", "construct", "consumer", "contact", "context", "contract", "contrast", "contribute", "conversation", "convert", "convince", "corporate", "correct", "correspond", "coverage", "crash", "creative", "credit", "crisis", "critical", "cross", "cultural", "customer", "cycle", "damage", "data", "deal", "debate", "debt", "decade", "decline", "deeply", "define", "definition", "degree", "delay", "deliver", "delivery", "demand", "demonstrate", "depend", "deposit", "depression", "derive", "describe", "description", "deserve", "determine", "developing", "device", "digital", "dimension", "discipline", "display", "distance", "distinction", "distribute", "distribution", "district", "document", "domestic", "dominant", "double", "draft", "dramatic", "drop", "due", "earn", "eastern", "editor", "education", "educational", "effective", "effectively", "efficient", "electronic", "element", "eliminate", "emergency", "emotional", "emphasis", "employ", "employee", "employer", "enable", "encourage", "engineering", "enhance", "enormous", "ensure", "enterprise", "entertainment", "entirely", "entrance", "entry", "environment", "episode", "equal", "equipment", "error", "escape", "essential", "establish", "estimate", "evaluate", "evaluation", "eventually", "evidence", "evolve", "examine", "exchange", "executive", "exercise", "exhibit", "exhibition", "expand", "expansion", "expense", "expensive", "experiment", "expert", "explanation", "expose", "expression", "extend", "extension", "extensive", "external", "extraordinary", "extreme", "facility", "factor", "failure", "familiar", "fashion", "feature", "federal", "female", "finance", "financial", "finding", "fix", "flight", "focus", "football", "foreign", "forever", "forget", "formal", "formation", "formula", "forward", "foundation", "framework", "frequency", "frequently", "fully", "function", "fundamental", "gain", "generation", "global", "gradually", "grant", "guide", "handling", "headline", "height", "helpful", "hidden", "historical", "hold", "host", "household", "housing", "identity", "ignore", "illustrate", "image", "imagination", "immediate", "impact", "implement", "implementation", "implication", "import", "impossible", "impression", "improve", "improvement", "incident", "income", "incorporate", "independence", "independent", "indication", "individual", "industrial", "inevitable", "influence", "inform", "information", "initial", "initiative", "injury", "innovation", "input", "inquiry", "install", "instance", "institute", "institution", "instrument", "insurance", "intellectual", "intelligence", "intend", "intention", "interaction", "interest", "internal", "interpret", "interpretation", "intervention", "introduce", "introduction", "investigation", "investment", "investor", "involvement", "isolation", "item", "journal", "judgment", "junior", "jury", "justice", "justify", "keen", "label", "labor", "landscape", "largely", "launch", "layer", "leadership", "legal", "legislation", "lesson", "liberal", "lifestyle", "limitation", "literature", "load", "loan", "local", "location", "loss", "maintain", "maintenance", "management", "manufacturer", "manufacturing", "margin", "mark", "market", "marketing", "mass", "massive", "match", "media", "medium", "membership", "mental", "merely", "metal", "military", "minor", "minority", "mission", "mixture", "mobile", "modification", "moment", "monitor", "moral", "motion", "mount", "multiple", "myth", "narrow", "national", "navigate", "negotiation", "neighborhood", "nerve", "nice", "nonetheless", "normal", "notion", "novel", "numerous", "objective", "observation", "observe", "obtain", "obvious", "occupation", "offense", "offering", "official", "opening", "operate", "operator", "opponent", "opposition", "ordinary", "organize", "orientation", "origin", "original", "otherwise", "outcome", "output", "overall", "overcome", "overlook", "overview", "ownership", "participate", "participation", "partnership", "passage", "passenger", "patient", "perspective", "phase", "phenomenon", "philosophy", "photo", "phrase", "physical", "planning", "platform", "pleasure", "pocket", "poll", "popularity", "portion", "possibility", "potential", "poverty", "powerful", "practical", "predict", "preference", "preparation", "presence", "preserve", "presidential", "previously", "primarily", "primary", "principle", "priority", "procedure", "proceed", "processing", "profession", "professor", "profile", "profit", "programming", "progress", "promote", "promotion", "proportion", "proposal", "propose", "prospect", "protect", "protection", "province", "provision", "psychological", "publication", "pursue", "qualify", "reaction", "recognition", "recommend", "recommendation", "recording", "recovery", "reduction", "reference", "reflection", "reform", "regional", "regulation", "reinforce", "rejection", "relation", "relative", "relatively", "relevance", "relief", "rely", "remaining", "remarkable", "repeat", "replace", "replacement", "representation", "republic", "reputation", "requirement", "resolution", "resolve", "resort", "restriction", "retain", "retire", "retirement", "revenue", "reverse", "revolution", "reward", "rhythm", "root", "rotate", "routine", "rural", "salary", "satisfaction", "satisfy", "scenario", "schedule", "scheduling", "scope", "screen", "secondary", "secret", "sector", "segment", "selection", "sensitive", "separate", "sequence", "session", "settlement", "severe", "shift", "significance", "similarly", "situation", "slightly", "somehow", "somewhat", "specialist", "specification", "spirit", "spiritual", "split", "sponsor", "stability", "standards", "statistics", "steady", "stem", "stimulus", "stock", "strain", "strategic", "strength", "strike", "struggle", "submit", "subsequent", "substance", "substantial", "successfully", "sufficient", "survive", "suspect", "sustain", "symbol", "talent", "targeted", "technique", "temporary", "tendency", "tension", "territory", "theme", "thereby", "threat", "threaten", "tissue", "toll", "topic", "totally", "touch", "track", "tradition", "transform", "transition", "transmission", "transportation", "tremendous", "trend", "trigger", "triumph", "troop", "ultimate", "ultimately", "undergo", "underlying", "unemployment", "unique", "universal", "upper", "urban", "utility", "valuable", "variation", "variety", "vast", "venture", "version", "via", "virtually", "visual", "vital", "volume", "voluntary", "vulnerable", "wage", "wealth", "weapon", "weekly", "welfare", "whereas", "widespread", "willing", "witness", "wooden", "worth"]
    if w
)

# ---------------------------------------------------------------------------
# Keyboard adjacency for transposition detection
# ---------------------------------------------------------------------------

_KEYBOARD_NEIGHBORS: dict[str, str] = {}
_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
for _row in _ROWS:
    for _i, _ch in enumerate(_row):
        neighbors = ""
        if _i > 0:
            neighbors += _row[_i - 1]
        if _i < len(_row) - 1:
            neighbors += _row[_i + 1]
        _KEYBOARD_NEIGHBORS[_ch] = neighbors


# ---------------------------------------------------------------------------
# Lexicon builder
# ---------------------------------------------------------------------------


def build_lexicon(
    intent_config: dict[str, Any],
    taxonomy_config: dict[str, Any],
) -> frozenset[str]:
    """Compile domain vocabulary from existing configs into a correction lexicon.

    Pulls keywords from domain_keywords, complexity_weights, risk_weights,
    and taxonomy query_expansion_hints — all already loaded at startup.
    Multi-word phrases are split into individual tokens so that edit-distance
    matching works token-by-token.
    """
    terms: set[str] = set()

    for section in ("domain_keywords", "complexity_weights", "risk_weights", "brevity_weights"):
        for cat_data in (intent_config.get(section) or {}).values():
            if isinstance(cat_data, dict):
                for kw in cat_data.get("keywords", []):
                    if isinstance(kw, str):
                        for word in kw.lower().split():
                            if len(word) > 1:
                                terms.add(word)

    for entry in (taxonomy_config or {}).values():
        if isinstance(entry, dict):
            for hint in entry.get("query_expansion_hints", []):
                if isinstance(hint, str):
                    for word in hint.lower().split():
                        if len(word) > 1:
                            terms.add(word)

    terms.update(_COMMON_ENGLISH)
    return frozenset(terms)


# ---------------------------------------------------------------------------
# QueryNormalizer
# ---------------------------------------------------------------------------


class QueryNormalizer:
    """Deterministic query normalizer with domain-aware typo correction.

    Initialized once at startup with the compiled domain lexicon.
    The ``normalize()`` method is the hot-path entry point (~1-5ms).
    """

    def __init__(
        self,
        lexicon: frozenset[str],
        *,
        max_corrected_tokens: int = 3,
        min_token_length: int = 3,
        edit_distance_cutoff: float = 0.7,
        confidence_threshold: float = 0.6,
        max_candidates_per_token: int = 3,
        extra_protected_patterns: list[re.Pattern[str]] | None = None,
        extra_jargon: frozenset[str] | None = None,
    ) -> None:
        self._lexicon = lexicon
        self._lexicon_list = sorted(lexicon)
        self._max_corrected = max_corrected_tokens
        self._min_token_len = min_token_length
        self._cutoff = edit_distance_cutoff
        self._confidence_threshold = confidence_threshold
        self._max_candidates = max_candidates_per_token
        self._protected_patterns = list(_PROTECTED_PATTERNS)
        if extra_protected_patterns:
            self._protected_patterns.extend(extra_protected_patterns)
        self._jargon = extra_jargon or frozenset()

        logger.info(
            "query_normalizer_initialized",
            extra={"lexicon_size": len(lexicon), "jargon_size": len(self._jargon)},
        )

    # -- Preprocessing ------------------------------------------------------

    @staticmethod
    def _preprocess(raw: str) -> str:
        text = _ZERO_WIDTH_RE.sub("", raw)
        text = unicodedata.normalize("NFKC", text)
        text = re.sub(r"[\u2018\u2019\u201a\u201b]", "'", text)
        text = re.sub(r"[\u2010\u2011\u2012\u2013\u2014\u2015]", "-", text)
        text = re.sub(r"[\u201c\u201d\u201e\u201f]", '"', text)
        text = re.sub(r"[ \t]+", " ", text).strip()
        return text

    # -- Tokenization -------------------------------------------------------

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return _WORD_TOKEN_RE.findall(text)

    # -- Protected detection ------------------------------------------------

    def _is_protected(self, token: str) -> bool:
        t = token.lower()
        if t in self._jargon:
            return True
        return any(pat.search(token) for pat in self._protected_patterns)

    # -- Path-adjacent detection ---------------------------------------------

    @staticmethod
    def _mark_path_adjacent(tokens: list[str]) -> list[bool]:
        """Mark tokens that are part of a file path (adjacent to / or \\)."""
        n = len(tokens)
        adj = [False] * n
        for i, tok in enumerate(tokens):
            if tok in ("/", "\\"):
                adj[i] = True
                if i > 0:
                    adj[i - 1] = True
                if i < n - 1:
                    adj[i + 1] = True
        return adj

    # -- Suspicious flagging ------------------------------------------------

    def _is_suspicious(self, token: str) -> bool:
        t = token.lower()
        if len(t) < self._min_token_len:
            return False
        if t in self._lexicon or t in _COMMON_ENGLISH:
            return False
        if self._is_morphological_variant(t, self._lexicon):
            return False
        if _REPEATED_CHAR_RE.search(t):
            return True
        if self._has_transposition_match(t):
            return True
        close = get_close_matches(t, self._lexicon_list, n=1, cutoff=0.85)
        return bool(close and close[0] != t)

    @staticmethod
    def _is_morphological_variant(token: str, lexicon: frozenset[str]) -> bool:
        """Return True if the token looks like a standard English inflection
        of a known word (plural, past tense, gerund, comparative, adverb).
        Checks both common English vocabulary and the domain lexicon.
        Prevents correcting 'containers' to 'container', 'deployments' to
        'deployment', etc."""
        known = _COMMON_ENGLISH | lexicon
        for suffix in ("s", "es", "ed", "ing", "er", "ers", "est", "ly",
                        "tion", "sion", "ment", "ness", "ity", "ies", "ous"):
            if token.endswith(suffix) and len(token) > len(suffix) + 2:
                stem = token[: -len(suffix)]
                if stem in known:
                    return True
        # Also check the reverse: token itself is a known stem, don't flag
        # e.g. "microservice" when "microservices" is in the lexicon
        return any((token + suffix) in lexicon for suffix in ("s", "es", "ed", "ing"))

    def _has_transposition_match(self, token: str) -> bool:
        for i in range(len(token) - 1):
            swapped = token[:i] + token[i + 1] + token[i] + token[i + 2:]
            if swapped in self._lexicon:
                return True
        return False

    # -- Candidate generation -----------------------------------------------

    def _generate_candidates(self, token: str) -> list[tuple[str, float]]:
        t = token.lower()
        candidates: list[tuple[str, float]] = []

        close = get_close_matches(t, self._lexicon_list, n=self._max_candidates, cutoff=self._cutoff)
        for match in close:
            ratio = SequenceMatcher(None, t, match).ratio()
            candidates.append((match, ratio))

        for i in range(len(t) - 1):
            swapped = t[:i] + t[i + 1] + t[i] + t[i + 2:]
            if swapped in self._lexicon and swapped not in {c[0] for c in candidates}:
                candidates.append((swapped, 0.95))

        deduped = t[:1] + re.sub(r"(.)\1+", r"\1", t[1:])
        if deduped != t and deduped in self._lexicon and deduped not in {c[0] for c in candidates}:
            candidates.append((deduped, 0.85))

        candidates.sort(key=lambda x: x[1], reverse=True)
        return candidates[: self._max_candidates]

    # -- Scoring ------------------------------------------------------------

    def _score_candidate(
        self,
        original: str,
        candidate: str,
        candidates_for_token: list[tuple[str, float]],
    ) -> float:
        base_ratio = SequenceMatcher(None, original.lower(), candidate).ratio()

        domain_bonus = 0.1 if candidate in self._lexicon else 0.0

        ambiguity_penalty = 0.0
        if len(candidates_for_token) > 1:
            scores = [c[1] for c in candidates_for_token]
            if len(scores) >= 2 and abs(scores[0] - scores[1]) < 0.05:
                ambiguity_penalty = 0.2

        score = base_ratio + domain_bonus - ambiguity_penalty
        return min(1.0, max(0.0, score))

    # -- Main entry point ---------------------------------------------------

    def normalize(self, raw: str) -> QueryNormalization:
        """Normalize and optionally correct a user query.

        Returns a QueryNormalization with the original, normalized,
        and (if warranted) corrected query.
        """
        if not raw or not raw.strip():
            return QueryNormalization(
                original_query=raw,
                normalized_query=raw,
                corrected_query_candidates=(),
                selected_query=raw,
                correction_confidence=1.0,
                correction_reason="",
                changed_tokens=(),
                protected_tokens=(),
            )

        normalized = self._preprocess(raw)
        tokens = self._tokenize(normalized)

        protected: list[str] = []
        suspicious: list[int] = []

        path_adjacent = self._mark_path_adjacent(tokens)

        for i, tok in enumerate(tokens):
            if path_adjacent[i] or self._is_protected(tok):
                protected.append(tok)
            elif self._is_suspicious(tok):
                suspicious.append(i)

        if not suspicious:
            return QueryNormalization(
                original_query=raw,
                normalized_query=normalized,
                corrected_query_candidates=(),
                selected_query=normalized,
                correction_confidence=1.0,
                correction_reason="",
                changed_tokens=(),
                protected_tokens=tuple(protected),
            )

        token_replacements: list[tuple[int, str, str, float]] = []

        for idx in suspicious[: self._max_corrected]:
            orig_tok = tokens[idx]
            candidates = self._generate_candidates(orig_tok)
            if not candidates:
                continue

            best_match, _best_ratio = candidates[0]
            score = self._score_candidate(orig_tok, best_match, candidates)

            if score >= self._confidence_threshold and best_match != orig_tok.lower():
                token_replacements.append((idx, orig_tok, best_match, score))

        if not token_replacements:
            return QueryNormalization(
                original_query=raw,
                normalized_query=normalized,
                corrected_query_candidates=(),
                selected_query=normalized,
                correction_confidence=1.0,
                correction_reason="",
                changed_tokens=(),
                protected_tokens=tuple(protected),
            )

        # Build corrected query
        corrected_tokens = list(tokens)
        changed: list[str] = []
        changed_pairs: list[tuple[str, str]] = []
        reasons: list[str] = []
        min_score = 1.0

        for idx, orig, replacement, score in token_replacements:
            if orig[0].isupper() and not orig.isupper():
                replacement = replacement.capitalize()
            elif orig.isupper():
                replacement = replacement.upper()
            corrected_tokens[idx] = replacement
            changed.append(orig)
            changed_pairs.append((orig, replacement))
            reasons.append(f"{orig}->{replacement}")
            min_score = min(min_score, score)

        corrected_text = self._rebuild(tokens, corrected_tokens, normalized)

        candidate = CorrectionCandidate(
            text=corrected_text,
            score=min_score,
            changed_tokens=tuple(changed_pairs),
            reason="; ".join(reasons),
        )

        logger.info(
            "query_normalization",
            extra={
                "corrected": True,
                "changed_tokens": changed,
                "confidence": round(min_score, 3),
                "protected_tokens": protected,
                "candidate_count": 1,
            },
        )

        return QueryNormalization(
            original_query=raw,
            normalized_query=normalized,
            corrected_query_candidates=(candidate,),
            selected_query=corrected_text,
            correction_confidence=min_score,
            correction_reason=candidate.reason,
            changed_tokens=tuple(changed),
            protected_tokens=tuple(protected),
        )

    @staticmethod
    def _rebuild(
        original_tokens: list[str],
        corrected_tokens: list[str],
        normalized: str,
    ) -> str:
        """Rebuild the corrected string preserving original whitespace."""
        result = normalized
        for orig, corrected in zip(original_tokens, corrected_tokens):
            if orig != corrected:
                result = result.replace(orig, corrected, 1)
        return result


# ---------------------------------------------------------------------------
# Singleton management
# ---------------------------------------------------------------------------

_normalizer: QueryNormalizer | None = None


def build_and_init_normalizer() -> QueryNormalizer:
    """Build the normalizer singleton from loaded configs. Call at startup."""
    global _normalizer

    from .config import settings
    from .plugin_weight_loader import load_config_with_plugins
    from .taxonomy_prompt_factory import _load_config as load_taxonomy

    intent_cfg = load_config_with_plugins()
    taxonomy_cfg = load_taxonomy()

    lexicon = build_lexicon(intent_cfg, taxonomy_cfg)

    _normalizer = QueryNormalizer(
        lexicon,
        max_corrected_tokens=settings.query_normalizer_max_corrected_tokens,
        min_token_length=3,
        edit_distance_cutoff=settings.query_normalizer_edit_distance_cutoff,
        confidence_threshold=settings.query_normalizer_confidence_threshold,
        max_candidates_per_token=3,
    )
    return _normalizer


def get_normalizer() -> QueryNormalizer | None:
    """Return the singleton normalizer, or None if not initialized or disabled."""
    from .config import settings

    if not settings.query_normalizer_enabled:
        return None
    return _normalizer
