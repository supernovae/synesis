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


def _mock_http(monkeypatch, handler):
    import app.safe_http as module
    import httpx

    original = httpx.Client
    monkeypatch.setattr(
        module.httpx, "Client", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)
    )
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _address("93.184.216.34"))


def test_revalidates_redirect_destination(monkeypatch):
    import httpx

    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://internal.example/"})

    _mock_http(monkeypatch, handler)
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, *_args, **_kwargs: _address("10.0.0.1" if host == "internal.example" else "93.184.216.34"),
    )
    with pytest.raises(ValueError, match="blocked network"):
        get_public_https("https://example.com/")
    assert calls == ["https://example.com/"]


def test_reads_bounded_body_and_preserves_final_url(monkeypatch):
    import httpx

    def handler(request):
        assert request.headers["accept-encoding"] == "identity"
        if request.url.path == "/":
            return httpx.Response(302, headers={"location": "/docs"})
        return httpx.Response(200, headers={"content-type": "text/html"}, stream=httpx.ByteStream(b"original evidence"))

    _mock_http(monkeypatch, handler)
    checked = []
    response = get_public_https("https://example.com/", check_url=checked.append, max_bytes=100)
    assert response.text == "original evidence"
    assert str(response.url) == "https://example.com/docs"
    assert checked == ["https://example.com/", "https://example.com/docs"]


@pytest.mark.parametrize("headers", [{}, {"content-length": "1000000"}])
def test_rejects_oversized_bodies_with_or_without_length(monkeypatch, headers):
    import httpx

    _mock_http(monkeypatch, lambda _: httpx.Response(200, headers=headers, stream=httpx.ByteStream(b"x" * 100)))
    with pytest.raises(ValueError, match="byte limit"):
        get_public_https("https://example.com/", max_bytes=10)


def test_rejects_compression_instead_of_unbounded_decoding(monkeypatch):
    import gzip

    import httpx

    _mock_http(
        monkeypatch,
        lambda _: httpx.Response(
            200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(gzip.compress(b"x" * 1000))
        ),
    )
    with pytest.raises(ValueError, match="Accept-Encoding"):
        get_public_https("https://example.com/")


def test_redirect_policy_is_checked_before_request(monkeypatch):
    import httpx

    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "/denied"})

    def allowed(url):
        if url.endswith("/denied"):
            raise ValueError("robots denied")

    _mock_http(monkeypatch, handler)
    with pytest.raises(ValueError, match="robots denied"):
        get_public_https("https://example.com/", check_url=allowed)
    assert calls == ["https://example.com/"]


def test_deadline_is_checked_between_small_stream_reads(monkeypatch):
    import app.safe_http as module
    import httpx

    elapsed = [0.0]
    reads = []

    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(100):
                elapsed[0] += 0.75
                reads.append(index)
                yield b"x"

    monkeypatch.setattr(module.time, "monotonic", lambda: elapsed[0])
    _mock_http(monkeypatch, lambda _: httpx.Response(200, stream=SlowStream()))
    with pytest.raises(TimeoutError, match="time budget"):
        get_public_https("https://example.com/", timeout=1)
    assert reads == [0, 1]
