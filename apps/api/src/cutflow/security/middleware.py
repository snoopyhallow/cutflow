"""ASGI security middleware protecting local CutFlow endpoints.

Blocks DNS-rebinding attacks (via strict Host validation) and malicious browser
tab CSRF attacks (via strict Origin/Referer validation on mutating methods).
"""

from __future__ import annotations

from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver"}
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _extract_hostname(host_header: str) -> str:
    raw = host_header.strip().lower()
    if not raw:
        return ""
    if raw.startswith("["):
        end = raw.find("]")
        return raw[1:end] if end != -1 else raw
    return raw.split(":", 1)[0]


def _origin_is_local(origin_or_referer: str) -> bool:
    try:
        parsed = urlparse(origin_or_referer.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host in _ALLOWED_HOSTS


class LocalSecurityMiddleware(BaseHTTPMiddleware):
    """Reject non-local Host headers and cross-origin state-mutating requests."""

    async def dispatch(self, request: Request, call_next) -> Response:
        host = _extract_hostname(request.headers.get("host", ""))
        if host and host not in _ALLOWED_HOSTS:
            return JSONResponse(
                status_code=403,
                content={"detail": "Blocked non-local Host header (DNS rebinding protection)."},
            )

        if request.method.upper() in _MUTATING_METHODS:
            origin = request.headers.get("origin")
            referer = request.headers.get("referer")
            if origin and not _origin_is_local(origin):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Blocked cross-origin mutation request (CSRF protection)."},
                )
            if not origin and referer and not _origin_is_local(referer):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Blocked cross-site referer on mutation request."},
                )

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        return response
