from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class AdminApiError(RuntimeError):
    """Raised when Admin API returns a non-2xx response."""


@dataclass(slots=True)
class AdminApiClient:
    base_url: str
    token: str | None = None
    timeout_sec: float = 20.0

    @staticmethod
    def _ensure_http_url(url: str) -> str:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise AdminApiError(f"Unsupported Admin API URL scheme: {parsed.scheme!r}")
        return url

    def _url(self, path: str, query: dict[str, Any] | None = None) -> str:
        base = self._ensure_http_url(self.base_url.rstrip("/"))
        p = path if path.startswith("/") else f"/{path}"
        if not query:
            return f"{base}{p}"
        qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        return f"{base}{p}?{qs}"

    def get_json(self, path: str, query: dict[str, Any] | None = None) -> Any:
        url = self._url(path, query)
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, headers=headers, method="GET")  # noqa: S310 - URL scheme validated above.
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:  # noqa: S310 - URL scheme validated above.
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise AdminApiError(f"Admin API {exc.code} for {url}: {detail[:800]}") from exc
        except urllib.error.URLError as exc:
            raise AdminApiError(f"Admin API request failed for {url}: {exc.reason}") from exc
