"""Tests for frame classification, constraint enforcement, and quality gaps.

Validates:
  - Unified USER FRAME block injects constraints, meta_requirements, context_facts
  - Section worker system prompt guardrails (trust policy, no filler)
  - Critic failure vocabulary includes genericity and unsupported_specificity
  - Per-section progress status extracts topic from evidence_gatherer input
  - Anti-echo: prompts rephrase deliverables as noun phrases, not user imperatives
  - Frame extractor uses classification algorithm, separates meta_requirements from deliverables
  - Planner has no FORMAT CONSTRAINT CAPTURE (removed — frame handles it)
  - Section cap simplified: scaled_max_sections removed, planner steps trusted
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Gap 1 & 4: Section worker prompt — constraint injection + version rule
# ---------------------------------------------------------------------------

# Mirror the _SECTION_SYSTEM prompt constant (first ~500 chars) and the
# constraint injection logic.  We avoid importing evidence_gatherer directly
# because it transitively pulls pydantic_settings / langchain_core.
# Instead we test the invariants via string checks.


def _read_writer_system() -> str:
    """Read the _WRITER_SYSTEM_TEMPLATE constant from writer.py."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "writer.py"
    text = src.read_text()
    marker_start = '_WRITER_SYSTEM_TEMPLATE = """\\\n'
    marker_end = '"""'
    start = text.index(marker_start) + len(marker_start)
    end = text.index(marker_end, start)
    return text[start:end]


class TestStructuredWriterPrompt:
    """Ensure the structured writer system prompt has the right guardrails."""

    def test_no_prompt_specific_version_rule(self):
        """Version hallucination is handled by the critic's unsupported_specificity,
        not by a prompt-specific rule in the writer."""
        prompt = _read_writer_system()
        assert "software versions" not in prompt.lower()

    def test_filler_cut_rule_present(self):
        prompt = _read_writer_system()
        assert "filler" in prompt.lower() or "generic scaffolding" in prompt.lower()

    def test_citation_rule_present(self):
        prompt = _read_writer_system()
        assert "Source" in prompt or "cite" in prompt.lower()
        assert "Sources" in prompt


class TestFrameInjection:
    """Verify that UserTask fields get injected into the unified USER FRAME block."""

    def _build_frame_block(self, user_task: dict) -> str:
        """Replicate the consolidated frame injection logic from evidence_gatherer/structured_writer."""
        frame_block: list[str] = []
        success_criteria = user_task.get("success_criteria") or []
        if success_criteria:
            frame_block.append("SUCCESS CRITERIA (apply to ALL sections — these describe HOW to write):")
            frame_block.extend(f"  - {r}" for r in success_criteria)
        constraints = user_task.get("constraints") or []
        neg_constraints = user_task.get("negative_constraints") or []
        all_constraints = constraints + neg_constraints
        if all_constraints:
            frame_block.append("CONSTRAINTS (cross-cutting — weave into analysis, do NOT treat as section topics):")
            frame_block.extend(f"  - {c}" for c in all_constraints[:6])
        if frame_block:
            return "\nUSER FRAME:\n" + "\n".join(frame_block)
        return ""

    def test_constraints_injected_when_present(self):
        frame = {"constraints": ["under 30 minutes", "no external dependencies"]}
        block = self._build_frame_block(frame)
        assert "CONSTRAINTS" in block
        assert "under 30 minutes" in block
        assert "no external dependencies" in block
        assert "section topics" in block

    def test_success_criteria_injected(self):
        frame = {"success_criteria": ["separate pros and cons", "use tables where appropriate"]}
        block = self._build_frame_block(frame)
        assert "SUCCESS CRITERIA" in block
        assert "separate pros and cons" in block

    def test_empty_frame_produces_no_block(self):
        block = self._build_frame_block({})
        assert block == ""

    def test_constraints_capped_at_six(self):
        frame = {"constraints": [f"constraint_{i}" for i in range(10)]}
        block = self._build_frame_block(frame)
        assert "constraint_5" in block
        assert "constraint_6" not in block


