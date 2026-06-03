"""Text normalization helpers for language-pack extraction."""

from __future__ import annotations

import html
import re

from .extract import html_to_markdown, normalize_doc_markdown

CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
HTML_TAG_RE = re.compile(r"<[^>]+>")
HTML_SIGNAL_RE = re.compile(r"<(?:!doctype|html|head|body|main|article|section|div|p|h[1-6]|nav|footer)\b", re.I)


def basic_source_text_cleanup(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_CHAR_RE.sub("", text)
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def strip_html_tags(text: str) -> str:
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(?:p|div|section|article|li|h[1-6]|tr)>", "\n", text)
    return basic_source_text_cleanup(html.unescape(HTML_TAG_RE.sub("", text)))


def normalize_source_text_by_format(text: str, content_format: str) -> tuple[str, str]:
    original_format = (content_format or "").lower().strip()
    text = basic_source_text_cleanup(text)
    if not text:
        return "", original_format or "text"

    has_html_signal = bool(HTML_SIGNAL_RE.search(text[:4096]))
    looks_html = original_format in {"html", "htm"} or has_html_signal
    if looks_html and has_html_signal:
        markdown = normalize_doc_markdown(html_to_markdown(text))
        if markdown:
            return markdown, "markdown"
        return strip_html_tags(text), "text"
    if original_format in {"html", "htm"}:
        return normalize_doc_markdown(text), "markdown"

    if original_format in {"md", "markdown"}:
        return normalize_doc_markdown(text), "markdown"

    if original_format in {"rst", "adoc", "txt", "text", "texi", "1", ""}:
        return normalize_doc_markdown(text), original_format or "text"

    return text, original_format
