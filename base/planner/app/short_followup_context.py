"""Merge very short user replies with prior turns for classification and writing.

Interactive quizzes, role-play, and clarification threads often use one-letter or
few-token answers; the entry classifier and writer need the prior user request
in scope so routing and generation stay on topic.
"""

from __future__ import annotations

TRIVIAL_WRITER_SYSTEM_BASE = (
    "You are a helpful, knowledgeable assistant. Answer the user's question "
    "directly and concisely. Use markdown formatting where appropriate "
    "(headings, bold, lists, fenced code blocks). Keep the answer short — "
    "one to three paragraphs unless the user explicitly asks for more."
)

_TRIVIAL_CONTINUATION_HINT = (
    "\n\nThe user may send very short replies (a letter, a number, yes/no) as part of an "
    "ongoing exercise, quiz, or role-play. Use the prior turns in the conversation; "
    "continue that thread and do not treat the message as a brand-new unrelated question."
)


def merge_short_followup_for_classification(
    last_content: str,
    conversation_history: list[str] | None,
    *,
    short_len: int = 48,
) -> str:
    """Attach prior user context when the latest message is a short follow-up.

    Covers quizzes ("B"), role-play cues ("yes"), and similar patterns so they are not
    scored as isolated trivial prompts.
    """
    if not last_content or not conversation_history:
        return last_content
    stripped = last_content.strip()
    if len(stripped) >= short_len:
        return last_content

    substantive = ""
    for entry in reversed(conversation_history):
        if isinstance(entry, str) and entry.startswith("[user]: "):
            body = entry[8:].strip()
            if len(body) >= short_len:
                substantive = body
                break
    if not substantive:
        for entry in reversed(conversation_history):
            if isinstance(entry, str) and entry.startswith("[user]: "):
                substantive = entry[8:].strip()
                break
    if not substantive or substantive == stripped:
        return last_content
    return f"{substantive}\n\n(User follow-up: {stripped})"


def effective_user_query(
    last_user_content: str | None,
    task_description: str | None,
    *,
    margin: int = 12,
) -> str:
    """Prefer classifier-merged task text when the raw message is a short interactive follow-up."""
    lu = (last_user_content or "").strip()
    td = (task_description or "").strip()
    if td and len(td) > len(lu) + margin:
        return td
    return lu or td


def build_trivial_writer_system_prompt(has_nonempty_history: bool) -> str:
    """System prompt for the fast-stream writer path; adds continuation rules when history exists."""
    prompt = TRIVIAL_WRITER_SYSTEM_BASE
    if has_nonempty_history:
        prompt += _TRIVIAL_CONTINUATION_HINT
    return prompt


def conversation_history_to_openai_messages(
    conversation_history: list[str],
    *,
    tail: int = 6,
) -> list[dict[str, str]]:
    """Turn memory-style history lines into OpenAI-style role messages (same contract as writer)."""
    messages: list[dict[str, str]] = []
    for entry in conversation_history[-tail:]:
        if not isinstance(entry, str):
            continue
        if entry.startswith("[user]: "):
            messages.append({"role": "user", "content": entry[8:]})
        elif entry.startswith("[assistant]: "):
            messages.append({"role": "assistant", "content": entry[13:]})
        elif entry.startswith("[system]: "):
            messages.append({"role": "system", "content": entry[10:]})
    return messages
