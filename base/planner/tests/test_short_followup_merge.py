"""Short follow-up merge for interactive quizzes and role-play continuations."""

from app.short_followup_context import merge_short_followup_for_classification


def test_merge_letter_answer_with_prior_user_turn():
    hist = [
        "[user]: Help me study vocabulary: write a sentence with a blank and options.",
        "[assistant]: Sentence: The cat sat. Options: A) x B) y",
    ]
    out = merge_short_followup_for_classification("B", hist)
    assert "Help me study vocabulary" in out
    assert "User follow-up: B" in out


def test_merge_skips_when_no_substantive_prior_user():
    hist = ["[assistant]: Hello!"]
    assert merge_short_followup_for_classification("B", hist) == "B"


def test_merge_skips_long_message():
    long_msg = "x" * 60
    hist = ["[user]: " + long_msg, "[assistant]: ok"]
    assert merge_short_followup_for_classification(long_msg, hist) == long_msg
