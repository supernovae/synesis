"""Public-HTTPS fetches for operator-controlled ingestion URLs."""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Mapping
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

_REDIRECTS = {301, 302, 303, 307, 308}


def validate_public_https_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("ingestion URL must be public HTTPS without embedded credentials")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("ingestion URL has an invalid port") from exc
    if port not in (None, 443):
        raise ValueError("ingestion URL must use HTTPS port 443")

    host = parsed.hostname.rstrip(".")
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("ingestion URL host could not be resolved") from exc
    if not addresses:
        raise ValueError("ingestion URL host could not be resolved")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError("ingestion URL resolves to a blocked network")

    return urlunparse(parsed._replace(fragment=""))


def get_public_https(
    url: str,
    *,
    timeout: float = 30,
    headers: Mapping[str, str] | None = None,
    max_redirects: int = 5,
) -> httpx.Response:
    current = url
    with httpx.Client(timeout=timeout, headers=headers, follow_redirects=False, trust_env=False) as client:
        for _ in range(max_redirects + 1):
            current = validate_public_https_url(current)
            response = client.get(current)
            if response.status_code not in _REDIRECTS:
                response.raise_for_status()
                return response
            location = response.headers.get("location")
            if not location:
                response.raise_for_status()
            current = urljoin(current, location)
    raise ValueError(f"ingestion URL exceeded {max_redirects} redirects")