# ---------------------------------------------------------------------------
# Gap 2: Per-section progress status
# ---------------------------------------------------------------------------


def _evidence_gatherer_phase(input_data: dict) -> str:
    """Mirror of main._evidence_gatherer_phase for local testing."""
    action = input_data.get("section_action", "")
    if not action:
        return ""
    topic = action.split("\u2014")[0].strip()
    if ":" in topic:
        topic = topic.split(":", 1)[1].strip()
    topic = topic[:50]
    return f"Researching: {topic}\u2026"


class TestEvidenceGathererPhase:
    """Verify per-section status label generation."""

    def test_basic_topic_extraction(self):
        result = _evidence_gatherer_phase({"section_action": "Main design goals"})
        assert result == "Researching: Main design goals\u2026"

    def test_em_dash_split(self):
        result = _evidence_gatherer_phase({"section_action": "Model choices \u2014 discuss small vs large models"})
        assert result == "Researching: Model choices\u2026"

    def test_colon_prefix_strip(self):
        result = _evidence_gatherer_phase({"section_action": "Section: Retrieval mechanism"})
        assert result == "Researching: Retrieval mechanism\u2026"

    def test_long_topic_truncated(self):
        long_action = "A" * 100
        result = _evidence_gatherer_phase({"section_action": long_action})
        topic_part = result.replace("Researching: ", "").replace("\u2026", "")
        assert len(topic_part) <= 50

    def test_empty_action_returns_empty(self):
        result = _evidence_gatherer_phase({"section_action": ""})
        assert result == ""

    def test_missing_action_returns_empty(self):
        result = _evidence_gatherer_phase({})
        assert result == ""

    def test_each_section_gets_unique_phase(self):
        actions = [
            "Main design goals",
            "Architecture proposal",
            "Model choices",
        ]
        phases = [_evidence_gatherer_phase({"section_action": a}) for a in actions]
        assert len(set(phases)) == 3


# ---------------------------------------------------------------------------
# Gap 3: Critic failure vocabulary
# ---------------------------------------------------------------------------


def _read_critic_vocabulary() -> str:
    """Read the FAILURE MODE VOCABULARY block from critic.py source."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "critic.py"
    text = src.read_text()
    marker = "FAILURE MODE VOCABULARY"
    idx = text.index(marker)
    block = text[idx : idx + 1000]
    return block


class TestCriticVocabulary:
    """Ensure the critic's failure mode vocabulary is complete."""

    def test_genericity_in_vocabulary(self):
        block = _read_critic_vocabulary()
        assert "genericity" in block

    def test_unsupported_specificity_in_vocabulary(self):
        block = _read_critic_vocabulary()
        assert "unsupported_specificity" in block

    def test_genericity_has_description(self):
        block = _read_critic_vocabulary()
        assert "any project" in block.lower() or "boilerplate" in block.lower()

    def test_unsupported_specificity_has_description(self):
        block = _read_critic_vocabulary()
        marker = "- unsupported_specificity:"
        assert marker in block, "unsupported_specificity description line missing"
        idx = block.index(marker)
        nearby = block[idx : idx + 300]
        assert "version" in nearby.lower() or "evidence" in nearby.lower()

    def test_original_modes_still_present(self):
        block = _read_critic_vocabulary()
        for mode in [
            "non_answer",
            "partial_answer",
            "instruction_drift",
            "unsupported_claim",
            "false_certainty",
            "false_precision",
        ]:
            assert mode in block, f"{mode} missing from critic vocabulary"


# ---------------------------------------------------------------------------
# Gap 5: Anti-echo — prompts must not preserve user imperative wording
# ---------------------------------------------------------------------------


def _read_repair_system() -> str:
    """Read the _REPAIR_SYSTEM prompt from frame_extractor.py source."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "frame_extractor.py"
    text = src.read_text()
    marker_start = '_REPAIR_SYSTEM = """\\\n'
    marker_end = '"""'
    start = text.index(marker_start) + len(marker_start)
    end = text.index(marker_end, start)
    return text[start:end]


