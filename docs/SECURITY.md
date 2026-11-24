# CutFlow Security Architecture

CutFlow runs a local HTTP server (`http://127.0.0.1:8010`) with access to local media files, FFmpeg, and user-provided AI API keys. Every boundary follows a **Local-First Hardened** posture:

## 1. Network Binding & Anti-CSRF / DNS-Rebinding Guard
- `cutflow serve` refuses non-loopback bind hosts (`127.0.0.1`, `localhost`, `::1` only).
- `LocalSecurityMiddleware` (`apps/api/src/cutflow/security/middleware.py`) inspects every incoming HTTP request:
  - Rejects requests whose `Host` header is not a valid local host (`127.0.0.1`, `localhost`, `[::1]`, or `testserver` during Pytest), preventing DNS rebinding attacks.
  - Rejects state-mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) whose `Origin` or `Referer` header points to a non-local origin, blocking drive-by cross-tab CSRF from malicious websites.

## 2. Write-Only OS Keyring Secrets
- Secrets (`gemini`, `groq`, `openai`, `anthropic`, `huggingface_token`) are written via the `keyring` package into Windows Credential Manager / macOS Keychain / Linux Secret Service (`apps/api/src/cutflow/security/secrets.py`).
- API endpoints (`GET /api/v1/settings`) only return boolean presence flags (`keys_present`), never raw secret values. Secrets are never persisted into SQLite, `config.json`, or JSONL telemetry logs.

## 3. URL SSRF Protection
- Before invoking `yt-dlp` for URL ingest or Smart Feed polling, `validate_public_url()` (`apps/api/src/cutflow/security/ssrf.py`):
  - Enforces `http` or `https` scheme only (rejecting `file://`, `ftp://`, etc.).
  - Rejects `localhost`, `*.local`, `metadata.google.internal`, and raw IP literals in loopback, RFC1918 private, link-local (`169.254.0.0/16`), multicast, reserved, or unspecified ranges.
  - Resolves DNS hostnames pre-flight and blocks any host resolving to a non-public IP address.

## 4. Path Traversal Sandboxing & Subprocess Safety
- Every file read, upload, clip slice, waveform peak, export download, and raw VOD archive operation resolves paths via `safe_resolve(candidate, allowed_root)` (`apps/api/src/cutflow/security/sandbox.py`), enforcing `target.is_relative_to(root)`.
- All FFmpeg, FFprobe, and `yt-dlp` subprocess calls use explicit Python `list[str]` argv arrays with `shell=False` and `--` option terminators before untrusted URLs.
- User-edited Seam Title Cards, Hook Banners, and CTA Pills are rasterized cleanly with **Pillow** into RGBA PNGs instead of interpolating user text into FFmpeg `drawtext` filter expressions.
