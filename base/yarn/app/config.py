"""Yarn runtime configuration — Pydantic Settings with SYNESIS_YARN_ prefix."""

from __future__ import annotations

import json
from enum import Enum

from pydantic import Field
from pydantic_settings import BaseSettings


class Provider(str, Enum):
    DEEPINFRA = "deepinfra"
    LOCAL = "local"
    LITELLM = "litellm"


class ToolSearchMode(str, Enum):
    PASSTHROUGH = "passthrough"
    DISABLE = "disable"


class Settings(BaseSettings):
    model_config = {"env_prefix": "SYNESIS_YARN_"}

    # --- Provider selection ---
    provider: Provider = Provider.DEEPINFRA

    # --- DeepInfra ---
    deepinfra_api_key: str = Field(default="", alias="DEEPINFRA_API_KEY")
    deepinfra_base_url: str = "https://api.deepinfra.com/v1/openai"

    # --- Model tiers (env-var fallback; admin API is authoritative when reachable) ---
    pulse_model: str = "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"
    pulse_url: str = ""
    pulse_api_key: str = ""
    core_model: str = "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo"
    core_url: str = ""
    core_api_key: str = ""
    horizon_model: str = "deepseek-ai/DeepSeek-R1-0528"
    horizon_url: str = ""
    horizon_api_key: str = ""
    default_tier: str = "synesis-core"
    claude_tier_map: str = ""
    tier_poll_interval: int = 60

    litellm_url: str = "http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/v1"
    litellm_api_key: str = Field(default="", alias="LITELLM_MASTER_KEY")

    max_tokens: int = 65536
    temperature: float = 0.2
    request_timeout: float = 300.0
    model_retries: int = 2

    # --- Memory ---
    memory_window_tokens: int = 131072  # 128K default (Qwen3-Coder native: 262K)
    memory_pinned_budget_tokens: int = 8192
    memory_redis_url: str = "redis://localhost:6379/4"

    # --- Session ---
    session_redis_url: str = "redis://localhost:6379/3"
    session_ttl_seconds: int = 14400  # 4 hours

    # --- Auth ---
    keycloak_issuer_url: str = ""
    keycloak_audience: str = ""
    keycloak_expected_azp: str = "synesis-admin"
    jwt_secret: str = "synesis-dev-secret"
    admin_db_url: str = ""
    auth_allow_legacy_fallback: bool = False
    pat_pepper: str = Field(default="", alias="SYNESIS_PAT_PEPPER")

    # --- Rate limits ---
    rate_limit_tokens_per_minute: int = 500_000
    rate_limit_requests_per_minute: int = 60

    # --- Upstream services ---
    admin_api_url: str = "http://synesis-admin.synesis-admin.svc.cluster.local:8080"
    planner_url: str = "http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080"
    planner_internal_token: str = Field(default="", alias="SYNESIS_INTERNAL_SERVICE_TOKEN")
    mcp_url: str = "http://synesis-mcp.synesis-planner.svc.cluster.local:8100"
    enforce_mcp_authz: bool = True

    # --- Escalation ---
    escalation_context_threshold: float = 0.9
    escalation_max_tool_loops: int = 25

    # --- HTTP / CORS (browser clients only; server-side callers ignore CORS) ---
    # Comma-separated origins. Use "*" for legacy permissive mode (not recommended in production).
    cors_allow_origins: str = (
        "http://127.0.0.1:3000,http://localhost:3000,"
        "http://127.0.0.1:5173,http://localhost:5173,"
        "http://127.0.0.1:8000,http://localhost:8000"
    )

    # --- Telemetry ---
    log_level: str = "info"
    otel_endpoint: str = ""
    persist_usage_to_db: bool = True
    metrics_enabled: bool = True
    diagnostics_enabled: bool = True
    diagnostics_base_sample_rate: float = 0.02
    diagnostics_on_failure: bool = True
    diagnostics_tool_loop_threshold: int = 8
    diagnostics_max_tool_events: int = 20
    diagnostics_snapshot_ttl_seconds: int = 86400

    # --- Claude Code compatibility ---
    claude_compat_enabled: bool = False
    claude_custom_model_ids: str = ""
    claude_tool_search_mode: ToolSearchMode = ToolSearchMode.DISABLE

    @property
    def cors_origins_list(self) -> list[str]:
        raw = self.cors_allow_origins.strip()
        if raw == "*":
            return ["*"]
        parts = [x.strip() for x in raw.split(",") if x.strip()]
        if parts:
            return parts
        return [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8000",
            "http://localhost:8000",
        ]

    @property
    def effective_base_url(self) -> str:
        if self.provider == Provider.DEEPINFRA:
            return self.deepinfra_base_url
        return self.litellm_url

    @property
    def claude_custom_model_ids_set(self) -> set[str]:
        raw = self.claude_custom_model_ids.strip()
        if not raw:
            return set()
        return {x.strip() for x in raw.split(",") if x.strip()}

    @property
    def claude_tier_map_parsed(self) -> dict[str, str]:
        raw = self.claude_tier_map.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return {str(k): str(v) for k, v in parsed.items()}
        except (json.JSONDecodeError, TypeError):
            pass
        return {}

    @property
    def effective_api_key(self) -> str:
        if self.provider == Provider.DEEPINFRA:
            return self.deepinfra_api_key
        if self.provider == Provider.LITELLM:
            return self.litellm_api_key
        return "not-needed"


settings = Settings()
