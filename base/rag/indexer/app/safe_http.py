"""Public-HTTPS fetches for operator-controlled ingestion URLs."""

from __future__ import annotations

import ipaddress
import socket
import time
from collections.abc import Callable, Mapping
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
    max_bytes: int = 32 * 1024 * 1024,
    check_url: Callable[[str], None] | None = None,
) -> httpx.Response:
    """Read a bounded response, validating every destination before requesting it.

    URLs are operator controlled. DNS validation is not an egress firewall or
    protection against a DNS change between validation and connection.
    """
    if max_bytes <= 0 or timeout <= 0 or max_redirects < 0:
        raise ValueError("HTTP limits must be positive")
    current = url
    deadline = time.monotonic() + timeout
    request_headers = httpx.Headers(headers)
    request_headers["Accept-Encoding"] = "identity"
    with httpx.Client(timeout=timeout, headers=request_headers, follow_redirects=False, trust_env=False) as client:
        for _ in range(max_redirects + 1):
            current = validate_public_https_url(current)
            if check_url:
                check_url(current)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("HTTP fetch exceeded its time budget")
            with client.stream("GET", current, timeout=remaining) as response:
                if response.status_code in _REDIRECTS:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("HTTP redirect has no location")
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ValueError("Server must honor Accept-Encoding: identity for bounded ingestion")
                if int(response.headers.get("content-length", "0")) > max_bytes:
                    raise ValueError("HTTP response exceeds the byte limit")
                body = bytearray()
                # Check each transport read, without buffering up a full chunk
                # while a slow server keeps the per-read timeout alive.
                for chunk in response.iter_raw():
                    if time.monotonic() > deadline:
                        raise TimeoutError("HTTP fetch exceeded its time budget")
                    if len(body) + len(chunk) > max_bytes:
                        raise ValueError("HTTP response exceeds the byte limit")
                    body.extend(chunk)
                return httpx.Response(
                    response.status_code, headers=response.headers, content=bytes(body), request=response.request
                )
    raise ValueError(f"ingestion URL exceeded {max_redirects} redirects")
