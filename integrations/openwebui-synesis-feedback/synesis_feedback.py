"""
title: Synesis Feedback Dashboard
author: Synesis
author_url: https://github.com/synesis
git_url: https://github.com/synesis/synesis
description: View Synesis classifier feedback (thumbs up/down) with classification context for tuning. Fetches from Synesis planner GET /v1/feedback.
required_open_webui_version: "0.2.0"
requirements: httpx
version: 0.1.0
licence: Apache-2.0
"""

from __future__ import annotations

import logging
from typing import Any

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    httpx = None
    HAS_HTTPX = False

from pydantic import BaseModel, Field

logger = logging.getLogger("synesis_feedback")


def _fetch_feedback(url: str, params: dict) -> dict:
    """Fetch GET /v1/feedback. Use httpx if available, else urllib."""
    import urllib.request
    import urllib.parse

    qs = urllib.parse.urlencode(params)
    full_url = f"{url}/v1/feedback?{qs}"
    req = urllib.request.Request(full_url)
    with urllib.request.urlopen(req, timeout=10) as r:
        import json
        return json.loads(r.read().decode())


class Pipe:
    """Pipe that displays Synesis feedback. Use as a model: select 'Synesis Feedback', send 'show' or 'show down'."""

    class Valves(BaseModel):
        synesis_planner_url: str = Field(
            default="http://synesis-planner:8000",
            description="Synesis planner URL (e.g. http://synesis-planner:8000)",
        )
        limit: int = Field(default=20, ge=1, le=100, description="Max feedback entries to fetch")

    def __init__(self):
        self.type = "pipe"
        self.id = "synesis_feedback"
        self.name = "Synesis Feedback"
        self.valves = self.Valves()

    def pipe(self, body: dict) -> str:
        """Fetch and format feedback from Synesis planner."""
        url = (self.valves.synesis_planner_url or "").rstrip("/")
        if not url:
            return "**Error:** Set `synesis_planner_url` in plugin Valves (Admin Settings → Functions → Synesis Feedback)"

        # Parse user message for filters
        messages = body.get("messages", [])
        last_content = ""
        for m in reversed(messages):
            if isinstance(m, dict) and m.get("role") == "user":
                last_content = str(m.get("content", "")).strip().lower()
                break
            if hasattr(m, "content") and getattr(m, "role", None) == "user":
                last_content = str(getattr(m, "content", "")).strip().lower()
                break

        vote_filter = None
        if "down" in last_content or "thumbs down" in last_content or "negative" in last_content:
            vote_filter = "down"
        elif "up" in last_content or "thumbs up" in last_content or "positive" in last_content:
            vote_filter = "up"

        params = {"limit": self.valves.limit}
        if vote_filter:
            params["vote"] = vote_filter

        try:
            if HAS_HTTPX:
                with httpx.Client(timeout=10.0) as client:
                    r = client.get(f"{url}/v1/feedback", params=params)
                    r.raise_for_status()
                    data = r.json()
            else:
                data = _fetch_feedback(url, params)
        except Exception as e:
            logger.warning("synesis_feedback_error url=%s error=%s", url, e)
            if HAS_HTTPX and isinstance(e, httpx.ConnectError):
                return f"**Connection error:** Cannot reach Synesis planner at `{url}`. Check URL and network."
            if HAS_HTTPX and isinstance(e, httpx.HTTPStatusError):
                return f"**HTTP error:** {e.response.status_code} from `{url}/v1/feedback`"
            return f"**Error:** {e!s}"

        entries = data.get("data", [])
        if not entries:
            filter_msg = f" (vote={vote_filter})" if vote_filter else ""
            return f"No feedback entries found{filter_msg}. Use POST /v1/feedback to store votes, or run a chat and thumbs up/down."

        lines = [
            f"## Synesis Feedback ({len(entries)} entries)",
            "",
            f"*From `{url}/v1/feedback`*",
            "",
        ]
        for i, e in enumerate(entries, 1):
            vote_emoji = "👍" if e.get("vote") == "up" else "👎"
            lines.append(f"### {i}. {vote_emoji} {e.get('vote', '?')} — {e.get('timestamp', '')[:19]}")
            lines.append("")
            lines.append(f"- **Message:** {_truncate(e.get('message_snippet', ''), 100)}")
            lines.append(f"- **Response:** {_truncate(e.get('response_snippet', ''), 100)}")
            lines.append(f"- **task_size:** `{e.get('task_size', '')}`")
            reasons = e.get("classification_reasons", [])
            if reasons:
                lines.append(f"- **Reasons:** {', '.join(str(r) for r in reasons[:5])}")
            breakdown = e.get("score_breakdown", {})
            if breakdown:
                parts = [f"{k}:{v}" for k, v in list(breakdown.items())[:5]]
                lines.append(f"- **Score:** {', '.join(parts)}")
            lines.append("")

        return "\n".join(lines)


def _truncate(s: str, max_len: int) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s or "(empty)"
    return s[:max_len] + "…"
