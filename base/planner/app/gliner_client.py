"""HTTP client for the Synesis GLiNER extraction service.

Follows the embed_client.py pattern: synchronous httpx with timeout,
singleton via get_gliner_client(). Returns typed FirstPassFrame.
"""

from __future__ import annotations

import logging

import httpx

from .schemas import FirstPassFrame, RawExtractionCandidate

logger = logging.getLogger("synesis.gliner_client")

_EXTRACTION_SCHEMA = {
    "entities": {
        "requirement": "Something the user wants produced, answered, or decided",
        "constraint": "A limit, restriction, boundary, or negative requirement",
        "deliverable": "An explicit output artifact or section the user expects",
        "technology": "A specific tool, framework, language, or platform mentioned",
        "timeline": "A deadline, urgency signal, or time constraint",
        "domain_hint": "Subject area or industry context",
        "quality_instruction": "How to respond — style, tone, format, uncertainty handling",
        "negative_constraint": "Something to avoid or not do",
        "decision_signal": "Request to choose, rank, compare, or recommend",
        "escalation_signal": "Uncertainty, safety, or evidence sensitivity cue",
        "output_format": "Requested format — table, code, bullet list, diagram, email",
    },
    "classification": {
        "categories": [
            "decision_required",
            "information_request",
            "creative_task",
            "technical_task",
            "planning_task",
        ],
    },
}

_LABEL_TO_FIELD = {
    "requirement": "requirements",
    "constraint": "constraints",
    "deliverable": "deliverables",
    "technology": "technologies",
    "timeline": "timeline_signals",
    "domain_hint": "domain_tags",
    "quality_instruction": "quality_instructions",
    "negative_constraint": "negative_constraints",
    "decision_signal": "decision_signals",
    "escalation_signal": "escalation_signals",
    "output_format": "formats",
}


class GlinerClient:
    """Synchronous client for the GLiNER extraction microservice.

    Uses a persistent httpx.Client for connection pooling / keepalive.
    """

    def __init__(self, url: str, timeout: float = 20.0):
        self.url = url.rstrip("/")
        self._client = httpx.Client(
            base_url=self.url,
            timeout=httpx.Timeout(connect=5.0, read=timeout, write=5.0, pool=5.0),
        )

    def extract(self, text: str, threshold: float = 0.4) -> FirstPassFrame:
        """Call /v1/extract and map the response into a FirstPassFrame."""
        resp = self._client.post(
            "/extract",
            json={
                "text": text,
                "schema": _EXTRACTION_SCHEMA,
                "threshold": threshold,
            },
        )
        resp.raise_for_status()
        data = resp.json()

        entities = data.get("entities", {})
        classification = data.get("classification", "")

        frame_kwargs: dict = {}
        confidence_map: dict[str, float] = {}

        for label, field_name in _LABEL_TO_FIELD.items():
            spans = entities.get(label, [])
            candidates = [
                RawExtractionCandidate(
                    field_name=label,
                    text=s["text"],
                    confidence=s.get("confidence", 0.0),
                    source_start=s.get("start", -1),
                    source_end=s.get("end", -1),
                )
                for s in spans
            ]
            frame_kwargs[field_name] = candidates
            if candidates:
                confidence_map[field_name] = sum(c.confidence for c in candidates) / len(candidates)

        # Promote high-confidence requirements as main_question_candidates
        reqs = frame_kwargs.get("requirements", [])
        if reqs:
            best = sorted(reqs, key=lambda c: c.confidence, reverse=True)
            frame_kwargs["main_question_candidates"] = best[:3]

        return FirstPassFrame(
            **frame_kwargs,
            task_classification=classification,
            field_confidence_map=confidence_map,
        )


_client: GlinerClient | None = None


def get_gliner_client() -> GlinerClient:
    """Return the singleton GlinerClient, lazily initialised from config."""
    global _client
    if _client is None:
        from .config import settings

        _client = GlinerClient(url=settings.gliner_service_url)
        logger.info("gliner_client_init url=%s", settings.gliner_service_url)
    return _client
