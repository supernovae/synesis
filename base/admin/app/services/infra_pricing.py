"""Infrastructure pricing — derive per-token costs from cloud instance rates.

For local vLLM/KServe deployments the cost is driven by compute, not API
pricing.  Users configure their instance type + hourly rate and the system
derives an estimated $/M tokens figure.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from typing import Any

from sqlalchemy import text

from ..db.engine import async_session

logger = logging.getLogger("synesis.admin.infra_pricing")


@dataclass(frozen=True, slots=True)
class InstanceType:
    cloud: str
    instance_type: str
    label: str
    gpu_model: str
    gpu_count: int
    on_demand_hourly: float
    estimated_tokens_per_hour: int


# Well-known GPU instance types with representative on-demand pricing.
# Users can override the hourly rate and tokens/hr in the UI.
INSTANCE_CATALOG: list[InstanceType] = [
    # AWS
    InstanceType("aws", "g5.xlarge", "AWS g5.xlarge (1x A10G)", "A10G", 1, 1.006, 8_000_000),
    InstanceType("aws", "g5.12xlarge", "AWS g5.12xlarge (4x A10G)", "A10G", 4, 5.672, 30_000_000),
    InstanceType("aws", "p4d.24xlarge", "AWS p4d.24xlarge (8x A100 40GB)", "A100-40GB", 8, 32.77, 200_000_000),
    InstanceType("aws", "p5.48xlarge", "AWS p5.48xlarge (8x H100)", "H100", 8, 98.32, 600_000_000),
    InstanceType("aws", "g6.xlarge", "AWS g6.xlarge (1x L4)", "L4", 1, 0.805, 6_000_000),
    InstanceType("aws", "g6.12xlarge", "AWS g6.12xlarge (4x L4)", "L4", 4, 4.602, 22_000_000),
    # GCP
    InstanceType("gcp", "a2-highgpu-4g", "GCP a2-highgpu-4g (4x A100 40GB)", "A100-40GB", 4, 14.69, 100_000_000),
    InstanceType("gcp", "a3-highgpu-8g", "GCP a3-highgpu-8g (8x H100)", "H100", 8, 101.22, 600_000_000),
    InstanceType("gcp", "g2-standard-48", "GCP g2-standard-48 (4x L4)", "L4", 4, 4.34, 22_000_000),
    # Azure
    InstanceType(
        "azure", "Standard_NC24ads_A100_v4", "Azure NC24ads A100 (1x A100 80GB)", "A100-80GB", 1, 3.67, 40_000_000
    ),
    InstanceType(
        "azure", "Standard_NC96ads_A100_v4", "Azure NC96ads A100 (4x A100 80GB)", "A100-80GB", 4, 14.69, 160_000_000
    ),
    InstanceType(
        "azure", "Standard_ND96amsr_A100_v4", "Azure ND96amsr (8x A100 80GB)", "A100-80GB", 8, 27.20, 280_000_000
    ),
    # Generic / bare metal
    InstanceType("other", "custom", "Custom / Bare Metal", "custom", 0, 0.0, 10_000_000),
]

INSTANCE_LOOKUP: dict[str, InstanceType] = {i.instance_type: i for i in INSTANCE_CATALOG}


def calculate_token_cost(hourly_rate: float, tokens_per_hour: int) -> tuple[float, float]:
    """Derive $/M tokens from hourly instance cost and throughput estimate.

    Returns (input_per_million, output_per_million) — same rate for both
    since local inference cost is symmetric.
    """
    if tokens_per_hour <= 0 or hourly_rate <= 0:
        return (0.0, 0.0)
    cost_per_token = hourly_rate / tokens_per_hour
    cost_per_million = round(cost_per_token * 1_000_000, 4)
    return (cost_per_million, cost_per_million)


def get_instance_catalog() -> list[dict]:
    """Return the instance catalog for the frontend."""
    return [asdict(i) for i in INSTANCE_CATALOG]


# ---------------------------------------------------------------------------
# Persistent infra cost config (stored as JSONB rows in a lightweight table).
# Uses the existing settings router pattern — one row per role.
# ---------------------------------------------------------------------------

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS infra_cost_config (
    role VARCHAR(64) PRIMARY KEY,
    cloud VARCHAR(32) NOT NULL DEFAULT '',
    instance_type VARCHAR(128) NOT NULL DEFAULT '',
    gpu_model VARCHAR(64) NOT NULL DEFAULT '',
    gpu_count INTEGER NOT NULL DEFAULT 0,
    hourly_rate FLOAT NOT NULL DEFAULT 0,
    tokens_per_hour BIGINT NOT NULL DEFAULT 0,
    input_per_million FLOAT NOT NULL DEFAULT 0,
    output_per_million FLOAT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
"""

