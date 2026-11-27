"""Provider-agnostic LLM client (Gemini/OpenAI/Anthropic/Groq/Ollama) + live model discovery."""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx

from .. import config, paths
from ..security import get_secret, keys_presence

log = logging.getLogger(__name__)

_LAST_GEMINI_META: contextvars.ContextVar[tuple[str, str | None] | None] = contextvars.ContextVar(
    "_LAST_GEMINI_META", default=None
)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_GEMINI_FALLBACK_MODELS: tuple[str, ...] = (
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
)

_CURATED_PROVIDER_MODELS: dict[str, list[str]] = {
    "gemini": [
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash",
        "gemini-flash-latest",
    ],
    "openai": ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
    "anthropic": ["claude-sonnet-4-5", "claude-haiku-4-5"],
    "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    "ollama": ["qwen2.5:7b", "llama3.2:3b", "gemma3:4b"],
}


class LLMError(RuntimeError):
    """Raised when no LLM provider could produce a valid response."""


@dataclass(slots=True)
class LLMCallMeta:
    payload: Any
    provider: str
    model_used: str
    warning: str | None = None


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
    _LAST_GEMINI_META.set(None)
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
    primary_failure: str | None = None
    last_exc: Exception | None = None

    with httpx.Client(timeout=45.0) as client:
        for idx, candidate in enumerate(candidates):
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{candidate}:generateContent"
            )
            try:
                resp = client.post(url, params={"key": api_key}, json=body)
                if resp.status_code in (404, 429, 503):
                    reason = f"HTTP {resp.status_code}"
                    with contextlib.suppress(Exception):
                        msg = str((resp.json().get("error") or {}).get("message") or "")
                        if "quota" in msg.lower():
                            reason = "HTTP 429 quota exceeded"
                        elif "no longer available" in msg.lower() or resp.status_code == 404:
                            reason = "HTTP 404 model unavailable"
                        elif resp.status_code == 503:
                            reason = "HTTP 503 high demand"
                    if idx == 0:
                        primary_failure = f"Model '{model}' returned {reason}"
                    last_exc = LLMError(f"Gemini '{candidate}' returned {reason}")
                    continue
                resp.raise_for_status()
                data = resp.json()
                cands = data.get("candidates") or []
                if not cands:
                    raise LLMError("Gemini returned empty candidates.")
                raw_text = str(cands[0]["content"]["parts"][0]["text"])
                warn = (
                    f"{primary_failure}; routed automatically to '{candidate}'."
                    if primary_failure and candidate != model
                    else None
                )
                _LAST_GEMINI_META.set((candidate, warn))
                return raw_text
            except Exception as exc:
                if idx == 0 and primary_failure is None:
                    primary_failure = f"Model '{model}' error ({exc})"
                last_exc = exc
                continue
    raise LLMError(f"{primary_failure or last_exc}")


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

    with httpx.Client(timeout=60.0) as client:
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

    with httpx.Client(timeout=60.0) as client:
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
    "gemini": "gemini-3.5-flash-lite",
    "anthropic": "claude-sonnet-4-5",
    "openai": "gpt-4o-mini",
    "groq": "llama-3.3-70b-versatile",
    "ollama": "qwen2.5:7b",
}
_CLOUD_PROVIDER_ORDER: tuple[str, ...] = ("gemini", "anthropic", "openai", "groq")


def _model_matches_provider(provider: str, model_name: str) -> bool:
    """Prevent stale cross-provider model IDs (e.g. passing 'gemini-...' to Anthropic)."""
    m = model_name.strip().lower()
    if not m:
        return False
    if provider == "gemini":
        return m.startswith(("gemini", "gemma"))
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


