"""Merge very short user replies with prior turns for classification and writing.

Interactive quizzes, role-play, and clarification threads often use one-letter or
few-token answers; the entry classifier and writer need the prior user request
in scope so routing and generation stay on topic.
"""

from __future__ import annotations

import re
from typing import Any

# Match ConversationMemory.store_turn cap so client transcript lines align with server memory.
_HISTORY_CONTENT_CAP = 4096

TRIVIAL_WRITER_SYSTEM_BASE = (
    "You are a helpful, knowledgeable assistant. Answer the user's question "
    "directly and concisely. Use markdown formatting where appropriate "
    "(headings, bold, lists, fenced code blocks). Keep the answer short — "
    "one to three paragraphs unless the user explicitly asks for more."
)

_TRIVIAL_CONTINUATION_HINT = (
    "\n\nThe user may send very short replies (a letter, a number, yes/no, forms like "
    '"b)" / "A.", "B) eclectic", "A the derivative", or just the option word) as part '
    "of an ongoing exercise, quiz, or role-play. Use the prior turns in the conversation; "
    'continue that thread. Do not refuse or ask for the "full question" when the answer is '
    "clearly a follow-up to your previous message."
)


_LETTER_PAREN_THEN_TEXT = re.compile(r"^[A-Da-d][\.\)]\s*\S", re.IGNORECASE)
_LETTER_SPACE_THEN_TEXT = re.compile(r"^[A-Da-d][\.\)]?\s+\S", re.IGNORECASE)


def reply_looks_like_quiz_letter_or_word_form(text: str, *, max_len: int = 160) -> bool:
    """Letter + optional punctuation + option wording (e.g. \"B) eclectic\", \"A derivative\")."""
    t = (text or "").strip()
    if not t or len(t) > max_len or "\n" in t:
        return False
    if _LETTER_PAREN_THEN_TEXT.match(t):
        return True
    if _LETTER_SPACE_THEN_TEXT.match(t):
        return True
    return False


def should_merge_short_followup_content(stripped: str, *, short_len: int = 48) -> bool:
    """True if this user line should inherit prior context (short or letter+word quiz shape)."""
    if len(stripped) < short_len:
        return True
    return reply_looks_like_quiz_letter_or_word_form(stripped)


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
    if not should_merge_short_followup_content(stripped, short_len=short_len):
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


def prior_transcript_from_request_messages(
    messages: list[Any],
    *,
    content_cap: int = _HISTORY_CONTENT_CAP,
) -> list[str]:
    """Build [user]/[assistant] lines from the client request before the latest user message.

    Open WebUI and other clients send the full thread in ``messages`` while L1 memory may be
    empty or a different scope; this recovers assistant quiz text for short follow-ups.
    """
    if not messages:
        return []
    last_user_idx: int | None = None
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        role = (getattr(m, "role", None) or "").strip().lower()
        if role == "user":
            last_user_idx = i
            break
    if last_user_idx is None:
        return []

    lines: list[str] = []
    for m in messages[:last_user_idx]:
        role = (getattr(m, "role", None) or "").strip().lower()
        raw = getattr(m, "content", None)
        text = raw.strip() if isinstance(raw, str) else (str(raw) if raw is not None else "")
        if not text:
            continue
        text = text[:content_cap]
        if role == "user":
            lines.append(f"[user]: {text}")
        elif role == "assistant":
            lines.append(f"[assistant]: {text}")
        elif role == "system":
            lines.append(f"[system]: {text}")
    return lines


def pick_richer_conversation_transcript(
    memory_lines: list[str],
    client_lines: list[str],
) -> list[str]:
    """Prefer client transcript when it carries more text (e.g. full quiz vs truncated memory)."""
    if not client_lines:
        return list(memory_lines)
    if not memory_lines:
        return list(client_lines)
    sm = sum(len(x) for x in memory_lines)
    sc = sum(len(x) for x in client_lines)
    if sc > sm:
        return list(client_lines)
    if sm > sc:
        return list(memory_lines)
    if len(client_lines) > len(memory_lines):
        return list(client_lines)
    return list(memory_lines)


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
