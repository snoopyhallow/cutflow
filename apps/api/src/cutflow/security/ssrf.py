"""URL validation & SSRF protection before passing URLs to yt-dlp or HTTP clients."""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from urllib.parse import urlparse


class SSRFError(ValueError):
    """Raised when a URL fails scheme, host, or public-IP validation."""


_BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "metadata.google.internal"}


def _is_blocked_ip_obj(
    addr: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> bool:
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def _is_blocked_ip(ip_str: str) -> bool:
    return _is_blocked_ip_obj(ipaddress.ip_address(ip_str))


def _default_resolver(hostname: str) -> list[str]:
    infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    return sorted({info[4][0] for info in infos})


def validate_public_url(
    url: str,
    *,
    resolve_dns: bool = True,
    resolver: Callable[[str], list[str]] | None = None,
) -> str:
    """Validate an untrusted external URL and reject private/loopback/metadata targets."""
    cleaned = url.strip()
    if not cleaned:
        raise SSRFError("URL cannot be empty.")

    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https"):
        raise SSRFError(f"Unsupported URL scheme {parsed.scheme!r}; only http/https allowed.")

    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname or hostname in _BLOCKED_HOSTNAMES or hostname.endswith(".local"):
        raise SSRFError(f"Blocked local or internal host {hostname!r}.")

    # Reject raw IP literals pointing to private/loopback/link-local ranges immediately.
    ip_literal: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        ip_literal = ipaddress.ip_address(hostname)
    except ValueError:
        ip_literal = None

    if ip_literal is not None:
        if _is_blocked_ip_obj(ip_literal):
            raise SSRFError(f"Blocked non-public IP address {hostname!r}.")
        return cleaned

    if "." not in hostname:
        raise SSRFError(f"Invalid external hostname {hostname!r}.")

    if resolve_dns:
        lookup = resolver or _default_resolver
        try:
            ips = lookup(hostname)
        except OSError as exc:
            raise SSRFError(f"Could not resolve hostname {hostname!r}: {exc}") from exc
        if not ips:
            raise SSRFError(f"Hostname {hostname!r} resolved to no IP addresses.")
        for ip in ips:
            if _is_blocked_ip(ip):
                raise SSRFError(f"Blocked hostname {hostname!r} resolving to non-public IP {ip}.")

    return cleaned
