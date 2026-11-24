"""Security hardening tests: CSRF/Origin, Host DNS-rebinding, SSRF, path sandbox, keyring."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cutflow.security import (
    PathSandboxError,
    SSRFError,
    safe_resolve,
    safe_slug,
    validate_public_url,
)


class TestHostAndCsrfMiddleware:
    def test_allows_local_host_and_same_origin(self, client: TestClient) -> None:
        resp = client.get("/api/v1/health", headers={"Host": "127.0.0.1:8010"})
        assert resp.status_code == 200
        assert resp.headers["X-Content-Type-Options"] == "nosniff"
        assert resp.headers["X-Frame-Options"] == "DENY"

        created = client.post(
            "/api/v1/profiles",
            headers={"Host": "localhost:8010", "Origin": "http://localhost:5173"},
            json={"name": "Safe Creator"},
        )
        assert created.status_code == 201

    def test_blocks_dns_rebinding_non_local_host(self, client: TestClient) -> None:
        resp = client.get("/api/v1/health", headers={"Host": "evil.attacker.com:8010"})
        assert resp.status_code == 403
        assert "Host" in resp.json()["detail"]

    def test_blocks_cross_origin_mutation_csrf(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/profiles",
            headers={"Host": "127.0.0.1:8010", "Origin": "https://evil-site.example"},
            json={"name": "Injected"},
        )
        assert resp.status_code == 403
        assert "CSRF" in resp.json()["detail"]

    def test_blocks_cross_site_referer_when_origin_absent(self, client: TestClient) -> None:
        resp = client.delete(
            "/api/v1/profiles/general-gaming-streamer",
            headers={"Host": "127.0.0.1:8010", "Referer": "https://phish.example/page"},
        )
        assert resp.status_code == 403


class TestSsrfGuard:
    @pytest.mark.parametrize(
        "bad_url",
        [
            "",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "ftp://example.com/video.mp4",
            "http://127.0.0.1:8010/api/v1/settings",
            "http://localhost/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://192.168.1.1/stream",
            "http://10.0.0.5/vod.mp4",
            "http://[::1]:8000/",
        ],
    )
    def test_rejects_local_private_and_non_http_urls(self, bad_url: str) -> None:
        with pytest.raises(SSRFError):
            validate_public_url(bad_url, resolve_dns=False)

    def test_rejects_hostname_resolving_to_private_ip(self) -> None:
        with pytest.raises(SSRFError, match="non-public IP"):
            validate_public_url(
                "https://rebind.example.com/watch",
                resolve_dns=True,
                resolver=lambda _host: ["127.0.0.1"],
            )

    def test_accepts_public_url_with_public_ip(self) -> None:
        result = validate_public_url(
            "https://www.twitch.tv/videos/123456",
            resolve_dns=True,
            resolver=lambda _host: ["151.101.2.167"],
        )
        assert result == "https://www.twitch.tv/videos/123456"


class TestPathSandbox:
    def test_blocks_parent_directory_escape(self, tmp_path: Path) -> None:
        sandbox = tmp_path / "inbox"
        sandbox.mkdir()
        inside = safe_resolve("creator/clip.mp4", sandbox)
        assert inside.is_relative_to(sandbox.resolve())

        with pytest.raises(PathSandboxError):
            safe_resolve("../../Windows/win.ini", sandbox)

    def test_safe_slug_strips_traversal_and_special_chars(self) -> None:
        assert safe_slug("../../$8,000 Expedia x IShowSpeed!") == "8000-expedia-x-ishowspeed"
