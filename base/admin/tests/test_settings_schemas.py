from __future__ import annotations

import pytest
from app.routers.settings import InfraCostConfigBody
from pydantic import ValidationError


def test_infra_cost_config_accepts_known_payload() -> None:
    body = InfraCostConfigBody(
        cloud="aws",
        instance_type="p5.48xlarge",
        gpu_model="H100",
        gpu_count=8,
        hourly_rate=98.32,
        tokens_per_hour=600_000_000,
        notes="production serving pool",
    )

    assert body.model_dump() == {
        "cloud": "aws",
        "instance_type": "p5.48xlarge",
        "gpu_model": "H100",
        "gpu_count": 8,
        "hourly_rate": 98.32,
        "tokens_per_hour": 600_000_000,
        "notes": "production serving pool",
    }


def test_infra_cost_config_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="admin_override"):
        InfraCostConfigBody(
            cloud="aws",
            hourly_rate=98.32,
            tokens_per_hour=600_000_000,
            admin_override=True,
        )


def test_infra_cost_config_rejects_negative_hourly_rate() -> None:
    with pytest.raises(ValidationError, match="hourly_rate"):
        InfraCostConfigBody(hourly_rate=-1.0)
