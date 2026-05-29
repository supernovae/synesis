"""Tests for built-in Prompt Library model-family defaults."""

from pathlib import Path


def test_deepseek_and_xiaomi_prompt_family_defaults_are_allowed() -> None:
    source = Path("app/services/prompt_library.py").read_text(encoding="utf-8")

    assert '"deepseek"' in source
    assert '"xiaomi"' in source
    assert 'YARN_DEEPSEEK_PROFILE_NAME = "yarn-' in source
    assert 'YARN_XIAOMI_PROFILE_NAME = "yarn-' in source
    assert 'PLANNER_DEEPSEEK_PROFILE_NAME = "planner-' in source
    assert 'PLANNER_XIAOMI_PROFILE_NAME = "planner-' in source


def test_prompt_library_allows_planner_chat_profile_targets() -> None:
    source = Path("app/services/prompt_library.py").read_text(encoding="utf-8")

    assert '"chat_profile"' in source
    assert '"roleplay_creative_continuity"' in source
    assert '"rag_grounded_answer"' in source
