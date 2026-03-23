"""Trust envelope reducer: deterministic layout for structured client context."""

from __future__ import annotations

from app.context.reducer import build_user_turn_content, escape_evidence_text, wrap_tool_result_content
from app.context.schemas import EvidenceObject, SynesisCoderContext


class TestEscapeEvidenceText:
    def test_escapes_tags(self):
        s = escape_evidence_text('<synesis_coder_turn v="1">')
        assert "&lt;synesis_coder_turn" in s


class TestBuildUserTurnContent:
    def test_minimal_turn_stable_prefix(self):
        a = build_user_turn_content("hi", None)
        b = build_user_turn_content("hi", None)
        assert a == b
        assert a.startswith('<synesis_coder_turn v="1">')
        assert "hi" in a
        assert a.endswith("</synesis_coder_turn>")

    def test_evidence_sorted_by_kind_label_body(self):
        ctx = SynesisCoderContext(
            evidence_objects=[
                EvidenceObject(kind="z", label="b", body="BODY_Z"),
                EvidenceObject(kind="a", label="b", body="BODY_AB"),
                EvidenceObject(kind="a", label="a", body="BODY_AA"),
            ]
        )
        out = build_user_turn_content("x", ctx)
        assert out.index("BODY_AA") < out.index("BODY_AB") < out.index("BODY_Z")

    def test_task_pack_json_sorted_keys(self):
        ctx = SynesisCoderContext(task_pack={"z": 1, "a": 2})
        out = build_user_turn_content(".", ctx)
        # stable key order in JSON (then HTML-escaped for the field body)
        assert out.index("&quot;a&quot;") < out.index("&quot;z&quot;")

    def test_empty_context_omits_structured_block(self):
        out = build_user_turn_content("only", SynesisCoderContext())
        assert "synesis_structured_context" not in out


class TestWrapToolResult:
    def test_wraps_name_and_body(self):
        w = wrap_tool_result_content("grep", "line1\nline2")
        assert "synesis_tool_output" in w
        assert "grep" in w
        assert "line1" in w
