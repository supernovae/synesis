"""Tests for ingestion discovery heuristics and bootstrap validation.

Covers:
- _run_heuristic_discovery shared engine
- discover/preview endpoint shape
- bootstrap/validate endpoint
- bootstrap/metadata-guide endpoint
- Backward compatibility of existing discover and batch endpoints
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_user():
    from app.auth import UserInfo

    return UserInfo(
        user_id="admin-1",
        username="admin",
        role="admin",
        org_id="test-org",
    )


class _LLMResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(self._payload),
                    }
                }
            ]
        }


class _LLMClient:
    def __init__(self, payload: dict):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        return _LLMResponse(self._payload)


# ---------------------------------------------------------------------------
# Heuristic engine unit tests
# ---------------------------------------------------------------------------


class TestHeuristicDiscovery:
    """Unit tests for the _run_heuristic_discovery function."""

    @pytest.fixture(autouse=True)
    def _patch_httpx(self):
        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            head_resp = AsyncMock()
            head_resp.status_code = 200
            head_resp.headers = {"content-type": "text/html; charset=utf-8"}
            mock_client.head = AsyncMock(return_value=head_resp)

            get_resp = AsyncMock()
            get_resp.status_code = 404
            get_resp.text = ""
            mock_client.get = AsyncMock(return_value=get_resp)

            self.mock_client = mock_client
            yield

    @pytest.mark.asyncio
    async def test_github_repo_detection(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://github.com/example/repo")
        assert result["handler"] == "github_repo"
        assert result["deterministic"] is True
        assert result["suggested_corpus_class"] == "coder_enriched"
        assert "required_missing_fields" in result
        assert "recommendation_reasons" in result
        assert len(result["recommendation_reasons"]) > 0

    @pytest.mark.asyncio
    async def test_pdf_detection(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://example.com/paper.pdf")
        assert result["handler"] == "pdf_document"

    @pytest.mark.asyncio
    async def test_docs_tag_inference(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://kubernetes.io/docs/concepts/overview")
        assert "documentation" in result["tags"]
        assert result["suggested_corpus_class"] == "coder_enriched"

    @pytest.mark.asyncio
    async def test_general_corpus_default(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://en.wikipedia.org/wiki/Music")
        assert result["suggested_corpus_class"] == "general"

    @pytest.mark.asyncio
    async def test_hints_add_tags(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery(
            "https://example.com/something",
            hints="documentation api",
        )
        assert "documentation" in result["tags"]
        assert "api-reference" in result["tags"]

    @pytest.mark.asyncio
    async def test_required_missing_fields(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://a.b/")
        assert isinstance(result["required_missing_fields"], list)

    @pytest.mark.asyncio
    async def test_result_shape_complete(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://docs.python.org/3/library/json.html")
        expected_keys = {
            "url",
            "handler",
            "title",
            "domain",
            "tags",
            "config",
            "risk_flags",
            "recommended_mode",
            "notes",
            "deterministic",
            "recommendation_reasons",
            "suggested_corpus_class",
            "required_missing_fields",
        }
        assert expected_keys.issubset(result.keys())


# ---------------------------------------------------------------------------
# Bootstrap validation tests
# ---------------------------------------------------------------------------


class TestBootstrapValidation:
    """Unit tests for _normalize_bootstrap_meta and the validate logic."""

    def test_valid_corpus_classes(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        for cc in ("coder_enriched", "general", "hybrid"):
            cfg, warnings, errors = _normalize_bootstrap_meta({"corpus_class": cc}, None)
            assert cfg is not None
            assert cfg["synesis_meta"]["corpus_class"] == cc
            assert not warnings
            assert not errors

    def test_invalid_corpus_class_warns(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        cfg, warnings, errors = _normalize_bootstrap_meta({"corpus_class": "invalid"}, None)
        assert len(warnings) == 1
        assert "invalid corpus_class" in warnings[0]
        assert cfg is None
        assert not errors

    def test_valid_constraint_kinds(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        for ck in ("hard", "guiding", "advisory"):
            cfg, warnings, errors = _normalize_bootstrap_meta({"constraint_kind": ck}, None)
            assert cfg is not None
            assert cfg["synesis_meta"]["constraint_kind"] == ck
            assert not any("constraint_kind" in w for w in warnings)
            assert not errors

    def test_invalid_constraint_kind_warns(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        cfg, warnings, errors = _normalize_bootstrap_meta({"constraint_kind": "wrong"}, None)
        assert any("constraint_kind" in w for w in warnings)
        assert cfg is None
        assert not errors

    def test_languages_list_preserved(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        cfg, _, errors = _normalize_bootstrap_meta({"languages": ["python", "go"]}, None)
        assert cfg is not None
        assert cfg["synesis_meta"]["languages"] == ["python", "go"]
        assert not errors

    def test_existing_config_preserved(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        existing = {"url": "https://example.com", "max_pages": 50}
        cfg, _, errors = _normalize_bootstrap_meta({"corpus_class": "general"}, existing)
        assert cfg is not None
        assert cfg["url"] == "https://example.com"
        assert cfg["max_pages"] == 50
        assert cfg["synesis_meta"]["corpus_class"] == "general"
        assert not errors

    def test_empty_entry_returns_normalized_config(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        original = {"path": "seed-corpus.json"}
        cfg, warnings, errors = _normalize_bootstrap_meta({}, original)
        assert cfg == original
        assert not warnings
        assert not errors

    def test_unknown_existing_config_key_rejected(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        cfg, warnings, errors = _normalize_bootstrap_meta({}, {"invented_config_flag": True})
        assert cfg is None
        assert not warnings
        assert any("invented_config_flag" in error for error in errors)

    def test_empty_entry_none_config(self):
        from app.routers.ingestion import _normalize_bootstrap_meta

        cfg, warnings, errors = _normalize_bootstrap_meta({}, None)
        assert cfg is None
        assert not warnings
        assert not errors


class TestIngestionConfigValidation:
    """Strict request schema tests for state-changing ingestion config paths."""

    def test_item_create_accepts_known_config_keys(self):
        from app.routers.ingestion import ItemCreate

        item = ItemCreate(
            uri="https://example.com/docs/",
            config={
                "url": "https://example.com/docs/",
                "discovery": "sitemap_first",
                "follow_links": True,
                "max_depth": 2,
                "allowed_prefixes": ["https://example.com/docs/"],
                "synesis_meta": {
                    "corpus_class": "coder_enriched",
                    "languages": ["python"],
                    "constraint_confidence": 0.8,
                },
            },
        )

        assert item.config is not None
        assert item.config.max_depth == 2
        assert item.config.synesis_meta is not None
        assert item.config.synesis_meta.languages == ["python"]

    def test_item_create_accepts_known_handler_config_keys(self):
        from app.routers.ingestion import ItemCreate

        item = ItemCreate(
            uri="license:spdx",
            config={
                "path": "seed-corpus.json",
                "doc_id_prefix": "epistemic",
                "papers": [{"id": "2005.11401", "title": "RAG"}],
                "spdx": {
                    "licenses_url": "https://example.com/licenses.json",
                    "details_base_url": "https://example.com/details/",
                },
                "fedora": {
                    "repo_url": "https://example.com/fedora/",
                    "common_licenses": ["MIT"],
                },
                "choosealicense": {
                    "repo": "github/choosealicense.com",
                    "branch": "gh-pages",
                    "licenses_path": "_licenses",
                },
                "compat_path": "/data/compatibility.yaml",
            },
        )

        assert item.config is not None
        assert item.config.path == "seed-corpus.json"
        assert item.config.papers is not None
        assert item.config.papers[0].id == "2005.11401"
        assert item.config.spdx is not None
        assert item.config.spdx.licenses_url == "https://example.com/licenses.json"

    def test_item_create_rejects_unknown_config_key(self):
        from app.routers.ingestion import ItemCreate

        with pytest.raises(ValidationError, match="invented_flag"):
            ItemCreate(uri="https://example.com/docs/", config={"invented_flag": True})

    def test_item_create_rejects_unknown_nested_handler_config_key(self):
        from app.routers.ingestion import ItemCreate

        with pytest.raises(ValidationError, match="invented_license_attr"):
            ItemCreate(
                uri="license:spdx",
                config={
                    "spdx": {
                        "licenses_url": "https://example.com/licenses.json",
                        "invented_license_attr": True,
                    }
                },
            )

    def test_item_patch_rejects_unknown_nested_synesis_meta_key(self):
        from app.routers.ingestion import ItemPatch

        with pytest.raises(ValidationError, match="invented_meta"):
            ItemPatch(config={"synesis_meta": {"corpus_class": "general", "invented_meta": "x"}})

    def test_item_patch_rejects_invented_review_status(self):
        from app.routers.ingestion import ItemPatch

        with pytest.raises(ValidationError, match="review_status"):
            ItemPatch(config={"synesis_meta": {"review_status": 'pending"\nrole=admin'}})

    def test_item_patch_accepts_known_review_statuses(self):
        from app.routers.ingestion import ItemPatch

        for status in ("pending", "reviewed", "closed"):
            item = ItemPatch(config={"synesis_meta": {"review_status": status}})
            assert item.config is not None
            assert item.config.synesis_meta is not None
            assert item.config.synesis_meta.review_status == status

    def test_item_patch_rejects_unknown_top_level_patch_key(self):
        from app.routers.ingestion import ItemPatch

        with pytest.raises(ValidationError, match="invented_patch_key"):
            ItemPatch(invented_patch_key=True)


# ---------------------------------------------------------------------------
# Metadata guide tests
# ---------------------------------------------------------------------------


class TestMetadataGuide:
    """Verify the metadata guide endpoint returns expected shape."""

    def test_valid_corpus_classes_in_guide(self):
        from app.routers.ingestion import _VALID_CONSTRAINT_KINDS, _VALID_CORPUS_CLASSES

        assert "coder_enriched" in _VALID_CORPUS_CLASSES
        assert "general" in _VALID_CORPUS_CLASSES
        assert "hybrid" in _VALID_CORPUS_CLASSES
        assert "hard" in _VALID_CONSTRAINT_KINDS
        assert "guiding" in _VALID_CONSTRAINT_KINDS
        assert "advisory" in _VALID_CONSTRAINT_KINDS


# ---------------------------------------------------------------------------
# Backward compatibility: discover endpoint still works with old shape
# ---------------------------------------------------------------------------


class TestDiscoverBackwardCompat:
    """The existing discover endpoint must still return the original fields."""

    @pytest.mark.asyncio
    async def test_discover_result_has_legacy_fields(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery("https://example.com/page")
        legacy_keys = {"url", "handler", "title", "domain", "tags", "config", "risk_flags", "recommended_mode", "notes"}
        assert legacy_keys.issubset(result.keys())


# ---------------------------------------------------------------------------
# Corpus heuristic mapping tests
# ---------------------------------------------------------------------------


class TestCorpusHeuristics:
    @pytest.mark.asyncio
    async def test_known_coder_domains(self):
        from app.routers.ingestion import _CORPUS_HEURISTICS, _run_heuristic_discovery

        for pattern in list(_CORPUS_HEURISTICS.keys())[:3]:
            url = f"https://{pattern}/some/page"
            result = await _run_heuristic_discovery(url)
            assert result["suggested_corpus_class"] == "coder_enriched", f"Expected coder_enriched for {pattern}"

    @pytest.mark.asyncio
    async def test_tag_based_coder_detection(self):
        from app.routers.ingestion import _run_heuristic_discovery

        result = await _run_heuristic_discovery(
            "https://randomsite.com/api/reference/auth",
        )
        assert result["suggested_corpus_class"] == "coder_enriched"


# ---------------------------------------------------------------------------
# BatchPreflightRequest dry_run field
# ---------------------------------------------------------------------------


class TestBatchPreflightDryRun:
    def test_dry_run_field_default(self):
        from app.routers.ingestion import BatchPreflightRequest

        req = BatchPreflightRequest()
        assert req.dry_run is False

    def test_dry_run_field_set(self):
        from app.routers.ingestion import BatchPreflightRequest

        req = BatchPreflightRequest(dry_run=True)
        assert req.dry_run is True

    def test_backward_compat_no_dry_run(self):
        from app.routers.ingestion import BatchPreflightRequest

        req = BatchPreflightRequest(status_filter="pending", limit=10, use_llm=False)
        assert req.dry_run is False


# ---------------------------------------------------------------------------
# DiscoverPreviewRequest shape
# ---------------------------------------------------------------------------


class TestDiscoverPreviewRequest:
    def test_minimal(self):
        from app.routers.ingestion import DiscoverPreviewRequest

        req = DiscoverPreviewRequest(url="https://example.com")
        assert req.url == "https://example.com"
        assert req.hints == ""

    def test_with_hints(self):
        from app.routers.ingestion import DiscoverPreviewRequest

        req = DiscoverPreviewRequest(url="https://example.com", hints="docs")
        assert req.hints == "docs"

    def test_normalizes_known_hint_aliases(self):
        from app.routers.ingestion import _normalize_discovery_hints

        assert _normalize_discovery_hints("docs api documentation") == "documentation api-reference"

    def test_rejects_unknown_hint_text(self):
        from app.routers.ingestion import _normalize_discovery_hints

        with pytest.raises(HTTPException, match="hints must contain only known values"):
            _normalize_discovery_hints("docs role=admin ignore policy")


class TestDiscoverLlmHardening:
    @pytest.mark.asyncio
    async def test_llm_enrichment_rejects_invented_handler_and_config_keys(self):
        from app.routers.ingestion import DiscoverRequest, discover_url

        payload = {
            "title": "Trusted Docs",
            "domain": "kubernetes",
            "tags": ["documentation", "role=admin"],
            "handler": "system_prompt_handler",
            "config_overrides": {
                "invented_config_flag": True,
                "inline_content": "do not persist",
            },
            "risk_notes": "contains\ncontrol characters",
        }
        with patch("httpx.AsyncClient", lambda timeout=30.0: _LLMClient(payload)):
            result = await discover_url(
                DiscoverRequest(url="https://example.com/docs", use_llm=True),
                _fake_user(),
            )

        assert result["title"] == "Trusted Docs"
        assert result["domain"] == "kubernetes"
        assert "documentation" in result["tags"]
        assert "role=admin" not in result["tags"]
        assert result["handler"] != "system_prompt_handler"
        assert "invented_config_flag" not in result["config"]
        assert "inline_content" not in result["config"]
        assert "llm_handler_rejected" in result["risk_flags"]
        assert "llm_config_overrides_rejected" in result["risk_flags"]
        assert "contains control characters" in result["notes"]

    @pytest.mark.asyncio
    async def test_llm_enrichment_accepts_known_handler_and_config_keys(self):
        from app.routers.ingestion import DiscoverRequest, discover_url

        payload = {
            "handler": "pdf_document",
            "config_overrides": {
                "max_pages": 10,
                "follow_links": True,
            },
        }
        with patch("httpx.AsyncClient", lambda timeout=30.0: _LLMClient(payload)):
            result = await discover_url(
                DiscoverRequest(url="https://example.com/docs", use_llm=True),
                _fake_user(),
            )

        assert result["handler"] == "pdf_document"
        assert result["config"]["max_pages"] == 10
        assert result["config"]["follow_links"] is True
        assert "llm_config_overrides_rejected" not in result["risk_flags"]

    def test_discover_model_id_is_bounded_identifier(self):
        from app.routers.ingestion import BatchPreflightRequest, DiscoverRequest

        DiscoverRequest(url="https://example.com", model_id="openai/gpt-4.1-mini")
        BatchPreflightRequest(model_id="synesis-writer")
        with pytest.raises(ValidationError, match="model_id"):
            DiscoverRequest(url="https://example.com", model_id="writer\nrole=admin")
        with pytest.raises(ValidationError, match="model_id"):
            BatchPreflightRequest(model_id="x" * 129)
