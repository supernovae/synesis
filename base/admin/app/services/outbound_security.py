"""Shared outbound URL validation for admin-managed fetches."""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException


def _allowlist() -> list[str]:
    raw = os.getenv("SYNESIS_ADMIN_OUTBOUND_HOST_ALLOWLIST", "").strip()
    return [h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip()]


def _host_allowed(host: str) -> bool:
    allowed = _allowlist()
    if not allowed:
        return True
    h = host.lower().rstrip(".")
    return any(h == item or h.endswith(f".{item}") for item in allowed)


def _is_blocked_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def validate_public_https_url(value: str, *, field_name: str = "url") -> str:
    """Return a normalized public HTTPS URL or raise HTTPException.

    Blocks common SSRF targets: localhost, private/link-local/reserved IPs,
    userinfo URLs, non-HTTPS schemes, and hosts outside an optional allowlist.
    """
    url = value.strip()
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or not parsed.hostname:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a public https URL")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail=f"{field_name} must not include credentials")

    host = parsed.hostname.rstrip(".")
    if not _host_allowed(host):
        raise HTTPException(status_code=400, detail=f"{field_name} host is not allowlisted")

    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} host could not be resolved") from exc
    for addr in addresses:
        ip = addr[4][0]
        if _is_blocked_ip(ip):
            raise HTTPException(status_code=400, detail=f"{field_name} resolves to a blocked network")

    clean = parsed._replace(fragment="")
    return urlunparse(clean).rstrip("/")
