from app.services.health_prober import filter_removed_litellm_proxy_services


def test_filter_removed_litellm_proxy_services_removes_legacy_gateway_entries() -> None:
    services = [
        {"name": "synesis-planner-ts", "category": "infrastructure"},
        {"name": "litellm-proxy", "category": "infrastructure"},
        {"name": "old-row", "category": "model-gateway"},
        {"name": "synesis-critic", "category": "model"},
    ]

    filtered = filter_removed_litellm_proxy_services(services)

    assert filtered == [
        {"name": "synesis-planner-ts", "category": "infrastructure"},
        {"name": "synesis-critic", "category": "model"},
    ]
