"""Provider-agnostic LLM client (Gemini/OpenAI/Anthropic/Ollama) with content-hash caching."""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Literal

import httpx

from .. import config, paths
from ..security import get_secret

log = logging.getLogger(__name__)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_GEMINI_FALLBACK_MODELS = ("gemini-2.5-flash", "gemini-2.0-flash")


class LLMError(RuntimeError):
    """Raised when no LLM provider could produce a valid response."""


def _cache_file(cache_key: str) -> Path:
    folder = paths.cache_dir() / "llm"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{cache_key}.json"


def _compute_cache_key(
    provider: str, model: str, system_prompt: str, user_prompt: str, image_hash: str
) -> str:
    h = hashlib.sha256()
    for part in (provider, model, system_prompt, user_prompt, image_hash):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def parse_json_payload(raw_text: str) -> Any:
    """Extract JSON from an LLM completion, stripping optional markdown fences."""
    cleaned = _CODE_FENCE_RE.sub("", raw_text.strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        for opener, closer in (("{", "}"), ("[", "]")):
            start = cleaned.find(opener)
            end = cleaned.rfind(closer)
            if start != -1 and end > start:
                return json.loads(cleaned[start : end + 1])
        raise


def _call_gemini(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_b64: str | None = None,
) -> str:
    parts: list[dict[str, Any]] = [{"text": user_prompt}]
    if image_b64:
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": image_b64}})

    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.25,
            "responseMimeType": "application/json",
        },
    }
    if system_prompt:
        body["systemInstruction"] = {"parts": [{"text": system_prompt}]}

    candidates = [model] + [m for m in _GEMINI_FALLBACK_MODELS if m != model]
    last_exc: Exception | None = None
    with httpx.Client(timeout=90.0) as client:
        for candidate in candidates:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{candidate}:generateContent"
            )
            try:
                resp = client.post(url, params={"key": api_key}, json=body)
                if resp.status_code in (404, 429, 503):
                    last_exc = LLMError(f"Gemini {candidate} returned {resp.status_code}")
                    continue
                resp.raise_for_status()
                data = resp.json()
                cands = data.get("candidates") or []
                if not cands:
                    raise LLMError("Gemini returned empty candidates.")
                return str(cands[0]["content"]["parts"][0]["text"])
            except Exception as exc:
                last_exc = exc
                continue
    raise LLMError(f"Gemini request failed: {last_exc}")


def _call_openai_compat(
    base_url: str,
    api_key: str | None,
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_b64: str | None = None,
) -> str:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    if image_b64:
        user_content: Any = [
            {"type": "text", "text": user_prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    else:
        user_content = user_prompt

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_content})

    payload: dict[str, Any] = {
        "model": model,
        "temperature": 0.25,
        "messages": messages,
    }
    if "openai.com" in base_url:
        payload["response_format"] = {"type": "json_object"}

    with httpx.Client(timeout=90.0) as client:
        endpoint = f"{base_url.rstrip('/')}/chat/completions"
        resp = client.post(endpoint, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return str(data["choices"][0]["message"]["content"])


def _call_anthropic(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_b64: str | None = None,
) -> str:
    content: list[dict[str, Any]] = []
    if image_b64:
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64},
            }
        )
    content.append({"type": "text", "text": user_prompt})
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.25,
        "messages": [{"role": "user", "content": content}],
    }
    if system_prompt:
        body["system"] = system_prompt

    with httpx.Client(timeout=90.0) as client:
        resp = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()
    blocks = data.get("content") or []
    return "".join(str(b.get("text", "")) for b in blocks if b.get("type") == "text")


_DEFAULT_PROVIDER_MODELS: dict[str, str] = {
    "gemini": "gemini-2.5-flash",
    "anthropic": "claude-sonnet-4-5",
    "openai": "gpt-4o-mini",
    "groq": "llama-3.3-70b-versatile",
    "ollama": "qwen2.5:7b",
}
_CLOUD_PROVIDER_ORDER: tuple[str, ...] = ("gemini", "anthropic", "openai", "groq")


