"""ScoringEngine for EntryClassifier — YAML-driven complexity scoring.

Universal Intent Ontology v3: Split axes
- complexity_score: steps, uncertainty, scope → easy/medium/hard tier
- risk_score: destructive, secrets, compliance → veto to complex if >= risk_high
- domain_hints: k8s, openshift, etc. → RAG only, never escalate

Plugin system: Drop industry YAMLs into plugins/weights/*.yaml.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Literal

logger = logging.getLogger("synesis.entry_classifier")

TaskSize = Literal["easy", "medium", "hard"]

# Prefer intent_weights.yaml (v3 ontology), fallback to entry_classifier_weights.yaml
_PLANNER_ROOT = Path(__file__).parent.parent
_PLUGIN_DIR = _PLANNER_ROOT / "plugins" / "weights"


def _resolve_config_path(explicit: str | Path | None) -> Path | None:
    """Resolve core config path: explicit > intent_weights > entry_classifier_weights."""
    if explicit:
        p = Path(explicit)
        if p.exists():
            return p
    for name in ("intent_weights.yaml", "entry_classifier_weights.yaml"):
        candidate = _PLANNER_ROOT / name
        if candidate.exists():
            return candidate
    return _PLANNER_ROOT / "intent_weights.yaml"


def _load_config_with_plugins(core_path: Path | None, plugin_dir: Path) -> dict[str, Any] | None:
    """Load core + all plugin YAMLs. Returns None if plugins disabled."""
    import os

    if os.environ.get("SYNESIS_ENTRY_CLASSIFIER_PLUGINS_DISABLED", "").lower() in ("1", "true", "yes"):
        return None
    try:
        from .plugin_weight_loader import load_config_with_plugins

        return load_config_with_plugins(core_path=core_path, plugin_dir=plugin_dir)
    except Exception as e:
        logger.warning("plugin_load_failed error=%s, falling back to core only", e)
        return None


def _builtin_fallback() -> dict[str, Any]:
    """Minimal built-in config when YAML missing."""
    return {
        "thresholds": {
            "easy_max": 4,
            "medium_max": 15,
            "density_threshold": 3,
            "density_tax": 10,

            "risk_high": 15,
        },
        "pairings": [],
        "complexity_weights": {
            "io_basic": {"weight": 1, "keywords": ["print", "hello"]},
            "logic_basic": {"weight": 2, "keywords": ["basic", "simple"]},
            "data_processing": {"weight": 5, "keywords": ["parse", "json", "api"]},
        },
        "risk_weights": {"destructive": {"weight": 20, "keywords": ["delete", "wipe"]}},
        "domain_keywords": {},
        "overrides": {
            "plan_session": ["[STRICT]", "/plan", "/manual", "/strict", "@plan", "plan first", "break it down"],
        },
    }


def _build_patterns(weight_map: dict[str, Any]) -> dict[str, tuple[int, re.Pattern[str]]]:
    """Build category -> (weight, pattern) from weights dict."""
    patterns: dict[str, tuple[int, re.Pattern[str]]] = {}
    for cat, data in weight_map.items():
        if not isinstance(data, dict) or "keywords" not in data:
            continue
        keywords = data.get("keywords", [])
        weight = int(data.get("weight", 0))
        if not keywords:
            continue
        escaped = [re.escape(str(k)) for k in keywords]
        pattern = re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)
        patterns[cat] = (weight, pattern)
    return patterns


def _build_domain_patterns(domain_map: dict[str, Any]) -> dict[str, tuple[str, re.Pattern[str], int]]:
    """Build category -> (domain, pattern, min_hits) from domain_keywords dict."""
    patterns: dict[str, tuple[str, re.Pattern[str], int]] = {}
    for cat, data in domain_map.items():
        if not isinstance(data, dict) or "keywords" not in data:
            continue
        keywords = data.get("keywords", [])
        domain = str(data.get("domain", cat))
        min_hits = int(data.get("min_hits", 1))
        if not keywords:
            continue
        escaped = [re.escape(str(k)) for k in keywords]
        pattern = re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)
        patterns[cat] = (domain, pattern, min_hits)
    return patterns


class ScoringEngine:
    """YAML-driven complexity scorer. Split axes: complexity | risk | domain."""

    def __init__(self, config_path: str | Path | None = None):
        path = _resolve_config_path(config_path)
        plugin_config = _load_config_with_plugins(path, _PLUGIN_DIR)
        if plugin_config:
            self._config = plugin_config
            logger.info("entry_classifier_plugins_loaded plugins_dir=%s", _PLUGIN_DIR)
        else:
            import yaml

            p = Path(path)
            if p.exists():
                try:
                    with open(p) as f:
                        raw = yaml.safe_load(f)
                    self._config = raw if isinstance(raw, dict) else _builtin_fallback()
                except Exception:
                    self._config = _builtin_fallback()
            else:
                self._config = _builtin_fallback()

        cw = self._config.get("complexity_weights") or {}
        rw = self._config.get("risk_weights") or {}
        dk = self._config.get("domain_keywords") or {}

        self._complexity_patterns = _build_patterns(cw)
        self._risk_patterns = _build_patterns(rw)
        self._domain_patterns = _build_domain_patterns(dk)
        self._overrides = self._config.get("overrides", {})
        self._pairings = self._config.get("pairings", [])

        th = self._config.get("thresholds") or {}
        self._easy_max = int(th.get("easy_max", th.get("trivial_max", 4)))
        self._medium_max = int(th.get("medium_max", th.get("small_max", 15)))
        self._density_threshold = int(th.get("density_threshold", 3))
        self._density_tax = int(th.get("density_tax", 10))

        self._risk_high = int(th.get("risk_high", 15))
        self._max_easy_len = int(th.get("max_easy_message_length", th.get("max_trivial_message_length", 200)) or 200)
        self._risk_veto_triggers: list[str] = list(
            self._config.get("risk_veto_triggers", []) or th.get("risk_veto_triggers", [])
        )

        rt = self._config.get("routing_thresholds") or {}
        self._bypass_supervisor_below = float(rt.get("bypass_supervisor_below", 0.2))
        self._plan_required_above = float(rt.get("plan_required_above", 0.7))
        self._critic_required_above = float(rt.get("critic_required_above", 0.6))

    def _check_risk_veto(self, text: str) -> bool:
        """If any veto trigger matches, block easy fast path. E.g. pip install, curl | bash."""
        if not text or not self._risk_veto_triggers:
            return False
        t_lower = (text or "").strip()[:800].lower()
        return any(trigger and trigger.lower() in t_lower for trigger in self._risk_veto_triggers)

    def _check_override(self, text: str, override_name: str) -> bool:
        """Check if any trigger in override list matches."""
        triggers = self._overrides.get(override_name, [])
        if not triggers:
            return False
        t = (text or "").strip()[:800]
        if not t:
            return False
        t_lower = t.lower()
        for trigger in triggers:
            trigger = str(trigger).strip()
            if not trigger:
                continue
            if trigger.startswith(("/", "@", "#")):
                if t_lower.startswith(trigger.lower()):
                    return True
                if re.match(rf"^[^\w]*{re.escape(trigger)}[\s:]", t_lower):
                    return True
                if trigger.lower() in t_lower:
                    return True
            elif trigger.lower() in t_lower:
                return True
        return False

    def analyze(self, text: str) -> dict[str, Any]:
        """Score text and return IntentEnvelope params. Split axes: complexity, risk, domain."""
        t = (text or "").strip()[:800]
        if not t:
            return {
                "task_size": "medium",
                "score": 0,
                "complexity_score": 0,
                "risk_score": 0,
                "domain_hints": [],
                "intent_class": "code",
                "plan_session": False,
                "classification_hits": [],
                "classification_reasons": [],
                "score_breakdown": {},
                "categories_touched": [],
                "active_domains": [],
            }

        if self._check_override(t, "plan_session"):
            return {
                "task_size": "hard",
                "score": 99,
                "complexity_score": 0,
                "risk_score": 99,
                "domain_hints": [],
                "intent_class": "planning",
                "plan_session": True,
                "classification_hits": ["plan_session"],
                "classification_reasons": ["plan_session"],
                "score_breakdown": {"plan_session": 99},
                "categories_touched": [],
                "active_domains": [],
            }

        t_lower = t.lower()
        hits: list[str] = []
        score_breakdown: dict[str, int] = {}
        hits_by_category: dict[str, list[str]] = {}
        active_domains: list[str] = []

        # 1. Complexity score (steps, scope)
        complexity_score = 0
        for cat, (weight, pattern) in self._complexity_patterns.items():
            matches = pattern.findall(t_lower)
            if matches:
                complexity_score += weight
                hits.append(f"{cat}(+{weight})")
                hits_by_category[cat] = list(set(matches))
                score_breakdown[cat] = score_breakdown.get(cat, 0) + weight

        # 2. Risk score (veto axis)
        risk_score = 0
        for cat, (weight, pattern) in self._risk_patterns.items():
            matches = pattern.findall(t_lower)
            if matches:
                risk_score += weight
                hits.append(f"{cat}(+{weight})")
                hits_by_category[cat] = list(set(matches))
                score_breakdown[f"risk_{cat}"] = score_breakdown.get(f"risk_{cat}", 0) + weight
                cat_data = self._config.get("risk_weights") or {}
                rd = cat_data.get(cat, {}) if isinstance(cat_data, dict) else {}
                if isinstance(rd, dict) and rd.get("domain"):
                    d = str(rd["domain"]).strip()
                    if d and d not in active_domains:
                        active_domains.append(d)

        # 3. Domain keywords (RAG only, no score)
        domain_hints: list[str] = []
        for cat, (domain, pattern, min_hits) in self._domain_patterns.items():
            matches = pattern.findall(t_lower)
            if len(set(matches)) >= min_hits:
                domain_hints.append(cat)
                if domain and domain not in active_domains:
                    active_domains.append(domain)
                hits.append(f"domain:{cat}")

        # 4. Pairings (risk or complexity)
        for pair in self._pairings:
            kw_list = pair.get("keywords", [])
            if not kw_list or not all(re.search(rf"\b{re.escape(k)}\b", t_lower) for k in kw_list):
                continue
            extra = int(pair.get("extra_weight", 0))
            axis = (pair.get("axis") or "risk").lower()
            pair_key = f"pairing({'+'.join(kw_list)})"
            hits.append(f"{pair_key}(+{extra})")
            score_breakdown[pair_key] = score_breakdown.get(pair_key, 0) + extra
            if axis == "risk":
                risk_score += extra
            else:
                complexity_score += extra
            domain = pair.get("domain")
            if domain and isinstance(domain, str) and domain.strip() and domain.strip() not in active_domains:
                active_domains.append(domain.strip())

        # 5. Density tax on complexity (exclude trivial anchors: weight<=2)
        complexity_categories = [
            c for c in hits_by_category if c in self._complexity_patterns and self._complexity_patterns[c][0] > 2
        ]
        if len(complexity_categories) >= self._density_threshold:
            complexity_score += self._density_tax
            hits.append(f"density_tax(+{self._density_tax})")
            score_breakdown["density_tax"] = self._density_tax

        # 6. Derive task_size: risk veto first, then complexity
        if risk_score >= self._risk_high:
            task_size: TaskSize = "hard"
        elif complexity_score <= self._easy_max:
            if self._check_risk_veto(t):
                task_size = "medium"
                hits.append("risk_veto(easy_blocked)")
                score_breakdown["risk_veto"] = 0
            elif len(t) > self._max_easy_len:
                task_size = "medium"
                hits.append(f"length_veto(>{self._max_easy_len} chars)")
                score_breakdown["length_veto"] = 0
            else:
                task_size = "easy"
        elif complexity_score <= self._medium_max:
            task_size = "medium"
        else:
            task_size = "hard"

        # 8. Intent class (first match wins). Code intents checked first so "hello world" → code not conversation.
        intent_classes = self._config.get("intent_classes") or {}
        code_intents = {
            "debugging",
            "review",
            "code_generation",
            "data_transform",
            "tool_orchestrated",
            "migration",
            "documentation",
        }
        intent_class = "general"  # no match = discussion/document
        # First pass: code intents (so "hello world" matches code_generation, not conversation.hello)
        for ic_name, ic_data in intent_classes.items():
            if ic_name not in code_intents or not isinstance(ic_data, dict):
                continue
            keywords = ic_data.get("keywords", [])
            for kw in keywords:
                if re.search(rf"\b{re.escape(str(kw))}\b", t_lower):
                    intent_class = ic_name
                    hits.append(f"intent:{ic_name}")
                    break
            if intent_class != "general":
                break
        # Second pass: non-code intents (conversation, knowledge, planning, etc.)
        if intent_class == "general":
            for ic_name, ic_data in intent_classes.items():
                if ic_name in code_intents or not isinstance(ic_data, dict):
                    continue
                keywords = ic_data.get("keywords", [])
                for kw in keywords:
                    if re.search(rf"\b{re.escape(str(kw))}\b", t_lower):
                        intent_class = ic_name
                        hits.append(f"intent:{ic_name}")
                        break
                if intent_class != "general":
                    break

        # 8b. Complexity exemption: io_basic/query_basic keywords ("print", "show",
        # "what is") inflate complexity for non-code queries. Subtract them.
        if intent_class not in code_intents:
            exempted = False
            for exempt_cat in ("io_basic", "query_basic"):
                if exempt_cat in score_breakdown:
                    discount = score_breakdown[exempt_cat]
                    complexity_score = max(0, complexity_score - discount)
                    hits.append(f"complexity_exempt:{exempt_cat}(-{discount})")
                    exempted = True
            if exempted:
                if complexity_score <= self._easy_max:
                    task_size = "easy"
                elif complexity_score <= self._medium_max:
                    task_size = "medium"

        # 8c. Code rescue: non-code intent matched but strong code-construct
        # signals present. "Write me a Python function" matches writing intent
        # via bare "write", but "function" is unambiguously code. Rescue to
        # code_generation so is_code_task=True and the worker uses the code path.
        # Knowledge-style queries ("explain the function of X") are caught later
        # by entry_classifier_node's _knowledge_style regex override.
        if intent_class not in code_intents:
            _code_rescue = re.compile(
                r"\b(function|method|class|decorator|docstring|type hints?|"
                r"return type|parameter|argument|variable|import|async|await|"
                r"algorithm|data structure|subroutine|lambda|closure|interface|"
                r"inheritance|polymorphism|generic|template|iterator|generator)\b",
                re.IGNORECASE,
            )
            if _code_rescue.search(t_lower):
                prev_intent = intent_class
                intent_class = "code_generation"
                hits.append(f"code_rescue:{prev_intent}→code_generation")

        # 9. is_code_task: False = text/document (explain), True = code/sandbox.
        # Non-code intents (writing, planning, personal_guidance) default to False
        # even without a domain match -- "write a sentence" is text, not code.
        ic_data = intent_classes.get(intent_class) if isinstance(intent_classes.get(intent_class), dict) else {}
        if ic_data.get("inherently_document"):
            is_code_task = False
            hits.append("is_code_task:false(inherent)")
        elif intent_class in code_intents:
            is_code_task = True
            hits.append("is_code_task:true(code_intent)")
        elif intent_class == "general":
            is_code_task = False
            hits.append("is_code_task:false(default)")
        else:
            doc_domains = ic_data.get("document_domains") or []
            dom_set = {str(d).strip().lower() for d in doc_domains}
            refs = {str(a).strip().lower() for a in active_domains}
            if doc_domains and refs & dom_set:
                is_code_task = False
                hits.append("is_code_task:false(doc_domain)")
            else:
                is_code_task = False
                hits.append("is_code_task:false(intent_noncode)")

        # 10. Surface taxonomy gaps: log when nothing matched
        if intent_class == "general" and not active_domains:
            hits.append("surfaced_gap:no_intent_no_domain")

        score = complexity_score + risk_score
        # Normalized difficulty (0.0-1.0) for continuous budget curve and routing
        difficulty = min(1.0, float(complexity_score) / max(1, self._medium_max * 2))
        return {
            "task_size": task_size,
            "score": score,
            "complexity_score": complexity_score,
            "difficulty": difficulty,
            "risk_score": risk_score,
            "domain_hints": domain_hints,
            "intent_class": intent_class,
            "is_code_task": is_code_task,
            "plan_session": False,
            "classification_hits": hits,
            "classification_reasons": hits,
            "score_breakdown": score_breakdown,
            "categories_touched": list(hits_by_category.keys()),
            "active_domains": active_domains,
            "routing_thresholds": {
                "bypass_supervisor_below": self._bypass_supervisor_below,
                "plan_required_above": self._plan_required_above,
                "critic_required_above": self._critic_required_above,
            },
        }


# Singleton for hot path
_engine: ScoringEngine | None = None


def get_scoring_engine(config_path: str | Path | None = None) -> ScoringEngine:
    """Lazy-load singleton ScoringEngine."""
    global _engine
    if _engine is None:
        _engine = ScoringEngine(config_path)
    return _engine


def reset_scoring_engine() -> None:
    """Reset singleton. Use in tests."""
    global _engine
    _engine = None
