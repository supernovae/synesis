"""Tests for config.py -- validates Settings initialization and env parsing.

This is the test that would have caught the 'debug' Literal crash on day one.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from pydantic import ValidationError


class TestSettingsValidation:
    """Verify that Settings() validates env vars against Pydantic constraints."""

    def _make_settings(self, **overrides):
        """Create a fresh Settings instance with env overrides."""
        env = {
            "SYNESIS_CODER_MODEL_URL": "http://localhost:8080/v1",
            "SYNESIS_SUPERVISOR_MODEL_URL": "http://localhost:8081/v1",
            "SYNESIS_RAG_RERANKER": "flashrank",
            "SYNESIS_RAG_RETRIEVAL_STRATEGY": "hybrid",
            "SYNESIS_LSP_MODE": "on_failure",
            "SYNESIS_LOG_LEVEL": "info",
        }
        env.update(overrides)
        with patch.dict(os.environ, env, clear=False):
            from app.config import Settings

            return Settings()

    def test_default_settings_valid(self):
        s = self._make_settings()
        assert s.coder_model_name == "qwen-coder-32b"
        assert s.rag_reranker in ("flashrank", "bge", "none")

    def test_all_reranker_values(self):
        for val in ("flashrank", "bge", "none"):
            s = self._make_settings(SYNESIS_RAG_RERANKER=val)
            assert s.rag_reranker == val

    def test_invalid_reranker_rejected(self):
        """This is the exact bug that caused 1000-line CrashLoopBackOff."""
        with pytest.raises(ValidationError, match="rag_reranker"):
            self._make_settings(SYNESIS_RAG_RERANKER="debug")

    def test_invalid_reranker_typo_rejected(self):
        with pytest.raises(ValidationError, match="rag_reranker"):
            self._make_settings(SYNESIS_RAG_RERANKER="flshrank")

    def test_all_retrieval_strategies(self):
        for val in ("hybrid", "vector", "bm25"):
            s = self._make_settings(SYNESIS_RAG_RETRIEVAL_STRATEGY=val)
            assert s.rag_retrieval_strategy == val

    def test_invalid_retrieval_strategy_rejected(self):
        with pytest.raises(ValidationError, match="rag_retrieval_strategy"):
            self._make_settings(SYNESIS_RAG_RETRIEVAL_STRATEGY="fulltext")

    def test_all_lsp_modes(self):
        for val in ("on_failure", "always", "disabled"):
            s = self._make_settings(SYNESIS_LSP_MODE=val)
            assert s.lsp_mode == val

    def test_invalid_lsp_mode_rejected(self):
        with pytest.raises(ValidationError, match="lsp_mode"):
            self._make_settings(SYNESIS_LSP_MODE="sometimes")

    def test_int_from_string_env(self):
        s = self._make_settings(SYNESIS_MILVUS_PORT="27017")
        assert s.milvus_port == 27017

    def test_bool_from_string_env(self):
        s = self._make_settings(SYNESIS_SANDBOX_ENABLED="false")
        assert s.sandbox_enabled is False
        s2 = self._make_settings(SYNESIS_SANDBOX_ENABLED="true")
        assert s2.sandbox_enabled is True

    def test_env_prefix(self):
        s = self._make_settings()
        assert s.model_config["env_prefix"] == "SYNESIS_"

    def test_float_parsing(self):
        s = self._make_settings(SYNESIS_FAILFAST_CACHE_TTL_SECONDS="3600.5")
        assert s.failfast_cache_ttl_seconds == 3600.5