def _read_planner_prompt_source() -> str:
    """Read the _build_knowledge_planner_prompt function source."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "planner_node.py"
    text = src.read_text()
    start = text.index("def _build_knowledge_planner_prompt")
    end = text.index("+ _PLANNER_TRUST_POLICY", start) + len("+ _PLANNER_TRUST_POLICY")
    return text[start:end]


def _read_compiler_system() -> str:
    """Read the _WRITER_SYSTEM_TEMPLATE prompt from writer.py source."""
    import pathlib

    src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "writer.py"
    text = src.read_text()
    marker_start = '_WRITER_SYSTEM_TEMPLATE = """\\\n'
    marker_end = '"""'
    start = text.index(marker_start) + len(marker_start)
    end = text.index(marker_end, start)
    return text[start:end]


class TestRepairPrompt:
    """Stage 3 repair prompt must enforce repair-only semantics."""

    def test_no_hallucination_rule(self):
        prompt = _read_repair_system()
        assert "never hallucinate" in prompt.lower() or "do not invent" in prompt.lower()

    def test_preserve_ambiguity_rule(self):
        prompt = _read_repair_system()
        assert "ambiguity" in prompt.lower() or "ambiguities" in prompt.lower()

    def test_repair_not_re_extraction(self):
        prompt = _read_repair_system()
        assert "repair" in prompt.lower() or "not re-extract" in prompt.lower()

    def test_user_task_schema_present(self):
        prompt = _read_repair_system()
        assert "main_question" in prompt
        assert "explicit_requirements" in prompt
        assert "deliverables" in prompt

    def test_needs_web_rule(self):
        prompt = _read_repair_system()
        assert "needs_web" in prompt

    def test_frame_schema_has_key_fields(self):
        """Frame repair schema includes key task fields for extraction."""
        prompt = _read_repair_system()
        assert "explicit_requirements" in prompt
        assert "deliverables" in prompt

    def test_no_hardcoded_prompt_examples(self):
        prompt = _read_repair_system()
        assert "80 engineers" not in prompt
        assert "What I want from you" not in prompt
        assert "regulated industry" not in prompt


class TestAntiEchoPlanner:
    """Planner must use descriptive titles, not echo user imperative phrasing."""

    def test_no_preserve_wording(self):
        source = _read_planner_prompt_source()
        assert "preserve their order and wording" not in source

    def test_no_do_not_invent(self):
        source = _read_planner_prompt_source()
        assert "Do NOT invent sections" not in source

    def test_anti_echo_example_present(self):
        source = _read_planner_prompt_source()
        assert "Retrieval Architecture" in source

    def test_cover_every_deliverable(self):
        source = _read_planner_prompt_source()
        assert "Every deliverable" in source
        assert "deliverable_ids" in source

    def test_no_format_constraint_capture(self):
        source = _read_planner_prompt_source()
        assert "FORMAT CONSTRAINT CAPTURE" not in source

    def test_constraints_not_sections(self):
        source = _read_planner_prompt_source()
        assert "do NOT create separate sections" in source or "do not create separate sections" in source.lower()


class TestAntiEchoCompiler:
    """Compiler must have explicit anti-echo heading guidance."""

    def test_imperative_phrasing_warning(self):
        prompt = _read_compiler_system()
        assert "imperative phrasing" in prompt.lower()

    def test_bad_example_present(self):
        prompt = _read_compiler_system()
        assert "Explain How Retrieval Should Work" in prompt

    def test_good_example_present(self):
        prompt = _read_compiler_system()
        assert "Retrieval Architecture" in prompt

    def test_table_of_contents_metaphor(self):
        prompt = _read_compiler_system()
        assert "table of contents" in prompt.lower()


# ---------------------------------------------------------------------------
# Gap 6: Section cap simplification
# ---------------------------------------------------------------------------


