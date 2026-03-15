"""Tests for search source catalog: loading, selection, authority derivation.

Validates:
- YAML parsing and default fallback behavior
- Source selection by domain tags, task types, and prompt aliases
- engine_authority_map derivation from source trust metadata
- Prompt-level source hint extraction from user queries
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from app.search_sources import (
    SearchSource,
    SourceRouting,
    SourceTrust,
    _default_sources,
    derive_engine_authority_map,
    load_search_sources,
    select_sources,
)


class TestDefaultSources:
    def test_returns_two_defaults(self):
        sources = _default_sources()
        assert len(sources) == 2
        ids = {s.id for s in sources}
        assert "web_general" in ids
        assert "code_general" in ids

    def test_web_general_is_always_on(self):
        sources = _default_sources()
        web = next(s for s in sources if s.id == "web_general")
        assert web.routing.always is True
        assert web.enabled is True

    def test_code_general_not_always(self):
        sources = _default_sources()
        code = next(s for s in sources if s.id == "code_general")
        assert code.routing.always is False


class TestLoadSearchSources:
    def test_loads_from_yaml(self, tmp_path: Path):
        yaml_content = textwrap.dedent("""\
            sources:
              - id: test_web
                label: "Test Web"
                enabled: true
                searxng_params:
                  categories: "general"
                trust:
                  authority: "external"
                  origin_type: "external"
                weight: 1.0
                max_results: 3
                fetch_pages: true
                routing:
                  always: true
              - id: test_jira
                label: "Jira"
                enabled: false
                searxng_params:
                  engines: "jira"
                trust:
                  authority: "canonical"
                  origin_type: "internal"
                weight: 1.4
                max_results: 5
                fetch_pages: false
                routing:
                  tags:
                    - project-management
                  prompt_aliases:
                    - jira
                    - tickets
        """)
        f = tmp_path / "search_sources.yaml"
        f.write_text(yaml_content)
        sources = load_search_sources(str(f))
        assert len(sources) == 2
        assert sources[0].id == "test_web"
        assert sources[1].id == "test_jira"
        assert sources[1].trust.authority == "canonical"
        assert sources[1].routing.prompt_aliases == ["jira", "tickets"]

    def test_missing_file_returns_defaults(self):
        sources = load_search_sources("/nonexistent/path.yaml")
        assert len(sources) == 2
        assert sources[0].id == "web_general"

    def test_empty_yaml_returns_defaults(self, tmp_path: Path):
        f = tmp_path / "empty.yaml"
        f.write_text("")
        sources = load_search_sources(str(f))
        assert len(sources) == 2


class TestSelectSources:
    @pytest.fixture()
    def sources(self) -> list[SearchSource]:
        return [
            SearchSource(
                id="web_general",
                enabled=True,
                routing=SourceRouting(always=True, prompt_aliases=["web"]),
            ),
            SearchSource(
                id="code_general",
                enabled=True,
                routing=SourceRouting(
                    tags=["software-engineering", "programming"],
                    task_types=["code"],
                    prompt_aliases=["code", "github"],
                ),
            ),
            SearchSource(
                id="jira_internal",
                enabled=False,
                routing=SourceRouting(
                    tags=["project-management"],
                    prompt_aliases=["jira", "tickets"],
                ),
            ),
        ]

    def test_always_sources_included(self, sources: list[SearchSource]):
        selected = select_sources(sources)
        ids = [s.id for s in selected]
        assert "web_general" in ids

    def test_domain_tag_match(self, sources: list[SearchSource]):
        selected = select_sources(sources, domain_tags=["programming"])
        ids = [s.id for s in selected]
        assert "code_general" in ids
        assert "web_general" in ids

    def test_task_type_match(self, sources: list[SearchSource]):
        selected = select_sources(sources, task_type="code")
        ids = [s.id for s in selected]
        assert "code_general" in ids

    def test_prompt_alias_overrides_disabled(self, sources: list[SearchSource]):
        selected = select_sources(sources, prompt_source_hints=["jira"])
        ids = [s.id for s in selected]
        assert "jira_internal" in ids

    def test_no_match_only_always(self, sources: list[SearchSource]):
        selected = select_sources(sources, domain_tags=["cooking"])
        ids = [s.id for s in selected]
        assert ids == ["web_general"]

    def test_empty_sources_returns_empty(self):
        assert select_sources([]) == []


class TestDeriveEngineAuthorityMap:
    def test_external_sources_excluded(self):
        sources = [
            SearchSource(
                id="web",
                searxng_params={"categories": "general"},
                trust=SourceTrust(authority="external", origin_type="external"),
            ),
        ]
        result = derive_engine_authority_map(sources)
        assert result == {}

    def test_internal_engines_mapped(self):
        sources = [
            SearchSource(
                id="jira",
                searxng_params={"engines": "jira,confluence"},
                trust=SourceTrust(authority="canonical", origin_type="internal"),
            ),
        ]
        result = derive_engine_authority_map(sources)
        assert "jira" in result
        assert result["jira"]["authority"] == "canonical"
        assert "confluence" in result
        assert result["confluence"]["origin_type"] == "internal"

    def test_no_duplicate_engines(self):
        sources = [
            SearchSource(
                id="src1",
                searxng_params={"engines": "github"},
                trust=SourceTrust(authority="vetted", origin_type="internal"),
            ),
            SearchSource(
                id="src2",
                searxng_params={"engines": "github"},
                trust=SourceTrust(authority="community", origin_type="external"),
            ),
        ]
        result = derive_engine_authority_map(sources)
        assert result["github"]["authority"] == "vetted"


class TestPromptSourceHints:
    def test_extract_include_github(self):
        from app.search_sources import extract_prompt_source_hints

        sources = _default_sources() + [
            SearchSource(
                id="jira",
                routing=SourceRouting(prompt_aliases=["jira", "tickets"]),
            ),
        ]
        hints = extract_prompt_source_hints("include jira for context", sources)
        assert "jira" in hints

    def test_extract_multiple_aliases(self):
        from app.search_sources import extract_prompt_source_hints

        sources = [
            SearchSource(id="gh", routing=SourceRouting(prompt_aliases=["github"])),
            SearchSource(id="jira", routing=SourceRouting(prompt_aliases=["jira"])),
        ]
        hints = extract_prompt_source_hints("search github+jira for details", sources)
        assert "github" in hints
        assert "jira" in hints

    def test_no_false_positives(self):
        from app.search_sources import extract_prompt_source_hints

        sources = [
            SearchSource(id="jira", routing=SourceRouting(prompt_aliases=["jira"])),
        ]
        hints = extract_prompt_source_hints("explain how kubernetes works", sources)
        assert hints == []

    def test_multiword_alias(self):
        from app.search_sources import extract_prompt_source_hints

        sources = [
            SearchSource(
                id="kb",
                routing=SourceRouting(prompt_aliases=["knowledge base"]),
            ),
        ]
        hints = extract_prompt_source_hints("search the knowledge base", sources)
        assert "knowledge base" in hints
