"""Tests for the deterministic query normalizer and typo corrector."""

from __future__ import annotations

import re

import pytest
from app.query_normalizer import (
    CorrectionCandidate,
    QueryNormalization,
    QueryNormalizer,
    build_lexicon,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def lexicon() -> frozenset[str]:
    """Build real lexicon from project configs (same as production startup)."""
    from app.plugin_weight_loader import load_config_with_plugins
    from app.taxonomy_prompt_factory import _load_config as load_taxonomy

    return build_lexicon(load_config_with_plugins(), load_taxonomy())


@pytest.fixture(scope="module")
def normalizer(lexicon: frozenset[str]) -> QueryNormalizer:
    return QueryNormalizer(lexicon)


@pytest.fixture()
def tiny_normalizer() -> QueryNormalizer:
    """Normalizer with a small controlled lexicon for deterministic tests."""
    tiny_lex = frozenset(
        [
            "kubernetes",
            "terraform",
            "python",
            "fastapi",
            "docker",
            "deployment",
            "container",
            "microservice",
            "microservices",
            "aws",
            "react",
            "flask",
            "django",
            "openshift",
        ]
    )
    return QueryNormalizer(tiny_lex)


# ---------------------------------------------------------------------------
# Dataclass tests
# ---------------------------------------------------------------------------


class TestQueryNormalizationDataclass:
    def test_to_dict_roundtrip(self):
        qn = QueryNormalization(
            original_query="test",
            normalized_query="test",
            corrected_query_candidates=(),
            selected_query="test",
            correction_confidence=1.0,
            correction_reason="",
            changed_tokens=(),
            protected_tokens=(),
        )
        d = qn.to_dict()
        assert d["original_query"] == "test"
        assert d["correction_confidence"] == 1.0
        assert isinstance(d["corrected_query_candidates"], (list, tuple))

    def test_frozen(self):
        qn = QueryNormalization(
            original_query="x",
            normalized_query="x",
            corrected_query_candidates=(),
            selected_query="x",
            correction_confidence=1.0,
            correction_reason="",
            changed_tokens=(),
            protected_tokens=(),
        )
        with pytest.raises(AttributeError):
            qn.original_query = "y"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------


class TestPreprocessing:
    def test_whitespace_normalization(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("  explain   kubernetes   pod  ")
        assert "  " not in r.normalized_query
        assert r.normalized_query.strip() == r.normalized_query

    def test_unicode_normalization(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("what\u2019s the best\u2014approach")
        assert "\u2019" not in r.normalized_query
        assert "\u2014" not in r.normalized_query

    def test_zero_width_removal(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("kub\u200bernetes")
        assert "\u200b" not in r.normalized_query

    def test_empty_input(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("")
        assert r.selected_query == ""
        assert r.correction_confidence == 1.0

    def test_whitespace_only(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("   ")
        assert r.selected_query == "   "


# ---------------------------------------------------------------------------
# Protected token detection
# ---------------------------------------------------------------------------


class TestProtectedTokens:
    def test_camel_case_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("fix the getUserData function")
        assert "getUserData" in r.protected_tokens
        assert not r.changed_tokens

    def test_snake_case_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("check my_module_name imports")
        assert "my_module_name" in r.protected_tokens

    def test_version_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("upgrade to v3.12.1")
        assert "v3.12.1" in r.protected_tokens
        assert not r.changed_tokens

    def test_url_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("check https://example.com/docs for info")
        # URL gets split by tokenizer; path separators trigger path-adjacent protection
        assert not r.changed_tokens

    def test_file_path_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("edit src/components/Button.tsx")
        assert "components" in r.protected_tokens or "src" in r.protected_tokens
        assert not r.changed_tokens

    def test_cli_flag_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("run with --verbose flag")
        assert "--verbose" in r.protected_tokens

    def test_all_caps_constant_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("set MAX_RETRIES to 5")
        assert "MAX_RETRIES" in r.protected_tokens

    def test_dunder_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("override __init__ method")
        assert "__init__" in r.protected_tokens

    def test_kebab_case_protected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("install my-awesome-package")
        assert "my-awesome-package" in r.protected_tokens


# ---------------------------------------------------------------------------
# Typo correction
# ---------------------------------------------------------------------------


class TestTypoCorrection:
    def test_kubernetes_typo(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("kuberntes deployment strategy")
        assert "kuberntes" in r.changed_tokens
        assert "kubernetes" in r.selected_query.lower()

    def test_terraform_typo(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("terrform state management")
        assert "terrform" in r.changed_tokens
        assert "terraform" in r.selected_query.lower()

    def test_fastapi_repeated_char(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("how to use fasttapi")
        assert "fasttapi" in r.changed_tokens
        assert "fastapi" in r.selected_query.lower()

    def test_python_typo(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("how to use pythn for web development")
        assert "pythn" in r.changed_tokens
        assert "python" in r.selected_query.lower()

    def test_repeated_char_correction(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("ruuuning a microservice")
        assert "ruuuning" in r.changed_tokens
        assert "running" in r.selected_query.lower()

    def test_max_corrected_tokens(self, tiny_normalizer: QueryNormalizer):
        """Normalizer should not correct more than max_corrected_tokens."""
        n = QueryNormalizer(
            tiny_normalizer._lexicon,
            max_corrected_tokens=1,
        )
        r = n.normalize("kuberntes terrform pythn")
        assert len(r.changed_tokens) <= 1


# ---------------------------------------------------------------------------
# No false positives
# ---------------------------------------------------------------------------


class TestNoFalsePositives:
    def test_clean_query_untouched(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("how do i build a REST API")
        assert not r.changed_tokens
        assert r.selected_query == r.normalized_query

    def test_scheduling_not_corrected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("explain kubernetes pod scheduling")
        assert "scheduling" not in r.changed_tokens

    def test_strategies_not_corrected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("kubernetes deployment strategies")
        # "strategies" is a morphological variant — should not be corrected
        assert "strategies" not in r.changed_tokens

    def test_containers_plural_ok(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("how to run docker containers")
        assert "containers" not in r.changed_tokens

    def test_deployments_plural_ok(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("list all kubernetes deployments")
        assert "deployments" not in r.changed_tokens

    def test_development_not_corrected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("web development with python")
        assert "development" not in r.changed_tokens

    def test_kustomize_not_corrected(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("use kustomize overlay")
        assert not r.changed_tokens


# ---------------------------------------------------------------------------
# Confidence and scoring
# ---------------------------------------------------------------------------


class TestConfidenceAndScoring:
    def test_high_confidence_for_clear_typo(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("kuberntes pod")
        assert r.correction_confidence >= 0.8

    def test_confidence_1_for_clean_query(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("explain kubernetes networking")
        assert r.correction_confidence == 1.0


# ---------------------------------------------------------------------------
# Correction candidates
# ---------------------------------------------------------------------------


class TestCorrectionCandidates:
    def test_candidate_structure(self, normalizer: QueryNormalizer):
        r = normalizer.normalize("kuberntes deployment")
        assert len(r.corrected_query_candidates) >= 1
        cand = r.corrected_query_candidates[0]
        assert isinstance(cand, CorrectionCandidate)
        assert cand.score > 0
        assert len(cand.changed_tokens) >= 1
        assert cand.reason


# ---------------------------------------------------------------------------
# Lexicon builder
# ---------------------------------------------------------------------------


class TestBuildLexicon:
    def test_lexicon_contains_domain_terms(self, lexicon: frozenset[str]):
        assert "kubernetes" in lexicon
        assert "terraform" in lexicon
        assert "python" in lexicon

    def test_lexicon_contains_common_english(self, lexicon: frozenset[str]):
        assert "the" in lexicon
        assert "how" in lexicon
        assert "what" in lexicon

    def test_lexicon_splits_phrases(self, lexicon: frozenset[str]):
        assert len(lexicon) > 100

    def test_lexicon_no_single_char(self, lexicon: frozenset[str]):
        single_chars = [w for w in lexicon if len(w) == 1]
        assert len(single_chars) <= 2  # "a" and "i" are ok


# ---------------------------------------------------------------------------
# Extra jargon
# ---------------------------------------------------------------------------


class TestExtraJargon:
    def test_jargon_protected(self):
        lex = frozenset(["kubernetes", "python"])
        n = QueryNormalizer(lex, extra_jargon=frozenset(["kubectl", "kustomize"]))
        r = n.normalize("run kubectl apply")
        assert "kubectl" in r.protected_tokens


# ---------------------------------------------------------------------------
# Extra protected patterns
# ---------------------------------------------------------------------------


class TestExtraProtectedPatterns:
    def test_custom_pattern(self):
        lex = frozenset(["kubernetes", "python"])
        custom = [re.compile(r"^CUSTOM_\w+$")]
        n = QueryNormalizer(lex, extra_protected_patterns=custom)
        r = n.normalize("set CUSTOM_FLAG to true")
        assert "CUSTOM_FLAG" in r.protected_tokens
