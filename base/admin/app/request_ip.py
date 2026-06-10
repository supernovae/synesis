"""Client IP resolution with explicit trusted-proxy handling."""

from __future__ import annotations

import ipaddress
import os
from functools import lru_cache

from fastapi import Request


@lru_cache(maxsize=1)
def _trusted_proxy_networks() -> tuple[ipaddress._BaseNetwork, ...]:
    raw = os.getenv("SYNESIS_TRUSTED_PROXY_CIDRS", "").strip()
    networks: list[ipaddress._BaseNetwork] = []
    for item in (part.strip() for part in raw.split(",")):
        if not item:
            continue
        networks.append(ipaddress.ip_network(item, strict=False))
    return tuple(networks)


def _is_trusted_proxy(host: str) -> bool:
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in network for network in _trusted_proxy_networks())


def get_client_ip(request: Request, *, default: str = "unknown", max_length: int = 128) -> str:
    """Return the real client IP only when forwarded by a configured trusted proxy."""

    direct = request.client.host if request.client else ""
    if _is_trusted_proxy(direct):
        forwarded = request.headers.get("x-forwarded-for", "")
        for part in forwarded.split(","):
            candidate = part.strip()
            if not candidate:
                continue
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            return candidate[:max_length]
    return (direct or default)[:max_length]