_UPSERT_SQL = """
INSERT INTO infra_cost_config
    (role, cloud, instance_type, gpu_model, gpu_count, hourly_rate,
     tokens_per_hour, input_per_million, output_per_million, notes, updated_at)
VALUES
    (:role, :cloud, :instance_type, :gpu_model, :gpu_count, :hourly_rate,
     :tokens_per_hour, :input_per_million, :output_per_million, :notes, NOW())
ON CONFLICT (role) DO UPDATE SET
    cloud = EXCLUDED.cloud,
    instance_type = EXCLUDED.instance_type,
    gpu_model = EXCLUDED.gpu_model,
    gpu_count = EXCLUDED.gpu_count,
    hourly_rate = EXCLUDED.hourly_rate,
    tokens_per_hour = EXCLUDED.tokens_per_hour,
    input_per_million = EXCLUDED.input_per_million,
    output_per_million = EXCLUDED.output_per_million,
    notes = EXCLUDED.notes,
    updated_at = NOW()
"""


async def ensure_table() -> None:
    """Create the infra_cost_config table if it doesn't exist."""
    async with async_session() as session:
        await session.execute(text(_CREATE_TABLE_SQL))
        await session.commit()


async def get_infra_configs() -> list[dict[str, Any]]:
    """Return all infra cost configs."""
    try:
        async with async_session() as session:
            result = await session.execute(text("SELECT * FROM infra_cost_config ORDER BY role"))
            rows = result.mappings().all()
            return [dict(r) for r in rows]
    except Exception:
        logger.debug("infra_config_read_failed", exc_info=True)
        return []


async def get_infra_config_for_role(role: str) -> dict[str, Any] | None:
    """Return infra cost config for a single role, or None."""
    try:
        async with async_session() as session:
            result = await session.execute(
                text("SELECT * FROM infra_cost_config WHERE role = :role"),
                {"role": role},
            )
            row = result.mappings().first()
            return dict(row) if row else None
    except Exception:
        logger.debug("infra_config_read_role_failed role=%s", role, exc_info=True)
        return None


async def upsert_infra_config(data: dict[str, Any]) -> dict[str, Any]:
    """Create or update infra cost config for a role."""
    role = data["role"]
    hourly = float(data.get("hourly_rate", 0))
    tph = int(data.get("tokens_per_hour", 0))
    inp, outp = calculate_token_cost(hourly, tph)

    params = {
        "role": role,
        "cloud": data.get("cloud", ""),
        "instance_type": data.get("instance_type", ""),
        "gpu_model": data.get("gpu_model", ""),
        "gpu_count": int(data.get("gpu_count", 0)),
        "hourly_rate": hourly,
        "tokens_per_hour": tph,
        "input_per_million": inp,
        "output_per_million": outp,
        "notes": data.get("notes", ""),
    }

    async with async_session() as session:
        await session.execute(text(_UPSERT_SQL), params)
        await session.commit()

    return {**params, "updated_at": None}


async def delete_infra_config(role: str) -> bool:
    """Delete infra cost config for a role."""
    async with async_session() as session:
        result = await session.execute(
            text("DELETE FROM infra_cost_config WHERE role = :role"),
            {"role": role},
        )
        await session.commit()
        return result.rowcount > 0  # type: ignore[union-attr]
