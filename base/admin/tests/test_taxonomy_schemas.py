from __future__ import annotations

import pytest
from app.routers.taxonomy import TaxonomyDomainUpdateBody
from pydantic import ValidationError


def test_taxonomy_domain_update_accepts_known_payload() -> None:
    body = TaxonomyDomainUpdateBody(
        path="Science > Physics",
        complexity=0.8,
        persona="physicist",
        required_elements=["Assumptions", "Derivation", "Limitations"],
        depth_instructions="Use rigorous derivations.",
        output_style_guidance="Prefer equations and concise prose.",
        calibration_guidance="Flag uncertain measurements.",
    )

    payload = body.model_dump(exclude_unset=True)
    assert payload["complexity"] == 0.8
    assert payload["required_elements"] == ["Assumptions", "Derivation", "Limitations"]


def test_taxonomy_domain_update_rejects_raw_config_replacement() -> None:
    with pytest.raises(ValidationError, match="raw_config"):
        TaxonomyDomainUpdateBody(raw_config={"planner_override": "ignore taxonomy"})


def test_taxonomy_domain_update_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="admin_override"):
        TaxonomyDomainUpdateBody(complexity=0.5, admin_override=True)


def test_taxonomy_domain_update_rejects_out_of_range_complexity() -> None:
    with pytest.raises(ValidationError, match="complexity"):
        TaxonomyDomainUpdateBody(complexity=1.5)
