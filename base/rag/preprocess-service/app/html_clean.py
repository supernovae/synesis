"""Boilerplate removal from HTML via jusText (CPU-only)."""

from __future__ import annotations

import logging

import justext

logger = logging.getLogger("synesis.preprocess.html_clean")


def clean_html_to_text(html: str, language: str = "English") -> str:
    """Extract main text from HTML; drop boilerplate paragraphs."""
    if not html or not html.strip():
        return ""
    try:
        stoplist = justext.get_stoplist(language)
    except KeyError:
        stoplist = justext.get_stoplist("English")
    try:
        paragraphs = justext.justext(html, stoplist)
    except Exception as e:
        logger.warning("justext_failed: %s", e)
        return ""
    parts = [p.text for p in paragraphs if not p.is_boilerplate and p.text.strip()]
    return "\n\n".join(parts).strip()