def complete_json_with_meta(
    user_prompt: str,
    *,
    system_prompt: str = "",
    role: Literal["scan", "editor"] = "scan",
    image_b64: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    use_cache: bool = True,
) -> LLMCallMeta:
    """Invoke the configured LLM provider and return parsed JSON + model/warning metadata."""
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
        with contextlib.suppress(OSError, json.JSONDecodeError):
            return LLMCallMeta(
                payload=json.loads(cached.read_text(encoding="utf-8")),
                provider=active_provider,
                model_used=chosen_model,
            )

    warning: str | None = None
    model_used = chosen_model

    if active_provider == "gemini":
        key = get_secret("gemini")
        if not key:
            raise LLMError("No Gemini API key configured in Studio Settings.")
        _LAST_GEMINI_META.set(None)
        raw = _call_gemini(
            key, chosen_model or "gemini-3.5-flash-lite", system_prompt, user_prompt, image_b64
        )
        gem_meta = _LAST_GEMINI_META.get()
        if gem_meta is not None:
            model_used, warning = gem_meta
    elif active_provider == "openai":
        key = get_secret("openai")
        if not key:
            raise LLMError("No OpenAI API key configured in Studio Settings.")
        model_used = chosen_model or "gpt-4o-mini"
        raw = _call_openai_compat(
            "https://api.openai.com/v1",
            key,
            model_used,
            system_prompt,
            user_prompt,
            image_b64,
        )
    elif active_provider == "anthropic":
        key = get_secret("anthropic")
        if not key:
            raise LLMError("No Anthropic API key configured in Studio Settings.")
        model_used = chosen_model or "claude-sonnet-4-5"
        raw = _call_anthropic(key, model_used, system_prompt, user_prompt, image_b64)
    elif active_provider == "groq":
        key = get_secret("groq")
        if not key:
            raise LLMError("No Groq API key configured in Studio Settings.")
        model_used = chosen_model or "llama-3.3-70b-versatile"
        raw = _call_openai_compat(
            "https://api.groq.com/openai/v1",
            key,
            model_used,
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
    return LLMCallMeta(
        payload=parsed,
        provider=active_provider,
        model_used=model_used,
        warning=warning,
    )


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
    return complete_json_with_meta(
        user_prompt,
        system_prompt=system_prompt,
        role=role,
        image_b64=image_b64,
        provider=provider,
        model=model,
        use_cache=use_cache,
    ).payload


def list_available_ai_models() -> dict[str, Any]:
    """Return active provider/model routing, key presence, and live/curated model options."""
    cfg = config.load()
    present = keys_presence()
    models_by_provider: dict[str, list[str]] = {
        k: list(v) for k, v in _CURATED_PROVIDER_MODELS.items()
    }

    gemini_key = get_secret("gemini")
    if gemini_key:
        with contextlib.suppress(Exception), httpx.Client(timeout=4.0) as client:
            resp = client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": gemini_key},
            )
            if resp.status_code == 200:
                live = [
                    str(m.get("name", "")).replace("models/", "")
                    for m in resp.json().get("models", [])
                    if "generateContent" in (m.get("supportedGenerationMethods") or [])
                ]
                filtered = [
                    m
                    for m in live
                    if m.startswith(("gemini-3", "gemini-flash", "gemma-4"))
                    and "tts" not in m
                    and "image" not in m
                ]
                merged = list(dict.fromkeys([*models_by_provider["gemini"], *filtered]))
                models_by_provider["gemini"] = merged[:18]

    ollama_cfg = cfg.models.providers.get("ollama")
    ollama_base = (ollama_cfg.base_url if ollama_cfg and ollama_cfg.base_url else None) or (
        "http://127.0.0.1:11434"
    )
    ollama_online = False
    with contextlib.suppress(Exception), httpx.Client(timeout=1.2) as client:
        resp = client.get(f"{ollama_base.rstrip('/')}/api/tags")
        if resp.status_code == 200:
            ollama_online = True
            tags = [str(m.get("name")) for m in (resp.json().get("models") or []) if m.get("name")]
            if tags:
                models_by_provider["ollama"] = list(
                    dict.fromkeys([*tags, *models_by_provider["ollama"]])
                )

    active_provider, resolved_editor = _resolve_provider_and_model(
        cfg, role="editor", explicit_provider=None, explicit_model=None
    )
    return {
        "activeProvider": active_provider,
        "scanModel": cfg.models.scan_model,
        "editorModel": resolved_editor,
        "keysPresent": present,
        "ollamaOnline": ollama_online,
        "modelsByProvider": models_by_provider,
    }