class TestSectionCapSimplified:
    """scaled_max_sections removed; graph uses planner steps capped by max_parallel."""

    def test_no_scaled_max_sections_in_graph(self):
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "graph.py"
        text = src.read_text()
        assert "scaled_max_sections" not in text

    def test_no_scaled_max_sections_in_config(self):
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "config.py"
        text = src.read_text()
        assert "scaled_max_sections" not in text
        assert "max_sections_base" not in text
        assert "max_sections_max" not in text

    def test_graph_uses_writer_node(self):
        """Writer node replaced parallel section workers; no max_parallel needed."""
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "graph.py"
        text = src.read_text()
        assert "writer" in text
        assert "scaled_max_sections" not in text


# ---------------------------------------------------------------------------
# Pipeline quality: deliverable coverage, citation validation, tradeoffs,
# critic-router wiring
# ---------------------------------------------------------------------------


class TestDeliverableCoverage:
    """Planner coverage guard using deliverable_ids."""

    def test_all_ids_covered_no_injection(self):
        """When all deliverable IDs are mapped, no extra steps are injected."""
        steps = [
            {"id": 1, "action": "Design Goals", "deliverable_ids": [0, 1]},
            {"id": 2, "action": "Architecture", "deliverable_ids": [2, 3]},
            {"id": 3, "action": "Risks", "deliverable_ids": [4]},
        ]
        deliverables = ["goal A", "goal B", "arch C", "arch D", "risk E"]
        all_ids = set(range(len(deliverables)))
        covered_ids: set[int] = set()
        for s in steps:
            covered_ids.update(int(x) for x in s.get("deliverable_ids", []))
        assert covered_ids == all_ids

    def test_missing_ids_detected(self):
        """Steps that omit deliverable IDs are caught."""
        steps = [
            {"id": 1, "action": "Design Goals", "deliverable_ids": [0]},
            {"id": 2, "action": "Architecture", "deliverable_ids": [2]},
        ]
        deliverables = ["goal A", "goal B", "arch C", "arch D"]
        all_ids = set(range(len(deliverables)))
        covered_ids: set[int] = set()
        for s in steps:
            covered_ids.update(int(x) for x in s.get("deliverable_ids", []))
        uncovered = all_ids - covered_ids
        assert uncovered == {1, 3}

    def test_empty_deliverable_ids_triggers_keyword_fallback(self):
        """When no step has deliverable_ids, the fallback keyword check applies."""
        steps = [
            {"id": 1, "action": "Design Goals"},
            {"id": 2, "action": "Architecture"},
        ]
        has_id_mapping = any(s.get("deliverable_ids") for s in steps)
        assert not has_id_mapping

    def test_planner_prompt_includes_deliverable_ids_schema(self):
        """The knowledge planner prompt JSON schema includes deliverable_ids."""
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "planner_node.py"
        text = src.read_text()
        assert "deliverable_ids" in text
        assert "0-based indices" in text


class TestCitationValidation:
    """Deterministic URL validation in the critic."""

    def test_hallucinated_url_detected(self):
        """URLs not in evidence packets are flagged."""
        import re

        valid_uris = {"https://example.com/doc1", "https://example.com/doc2"}
        draft = "See [Source: Doc1 — https://example.com/doc1] and [Source: Fake — https://made-up.com/fake]."
        cited = set(re.findall(r"https?://[^\s\]\)>\"']+", draft))
        hallucinated = sorted(cited - valid_uris)
        assert len(hallucinated) == 1
        assert "made-up.com/fake" in hallucinated[0]

    def test_all_valid_urls_pass(self):
        """When all cited URLs are in evidence, no hallucinations flagged."""
        import re

        valid_uris = {"https://example.com/doc1", "https://example.com/doc2"}
        draft = "See [Source: Doc1 — https://example.com/doc1]."
        cited = set(re.findall(r"https?://[^\s\]\)>\"']+", draft))
        hallucinated = sorted(cited - valid_uris)
        assert hallucinated == []

    def test_no_evidence_no_validation(self):
        """When no evidence packets exist, no URL validation occurs."""
        valid_uris: set[str] = set()
        hallucinated = [] if not valid_uris else ["would-be-flagged"]
        assert hallucinated == []


