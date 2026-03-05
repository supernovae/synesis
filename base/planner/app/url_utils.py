"""URL helpers to prevent protocol regression.

All HTTP/HTTPS URLs used with httpx must include protocol. This module
provides a single normalization function used by config, health_monitor,
and any code constructing URLs.
"""


def ensure_url_protocol(url: str) -> str:
    """Prevent 'Request URL is missing http/https protocol'.

    Prepends http:// if URL has no protocol. Empty strings pass through.
    Use for any URL passed to httpx, aiohttp, or similar clients.
    """
    if not url or not str(url).strip():
        return url
    s = str(url).strip()
    if s.startswith(("http://", "https://")):
        return s
    return f"http://{s}"