def _model_matches_provider(provider: str, model_name: str) -> bool:
    """Prevent stale cross-provider model IDs (e.g. passing 'gemini-2.5-flash' to Anthropic)."""
    m = model_name.strip().lower()
    if not m:
        return False
    if provider == "gemini":
        return m.startswith("gemini")
    if provider == "anthropic":
        return m.startswith("claude")
    if provider == "openai":
        return not m.startswith(("gemini", "claude", "llama-"))
    if provider == "groq":
        return not m.startswith(("gemini", "claude", "gpt-"))
    return True


def _resolve_provider_and_model(
    cfg: config.Settings,
    *,
    role: Literal["scan", "editor"],
    explicit_provider: str | None,
    explicit_model: str | None,
) -> tuple[str, str]:
    active = explicit_provider or cfg.models.active_provider
    # Smart auto-fallback: if the selected cloud provider has no key set yet, automatically
    # use whichever cloud provider key the user pasted into OS Keyring / environment.
    if explicit_provider is None and active in _CLOUD_PROVIDER_ORDER and not get_secret(active):
        for candidate in _CLOUD_PROVIDER_ORDER:
            if get_secret(candidate):
                active = candidate
                break

    provider_cfg = cfg.models.providers.get(active)
    role_model = cfg.models.scan_model if role == "scan" else cfg.models.editor_model
    if explicit_model:
        chosen = explicit_model
    elif _model_matches_provider(active, role_model):
        chosen = role_model
    elif provider_cfg and provider_cfg.model:
        chosen = provider_cfg.model
    else:
        chosen = _DEFAULT_PROVIDER_MODELS.get(active, "")
    return active, chosen


def complete_json(
    user_prompt: str,
    *,
    system_prompt: str = "",
    role: Literal["scan", "editor"] = "scan",
    image_b64: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    use_cache: bool = True,
) -> Any:
    """Invoke the configured LLM provider with content-hash caching and return parsed JSON."""
    cfg = config.load()
    active_provider, chosen_model = _resolve_provider_and_model(
        cfg,
        role=role,
        explicit_provider=provider,
        explicit_model=model,
    )
    provider_cfg = cfg.models.providers.get(active_provider)

    image_hash = hashlib.sha256(image_b64.encode("ascii")).hexdigest()[:16] if image_b64 else ""
    cache_key = _compute_cache_key(
        active_provider, chosen_model, system_prompt, user_prompt, image_hash
    )
    cached = _cache_file(cache_key)
    if use_cache and cached.is_file():
        try:
            return json.loads(cached.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass

    if active_provider == "gemini":
        key = get_secret("gemini")
        if not key:
            raise LLMError("No gemini key configured in OS keyring or environment.")
        raw = _call_gemini(
            key, chosen_model or "gemini-2.5-flash", system_prompt, user_prompt, image_b64
        )
    elif active_provider == "openai":
        key = get_secret("openai")
        if not key:
            raise LLMError("No openai key configured in OS keyring or environment.")
        raw = _call_openai_compat(
            "https://api.openai.com/v1",
            key,
            chosen_model or "gpt-4o-mini",
            system_prompt,
            user_prompt,
            image_b64,
        )
    elif active_provider == "anthropic":
        key = get_secret("anthropic")
        if not key:
            raise LLMError("No anthropic key configured in OS keyring or environment.")
        raw = _call_anthropic(
            key, chosen_model or "claude-sonnet-4-5", system_prompt, user_prompt, image_b64
        )
    elif active_provider == "groq":
        key = get_secret("groq")
        if not key:
            raise LLMError("No groq key configured in OS keyring or environment.")
        raw = _call_openai_compat(
            "https://api.groq.com/openai/v1",
            key,
            chosen_model or "llama-3.3-70b-versatile",
            system_prompt,
            user_prompt,
            None,
        )
    elif active_provider == "ollama":
        base_url = (provider_cfg.base_url if provider_cfg and provider_cfg.base_url else None) or (
            "http://127.0.0.1:11434"
        )
        if not chosen_model:
            raise LLMError("No Ollama model configured.")
        raw = _call_openai_compat(
            f"{base_url.rstrip('/')}/v1",
            None,
            chosen_model,
            system_prompt,
            user_prompt,
            image_b64,
        )
    else:
        raise LLMError(f"Unsupported LLM provider {active_provider!r}.")

    parsed = parse_json_payload(raw)
    if use_cache:
        with contextlib.suppress(OSError):
            cached.write_text(json.dumps(parsed, indent=2), encoding="utf-8")
    return parsed
