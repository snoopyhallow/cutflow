"""EDL-native AI Co-Editor (with persistent Edit Boundaries) and Viral Post Copy generator."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from ..edl import TimelineMapper, TimelineProject, apply_edl_patch
from ..workspace.profiles import CreatorProfile
from .llm import complete_json

log = logging.getLogger(__name__)

_CUT_RANGE_RE = re.compile(
    r"(?:cut|remove|delete|trim)\s+(?:from\s+)?(\d+(?:\.\d+)?)\s*s?\s*(?:to|-|–)\s*(\d+(?:\.\d+)?)\s*s?",
    re.IGNORECASE,
)
_QUOTED_TEXT_RE = re.compile(r"['\"]([^'\"]{1,140})['\"]")
_AT_TIME_RE = re.compile(r"\bat\s+(\d+(?:\.\d+)?)\s*s?\b", re.IGNORECASE)
_SPLIT_PCT_RE = re.compile(r"(\d{2})\s*%")


@dataclass(slots=True)
class CoEditorResult:
    edl: TimelineProject
    previous_edl: TimelineProject
    applied: list[str]
    ops: list[dict[str, Any]]
    reply: str
    provider: str


def _deterministic_ops_from_instruction(
    instruction: str,
    edl: TimelineProject,
    *,
    playhead_ms: int = 0,
) -> tuple[list[dict[str, Any]], str]:
    """Parse common NLE editing instructions deterministically when offline or unkeyed."""
    text = instruction.strip()
    lower = text.lower()
    ops: list[dict[str, Any]] = []

    # 1. Mid-clip blade cut range ("cut 4s to 7.5s") or auto jump-cut silence
    cut_match = _CUT_RANGE_RE.search(text)
    if cut_match:
        s_ms = int(round(float(cut_match.group(1)) * 1000))
        e_ms = int(round(float(cut_match.group(2)) * 1000))
        if e_ms > s_ms:
            ops.append({"op": "blade_cut", "cutStartMs": s_ms, "cutEndMs": e_ms})
    elif any(
        k in lower
        for k in (
            "tighten silence",
            "remove dead air",
            "cut silence",
            "remove awkward pause",
            "jump cut",
        )
    ):
        ops.append({"op": "tighten_silence", "minGapMs": 1100})
    elif any(k in lower for k in ("cut pause", "blade cut", "cut 2s", "cut 1.5s")):
        mapper = TimelineMapper(edl)
        s_ms = max(mapper.cold_open_ms, int(playhead_ms))
        e_ms = min(mapper.total_duration_ms, s_ms + 2000)
        if e_ms - s_ms >= 200:
            ops.append({"op": "blade_cut", "cutStartMs": s_ms, "cutEndMs": e_ms})

    # 2. Subtitle toggle, reveal mode, preset, profanity filter
    sub_op: dict[str, Any] = {"op": "set_subtitles"}
    hide_phrases = (
        "hide caption",
        "hide subtitle",
        "captions off",
        "subtitles off",
        "turn off caption",
        "turn off subtitle",
        "no captions",
        "no subtitles",
    )
    show_phrases = (
        "show caption",
        "show subtitle",
        "captions on",
        "subtitles on",
        "turn on caption",
        "enable subtitle",
    )
    if any(k in lower for k in hide_phrases):
        sub_op["enabled"] = False
    elif any(k in lower for k in show_phrases):
        sub_op["enabled"] = True

    if "single word" in lower or "single_word" in lower or "one word" in lower:
        sub_op["revealMode"] = "single_word"
    elif "progressive" in lower or "word by word" in lower or "word-by-word" in lower:
        sub_op["revealMode"] = "progressive"
    elif "group" in lower and ("caption" in lower or "subtitle" in lower or "reveal" in lower):
        sub_op["revealMode"] = "group"

    for preset in (
        "bold_pop",
        "karaoke_fill",
        "clean_lower",
        "boxed",
        "cinema_neon_glow",
        "viral_punch_glow",
    ):
        if preset in lower or preset.replace("_", " ") in lower:
            sub_op["preset"] = preset
    if "neon glow" in lower:
        sub_op.setdefault("preset", "cinema_neon_glow")

    if "uncensor" in lower or "profanity off" in lower or "allow profanity" in lower:
        sub_op["censorProfanity"] = False
    elif "censor" in lower and "uncensor" not in lower:
        sub_op["censorProfanity"] = True

    if len(sub_op) > 1:
        ops.append(sub_op)

    # 3. Seam Title Card updates
    if any(k in lower for k in ("remove title", "hide title", "no title card", "clear seam title")):
        ops.append({"op": "set_seam_title", "text": ""})
    elif any(k in lower for k in ("title", "seam card", "headline", "hook text")):
        quoted = _QUOTED_TEXT_RE.search(text)
        if quoted:
            ops.append({"op": "set_seam_title", "text": quoted.group(1).strip()})
        elif ":" in text:
            after = text.split(":", 1)[1].strip().strip("'\"")
            if after:
                ops.append({"op": "set_seam_title", "text": after[:120]})

    # 4. Insert missed word ("insert 'SIU!' at 5.2s" / "add 'WHOA' at playhead")
    if any(k in lower for k in ("insert ", "add word", "add '", 'add "')):
        quoted = _QUOTED_TEXT_RE.search(text)
        if quoted:
            at_match = _AT_TIME_RE.search(text)
            at_ms = int(round(float(at_match.group(1)) * 1000)) if at_match else int(playhead_ms)
            ops.append(
                {
                    "op": "insert_word",
                    "text": quoted.group(1).strip(),
                    "startMs": max(0, at_ms),
                    "durationMs": 750,
                }
            )

    # 5. Cold-open toggle
    disable_co_phrases = (
        "remove cold open",
        "remove cold-open",
        "cold open off",
        "no cold open",
        "disable cold open",
        "remove hook",
    )
    if any(k in lower for k in disable_co_phrases):
        ops.append({"op": "set_cold_open", "enabled": False})
    elif "cold open" in lower or "cold-open" in lower:
        clip0 = edl.tracks.video.clips[0]
        src_mid = clip0.source_start_ms + (clip0.duration_ms // 2)
        ops.append(
            {
                "op": "set_cold_open",
                "enabled": True,
                "sourceStartMs": src_mid,
                "durationMs": 1500,
            }
        )

    # 6. Framing layout mode & split ratio
    frame_op: dict[str, Any] = {"op": "set_framing"}
    if "fit" in lower and any(k in lower for k in ("layout", "frame", "mode", "full")):
        frame_op["mode"] = "fit"
    elif "centre" in lower or "center crop" in lower:
        frame_op["mode"] = "centre"
    elif "split" in lower:
        frame_op["mode"] = "split"
        pct = _SPLIT_PCT_RE.search(text)
        if pct:
            frame_op["splitRatio"] = max(0.20, min(0.65, int(pct.group(1)) / 100.0))
    if len(frame_op) > 1:
        ops.append(frame_op)

    # 7. BGM, Aspect Ratio, Cinema Border & Grade
    if any(k in lower for k in ("remove bgm", "bgm off", "no music", "mute bgm")):
        ops.append({"op": "set_bgm", "enabled": False})
    elif any(k in lower for k in ("dark cinema bgm", "synthwave", "cinema music", "add bgm")):
        asset = "upbeat_challenge_drive" if "upbeat" in lower else "dark_cinema_pulse"
        ops.append({"op": "set_bgm", "assetId": asset, "duckingEnabled": True})

    out_op: dict[str, Any] = {"op": "set_output"}
    if "1:1" in lower or "square" in lower:
        out_op["ratio"] = "1:1"
    elif "4:5" in lower:
        out_op["ratio"] = "4:5"
    elif "9:16" in lower:
        out_op["ratio"] = "9:16"
    if "rounded border" in lower or "thin border" in lower:
        out_op["borderStyle"] = "thin_rounded"
    elif "double border" in lower:
        out_op["borderStyle"] = "double_cinema"
    elif "no border" in lower:
        out_op["borderStyle"] = "none"
    if "crisp hd" in lower or "cinema grade" in lower:
        out_op["cinemaGrade"] = "crisp_hd"
    if len(out_op) > 1:
        ops.append(out_op)

    if ops:
        return ops, "Applied your requested timeline edit optimistically."
    return [], (
        "I couldn't map that request offline without an LLM key. Try specific commands like "
        "\"cut 4s to 7s\", \"change title to 'WAIT FOR IT'\", \"single word captions\", "
        "\"add 'SIU!' at 5s\", or add a Gemini/OpenAI/Anthropic key in Settings."
    )


def run_coeditor(
    edl: TimelineProject,
    instruction: str,
    *,
    boundaries: str = "",
    playhead_ms: int = 0,
    use_llm: bool = True,
) -> CoEditorResult:
    """Translate a natural-language request into typed EDL v1 ops and apply optimistically."""
    cleaned = instruction.strip()
    if not cleaned:
        raise ValueError("Co-Editor instruction cannot be empty.")

    mapper = TimelineMapper(edl)
    ops: list[dict[str, Any]] = []
    reply = ""
    provider = "rules"

    if use_llm:
        words_preview = ", ".join(
            f"{w.id}:'{w.text}'@{w.start_ms}-{w.end_ms}"
            for w in edl.tracks.subtitles.words[:40]
        )
        overlays_preview = ", ".join(
            f"{o.id}:{o.kind}:'{o.text}'@{o.start_ms}-{o.end_ms}"
            for o in edl.tracks.overlays
        )
        system_prompt = (
            "You are CutFlow's EDL-native AI Co-Editor. Obey the editor's persistent boundaries "
            "strictly. Return STRICT JSON: {\"reply\": string, \"ops\": [...]}.\n"
            "Allowed ops:\n"
            "- {\"op\": \"blade_cut\", \"cutStartMs\": int, \"cutEndMs\": int}\n"
            "- {\"op\": \"set_subtitles\", \"enabled\"?: bool, \"censorProfanity\"?: bool, "
            "\"revealMode\"?: \"group\"|\"progressive\"|\"single_word\", "
            "\"preset\"?: \"bold_pop\"|\"karaoke_fill\"|\"clean_lower\"|\"boxed\""
            "|\"cinema_neon_glow\"|\"viral_punch_glow\", "
            "\"marginVRatio\"?: float}\n"
            "- {\"op\": \"insert_word\", \"text\": string, \"startMs\": int, "
            "\"durationMs\"?: int}\n"
            "- {\"op\": \"update_word_timing\", \"wordId\": string, "
            "\"startMs\": int, \"endMs\": int}\n"
            "- {\"op\": \"delete_word\", \"wordId\": string}\n"
            "- {\"op\": \"set_seam_title\", \"text\": string}\n"
            "- {\"op\": \"set_cold_open\", \"enabled\": bool, "
            "\"sourceStartMs\"?: int, \"durationMs\"?: int}\n"
            "- {\"op\": \"set_framing\", \"mode\"?: \"split\"|\"fit\"|\"centre\"|\"crop\", "
            "\"splitRatio\"?: float, \"panX\"?: float, \"panY\"?: float, \"zoom\"?: float}\n"
            "- {\"op\": \"set_bgm\", \"enabled\"?: bool, \"assetId\"?: string, "
            "\"gainDb\"?: float, \"duckingEnabled\"?: bool}\n"
            "- {\"op\": \"set_output\", \"ratio\"?: \"9:16\"|\"4:5\"|\"1:1\"|\"16:9\", "
            "\"borderStyle\"?: \"none\"|\"thin_rounded\"|\"double_cinema\", "
            "\"cinemaGrade\"?: \"off\"|\"crisp_hd\"}"
        )
        user_prompt = (
            f"Clip title: {edl.title}\n"
            f"Total duration: {mapper.total_duration_ms}ms (coldOpen={mapper.cold_open_ms}ms)\n"
            f"Current playhead: {playhead_ms}ms\n"
            f"Framing: mode={edl.tracks.video.framing[0].mode}, "
            f"splitRatio={edl.tracks.video.framing[0].split_ratio}\n"
            f"Subtitles: enabled={edl.tracks.subtitles.enabled}, "
            f"revealMode={edl.tracks.subtitles.style.reveal_mode}, "
            f"preset={edl.tracks.subtitles.style.preset}\n"
            f"Overlays: {overlays_preview or 'none'}\n"
            f"Words: {words_preview or 'none'}\n"
            f"Persistent Edit Boundaries (MUST OBEY): {boundaries or 'None'}\n\n"
            f"User instruction: {cleaned}"
        )
        try:
            resp = complete_json(
                user_prompt,
                system_prompt=system_prompt,
                role="editor",
                use_cache=False,
            )
            if isinstance(resp, dict) and isinstance(resp.get("ops"), list):
                ops = [item for item in resp["ops"] if isinstance(item, dict)]
                reply = str(resp.get("reply") or "Applied AI Co-Editor updates.").strip()
                provider = "llm"
        except Exception as exc:
            log.info("Co-Editor LLM fallback to deterministic rules (%s).", exc)

    if not ops and provider == "rules":
        ops, reply = _deterministic_ops_from_instruction(cleaned, edl, playhead_ms=playhead_ms)

    if not ops:
        snap = edl.model_copy(deep=True)
        return CoEditorResult(
            edl=snap,
            previous_edl=edl.model_copy(deep=True),
            applied=[],
            ops=[],
            reply=reply or "No timeline changes were needed.",
            provider=provider,
        )

    updated, before, summaries = apply_edl_patch(edl, ops)
    return CoEditorResult(
        edl=updated,
        previous_edl=before,
        applied=summaries,
        ops=ops,
        reply=reply or f"Applied {len(summaries)} change(s).",
        provider=provider,
    )


def generate_post_copy(
    edl: TimelineProject,
    *,
    profile: CreatorProfile | None = None,
    platform: str = "all",
    use_llm: bool = True,
) -> dict[str, Any]:
    """Generate TikTok/Shorts/Reels post title, description, and hashtags for a clip."""
    transcript_snippet = " ".join(w.text for w in edl.tracks.subtitles.words[:60]).strip()
    seam_title = next(
        (o.text for o in edl.tracks.overlays if o.kind == "seam_card_white" and o.text.strip()),
        edl.title,
    )
    creator = (profile.creator_name or profile.name) if profile else ""

    if use_llm:
        system_prompt = (
            "You write high-retention short-form social captions for TikTok, YouTube Shorts, and "
            "Instagram Reels. Return STRICT JSON: {\"title\": string, \"description\": string, "
            "\"hashtags\": [string]} (5-8 concise tags without spaces, each starting with #)."
        )
        user_prompt = (
            f"Platform target: {platform}\n"
            f"Creator: {creator or 'Gaming / IRL Streamer'}\n"
            f"Clip title: {seam_title or edl.title}\n"
            f"Transcript excerpt: {transcript_snippet or 'High-energy visual moment'}\n"
            f"Brief: {profile.brief if profile else ''}"
        )
        try:
            resp = complete_json(user_prompt, system_prompt=system_prompt, role="editor")
            if isinstance(resp, dict) and resp.get("title"):
                raw_tags = resp.get("hashtags") or []
                tags = [
                    t if str(t).startswith("#") else f"#{t}"
                    for t in raw_tags
                    if str(t).strip()
                ][:10]
                title = str(resp["title"]).strip()[:140]
                desc = str(resp.get("description") or "").strip()[:500]
                return {
                    "platform": platform,
                    "title": title,
                    "description": desc,
                    "hashtags": tags,
                    "fullCopy": f"{title}\n\n{desc}\n\n{' '.join(tags)}".strip(),
                    "provider": "llm",
                }
        except Exception as exc:
            log.info("Post copy LLM skipped/fallback (%s).", exc)

    # Deterministic fallback post copy (works cleanly offline & in Demo Mode)
    clean_title = (seam_title or edl.title or "You Won't Believe This Clip").strip()[:100]
    creator_tag = re.sub(r"[^a-zA-Z0-9]+", "", creator)
    tags = ["#clips", "#shorts", "#viral", "#gaming", "#streamer", "#fyp"]
    if creator_tag:
        tags.insert(0, f"#{creator_tag.lower()}")
    desc = (
        f"{clean_title} — wait until the end! "
        + (f'"{transcript_snippet[:110]}..." ' if transcript_snippet else "")
        + "Drop a comment if you caught that."
    ).strip()
    return {
        "platform": platform,
        "title": clean_title,
        "description": desc,
        "hashtags": tags[:8],
        "fullCopy": f"{clean_title}\n\n{desc}\n\n{' '.join(tags[:8])}",
        "provider": "rules",
    }
