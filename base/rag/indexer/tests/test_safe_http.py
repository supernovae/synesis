from __future__ import annotations

import socket
from unittest.mock import patch

import pytest
from app.safe_http import get_public_https, validate_public_https_url


def _address(ip: str):
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]


@pytest.mark.parametrize(
    "url",
    ["http://example.com", "file:///etc/passwd", "https://u:p@example.com", "https://example.com:8443"],
)
def test_rejects_non_https_and_credentials(url):
    with pytest.raises(ValueError):
        validate_public_https_url(url)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"])
def test_rejects_non_public_dns_results(ip):
    with patch("socket.getaddrinfo", return_value=_address(ip)):
        with pytest.raises(ValueError, match="blocked network"):
            validate_public_https_url("https://example.com/docs")


def test_accepts_public_https_and_removes_fragment():
    with patch("socket.getaddrinfo", return_value=_address("93.184.216.34")):
        assert validate_public_https_url("https://example.com/docs#part") == "https://example.com/docs"


def test_revalidates_redirect_destination():
    response = type(
        "Response",
        (),
        {
            "status_code": 302,
            "headers": {"location": "https://internal.example/"},
            "raise_for_status": lambda self: None,
        },
    )()
    client = type(
        "Client",
        (),
        {"__enter__": lambda self: self, "__exit__": lambda self, *_: None, "get": lambda self, _url: response},
    )()

    def resolve(host, *_args, **_kwargs):
        return _address("10.0.0.1" if host == "internal.example" else "93.184.216.34")

    with (
        patch("socket.getaddrinfo", side_effect=resolve),
        patch("app.safe_http.httpx.Client", return_value=client),
        pytest.raises(ValueError, match="blocked network"),
    ):
        get_public_https("https://example.com/")