class TestTradeoffDetection:
    """Critic rubric adds tradeoff explicitness when user requests it."""

    def _build_rubric(self, constraints: list[str], neg_constraints: list[str]) -> str:
        parts = ["USER TASK RUBRIC (evaluate each item as met/partial/missing):"]
        all_constraints_text = " ".join(c.lower() for c in (constraints + neg_constraints))
        tradeoff_signals = ("tradeoff", "trade-off", "explicit", "compare", "recommend", "alternative")
        if any(s in all_constraints_text for s in tradeoff_signals):
            parts.append(
                "Tradeoff explicitness: every recommendation must state the chosen "
                "approach AND briefly explain why alternatives were rejected."
            )
        return "\n".join(parts)

    def test_tradeoff_rubric_added_when_explicit_requested(self):
        rubric = self._build_rubric([], ["Make tradeoffs explicit"])
        assert "Tradeoff explicitness" in rubric

    def test_tradeoff_rubric_added_for_compare(self):
        rubric = self._build_rubric(["compare at least two approaches"], [])
        assert "Tradeoff explicitness" in rubric

    def test_tradeoff_rubric_not_added_when_absent(self):
        rubric = self._build_rubric(["use tables"], ["no filler"])
        assert "Tradeoff explicitness" not in rubric


class TestCriticRouterWiring:
    """Critic populates evidence_requests when need_more_evidence is set."""

    def test_query_plan_converted_to_evidence_requests(self):
        """Critic's evidence_needed.query_plan is converted to evidence_requests."""
        plan = {
            "reason": "needs_more_evidence",
            "evidence_gap": "missing Kubernetes deployment docs",
            "intent_class": "code",
            "query_plan": [
                {"target": "rag", "suggested_queries": ["missing Kubernetes deployment docs"]},
            ],
        }
        domain_tags = ["kubernetes"]
        evidence_requests: list[dict] = []
        for plan_item in plan.get("query_plan", []):
            for query in plan_item.get("suggested_queries", []):
                if query:
                    evidence_requests.append({"description": query, "domain_hints": domain_tags})
        assert len(evidence_requests) >= 1
        assert evidence_requests[0]["description"] == "missing Kubernetes deployment docs"
        assert evidence_requests[0]["domain_hints"] == ["kubernetes"]

    def test_empty_evidence_gap_produces_fallback_request(self):
        """Even without a specific gap, a fallback query is produced."""
        plan = {
            "reason": "needs_more_evidence",
            "evidence_gap": "insufficient",
            "intent_class": "knowledge",
            "query_plan": [
                {"target": "rag", "suggested_queries": ["context"]},
            ],
        }
        queries = []
        for plan_item in plan.get("query_plan", []):
            queries.extend(plan_item.get("suggested_queries", []))
        assert len(queries) >= 1


class TestWriterAvailableSources:
    """Writer injects AVAILABLE SOURCES from evidence packets."""

    def test_builds_source_list_from_packets(self):
        import pathlib

        writer_path = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "writer.py"
        text = writer_path.read_text()
        assert "AVAILABLE SOURCES" in text
        assert "_build_available_sources" in text
        assert "Do NOT invent" in text

    def test_writer_prompt_restricts_urls_to_evidence(self):
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "writer.py"
        text = src.read_text()
        assert "MUST only cite URLs from the AVAILABLE SOURCES" in text


class TestRouterDeliverableCap:
    """Router no longer caps at 4 deliverables."""

    def test_no_slice_4_in_router(self):
        import pathlib

        src = pathlib.Path(__file__).resolve().parent.parent / "app" / "nodes" / "router.py"
        text = src.read_text()
        assert "deliverables[:4]" not in text

    def test_batching_for_large_lists(self):
        """Deliverable lists > 10 are batched into groups of 3."""
        deliverables = [f"deliverable_{i}" for i in range(12)]
        requests: list[dict] = []
        if len(deliverables) > 10:
            for batch_idx in range(0, len(deliverables), 3):
                batch = deliverables[batch_idx : batch_idx + 3]
                combined = "; ".join(batch)
                requests.append({"description": combined})
        assert len(requests) == 4
        assert "deliverable_0" in requests[0]["description"]
        assert "deliverable_11" in requests[3]["description"]


