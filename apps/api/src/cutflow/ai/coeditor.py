"""EDL-native AI Co-Editor (with Selection Scope, Full NLE Ops & Clear Diagnostics)."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from ..edl import TimelineMapper, TimelineProject, apply_edl_patch
from ..security import keys_presence
from ..workspace.profiles import CreatorProfile
from .llm import complete_json as _orig_complete_json
from .llm import complete_json_with_meta

complete_json = _orig_complete_json

log = logging.getLogger(__name__)

_CUT_RANGE_RE = re.compile(
    r"(?:cut|remove|delete|trim)\s+(?:from\s+)?(\d+(?:\.\d+)?)\s*s?\s*(?:to|-|–)\s*(\d+(?:\.\d+)?)\s*s?",
    re.IGNORECASE,
)
_QUOTED_TEXT_RE = re.compile(r"['\"]([^'\"]{1,140})['\"]")
_AT_TIME_RE = re.compile(r"\bat\s+(\d+(?:\.\d+)?)\s*s?\b", re.IGNORECASE)
_SPLIT_PCT_RE = re.compile(r"(\d{2})\s*%")
_SPEED_RE = re.compile(r"(\d+(?:\.\d+)?)\s*x\b", re.IGNORECASE)
_DB_RE = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*db\b", re.IGNORECASE)


@dataclass(slots=True)
class CoEditorResult:
    edl: TimelineProject
    previous_edl: TimelineProject
    applied: list[str]
    ops: list[dict[str, Any]]
    reply: str
    provider: str
    model_used: str = ""
    llm_warning: str | None = None


def _has_any_word(lower: str, words: tuple[str, ...]) -> bool:
    return any(w in lower for w in words)


def _deterministic_ops_from_instruction(
    instruction: str,
    edl: TimelineProject,
    *,
    playhead_ms: int = 0,
    selection: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Parse common NLE editing instructions deterministically when offline or unkeyed."""
    text = instruction.strip()
    lower = text.lower()
    ops: list[dict[str, Any]] = []
    sel = selection or {}
    sel_clip_id = str(sel.get("selectedClipId") or edl.tracks.video.clips[0].id)
    sel_ov_id = str(sel.get("selectedOverlayId") or "")
    in_ms = sel.get("inPointMs")
    out_ms = sel.get("outPointMs")

    remove_verb = _has_any_word(
        lower, ("remove", "delete", "hide", "clear", "drop", "get rid of", "turn off", "disable")
    )

    # 1. Mid-clip blade cut range ("cut 4s to 7.5s") or selected In/Out range or auto jump-cut
    cut_match = _CUT_RANGE_RE.search(text)
    if cut_match:
        s_ms = int(round(float(cut_match.group(1)) * 1000))
        e_ms = int(round(float(cut_match.group(2)) * 1000))
        if e_ms > s_ms:
            ops.append({"op": "blade_cut", "cutStartMs": s_ms, "cutEndMs": e_ms})
    elif (
        in_ms is not None
        and out_ms is not None
        and int(out_ms) > int(in_ms) + 100
        and _has_any_word(
            lower, ("cut selection", "delete selection", "remove selection", "cut this")
        )
    ):
        ops.append({"op": "blade_cut", "cutStartMs": int(in_ms), "cutEndMs": int(out_ms)})
    elif _has_any_word(
        lower,
        (
            "tighten silence",
            "remove dead air",
            "cut silence",
            "remove awkward pause",
            "jump cut",
        ),
    ):
        ops.append({"op": "tighten_silence", "minGapMs": 1100})
    elif _has_any_word(lower, ("split here", "split clip", "split at playhead", "razor")):
        ops.append({"op": "split_clip", "splitAtMs": int(playhead_ms)})
    elif _has_any_word(lower, ("freeze frame", "freeze here", "hold frame")):
        ops.append({"op": "freeze_frame", "timelineMs": int(playhead_ms), "durationMs": 2000})
    elif _has_any_word(lower, ("detach audio", "separate audio", "unlink audio")):
        ops.append({"op": "detach_audio", "clipId": sel_clip_id})
    elif _has_any_word(lower, ("cut pause", "blade cut", "cut 2s", "cut 1.5s")):
        mapper = TimelineMapper(edl)
        s_ms = max(mapper.cold_open_ms, int(playhead_ms))
        e_ms = min(mapper.total_duration_ms, s_ms + 2000)
        if e_ms - s_ms >= 200:
            ops.append({"op": "blade_cut", "cutStartMs": s_ms, "cutEndMs": e_ms})

    # 2. Clip Speed & Reverse ("1.5x speed", "slow motion", "reverse clip")
    spd_match = _SPEED_RE.search(text)
    if spd_match and _has_any_word(lower, ("speed", "fast", "slow", "x")):
        val = max(0.25, min(4.0, float(spd_match.group(1))))
        ops.append({"op": "set_clip_speed", "clipId": sel_clip_id, "speed": val})
    elif "slow motion" in lower or "slow-mo" in lower:
        ops.append({"op": "set_clip_speed", "clipId": sel_clip_id, "speed": 0.5})
    elif "double speed" in lower:
        ops.append({"op": "set_clip_speed", "clipId": sel_clip_id, "speed": 2.0})
    if "reverse clip" in lower or "play backwards" in lower:
        ops.append({"op": "set_clip_speed", "clipId": sel_clip_id, "speed": 1.0, "reverse": True})

    # 3. Subtitle toggle, reveal mode, preset, profanity filter
    sub_op: dict[str, Any] = {"op": "set_subtitles"}
    if _has_any_word(
        lower,
        (
            "hide caption",
            "hide subtitle",
            "captions off",
            "subtitles off",
            "turn off caption",
            "turn off subtitle",
            "no captions",
            "no subtitles",
        ),
    ):
        sub_op["enabled"] = False
    elif _has_any_word(
        lower,
        (
            "show caption",
            "show subtitle",
            "captions on",
            "subtitles on",
            "turn on caption",
            "enable subtitle",
        ),
    ):
        sub_op["enabled"] = True

    if "single word" in lower or "single_word" in lower or "one word" in lower:
        sub_op["revealMode"] = "single_word"
    elif "progressive" in lower or "word by word" in lower or "word-by-word" in lower:
        sub_op["revealMode"] = "progressive"
    elif "group" in lower and _has_any_word(lower, ("caption", "subtitle", "reveal")):
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

    # 4. Hook / Overlay / Seam Card removal & edits (handles "Remove the hook I don't like it"!)
    if remove_verb and _has_any_word(
        lower,
        ("hook", "headline", "overlay", "seam", "banner", "pov", "watermark", "credit", "title"),
    ):
        if "watermark" in lower:
            ops.append({"op": "delete_overlay", "kind": "watermark_tag"})
        elif "credit" in lower:
            ops.append({"op": "delete_overlay", "kind": "cinema_credit"})
        elif sel_ov_id and _has_any_word(lower, ("this", "selected", "overlay")):
            ops.append({"op": "delete_overlay", "overlayId": sel_ov_id})
        elif "all overlay" in lower:
            ops.append({"op": "delete_overlay", "overlayId": "all"})
        else:
            if edl.tracks.overlays:
                ops.append({"op": "delete_overlay"})
            if edl.tracks.video.cold_open and edl.tracks.video.cold_open.enabled:
                ops.append({"op": "set_cold_open", "enabled": False})
    elif _has_any_word(lower, ("title", "seam card", "headline", "hook text")):
        quoted = _QUOTED_TEXT_RE.search(text)
        if quoted:
            ops.append({"op": "set_seam_title", "text": quoted.group(1).strip()})
        elif ":" in text:
            after = text.split(":", 1)[1].strip().strip("'\"")
            if after:
                ops.append({"op": "set_seam_title", "text": after[:120]})

    # 5. Cold-open explicit toggle
    if _has_any_word(
        lower,
        (
            "remove cold open",
            "remove cold-open",
            "cold open off",
            "no cold open",
            "disable cold open",
        ),
    ):
        ops.append({"op": "set_cold_open", "enabled": False})
    elif ("cold open" in lower or "cold-open" in lower) and not remove_verb:
        clip0 = edl.tracks.video.clips[0]
        src_mid = clip0.source_start_ms + (clip0.raw_source_duration_ms // 2)
        ops.append(
            {
                "op": "set_cold_open",
                "enabled": True,
                "sourceStartMs": src_mid,
                "durationMs": 1500,
            }
        )

    # 6. Insert missed word ("insert 'SIU!' at 5.2s")
    if _has_any_word(lower, ("insert ", "add word", "add '", 'add "')):
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

    # 7. Dialogue Gain / Mute & BGM / SFX
    if _has_any_word(
        lower, ("mute voice", "mute dialogue", "mute original", "mute video", "silence voice")
    ):
        ops.append({"op": "set_audio", "muteOriginal": True, "gainDb": -60.0})
    elif _has_any_word(
        lower, ("unmute voice", "unmute dialogue", "unmute original", "restore audio")
    ):
        ops.append({"op": "set_audio", "muteOriginal": False, "gainDb": 0.0})
    else:
        db_match = _DB_RE.search(text)
        if db_match and "bgm" not in lower and "music" not in lower:
            ops.append({"op": "set_audio", "gainDb": float(db_match.group(1))})

    if _has_any_word(lower, ("remove bgm", "bgm off", "no music", "mute bgm", "remove music")):
        ops.append({"op": "set_bgm", "enabled": False})
    elif _has_any_word(
        lower, ("dark cinema bgm", "synthwave", "cinema music", "add bgm", "upbeat bgm")
    ):
        asset = "upbeat_challenge_drive" if "upbeat" in lower else "dark_cinema_pulse"
        ops.append({"op": "set_bgm", "assetId": asset, "duckingEnabled": True})

    if _has_any_word(lower, ("add whoosh", "whoosh sfx")):
        ops.append(
            {"op": "add_sfx", "assetId": "whoosh_flash", "timelineStartMs": int(playhead_ms)}
        )
    elif _has_any_word(lower, ("add hit", "cinema hit", "impact sfx")):
        ops.append({"op": "add_sfx", "assetId": "cinema_hit", "timelineStartMs": int(playhead_ms)})

    # 8. Framing & Output aspect ratio / border / grade
    frame_op: dict[str, Any] = {"op": "set_framing"}
    if "fit" in lower and _has_any_word(lower, ("layout", "frame", "mode", "full")):
        frame_op["mode"] = "fit"
    elif "centre" in lower or "center crop" in lower or "pan and zoom" in lower:
        frame_op["mode"] = "crop"
    elif "split" in lower and not _has_any_word(lower, ("split clip", "split here", "playhead")):
        frame_op["mode"] = "split"
        pct = _SPLIT_PCT_RE.search(text)
        if pct:
            frame_op["splitRatio"] = max(0.20, min(0.65, int(pct.group(1)) / 100.0))
    if len(frame_op) > 1:
        ops.append(frame_op)

    out_op: dict[str, Any] = {"op": "set_output"}
    if "1:1" in lower or "square" in lower:
        out_op["ratio"] = "1:1"
    elif "4:5" in lower:
        out_op["ratio"] = "4:5"
    elif "16:9" in lower or "landscape" in lower:
        out_op["ratio"] = "16:9"
    elif "9:16" in lower or "vertical" in lower:
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
        return ops, "Applied your requested timeline edit."
    return [], ""


def run_coeditor(
    edl: TimelineProject,
    instruction: str,
    *,
    boundaries: str = "",
    playhead_ms: int = 0,
    selection: dict[str, Any] | None = None,
    provider_override: str | None = None,
    model_override: str | None = None,
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
    model_used = ""
    llm_warning: str | None = None

    if use_llm:
        clips_preview = ", ".join(
            f"{c.id}:'{c.label}'@{t0}-{t1}ms(speed={c.speed}x,muted={c.muted})"
            for t0, t1, c in mapper.spans
        )
        words_preview = ", ".join(
            f"{w.id}:'{w.text}'@{w.start_ms}-{w.end_ms}" for w in edl.tracks.subtitles.words[:45]
        )
        overlays_preview = ", ".join(
            f"{o.id}:{o.kind}:'{o.text}'@{o.start_ms}-{o.end_ms}(scale={o.scale})"
            for o in edl.tracks.overlays
        )
        system_prompt = (
            "You are CutFlow's EDL-native AI Video Co-Editor (like Cursor for CapCut/Premiere). "
            "Obey the editor's persistent boundaries strictly. "
            'Return STRICT JSON: {"reply": string, "ops": [...]}.\n'
            "Allowed ops:\n"
            '- {"op": "blade_cut", "cutStartMs": int, "cutEndMs": int}\n'
            '- {"op": "split_clip", "splitAtMs": int}\n'
            '- {"op": "delete_clip", "clipId": string, "ripple"?: bool}\n'
            '- {"op": "duplicate_clip", "clipId": string}\n'
            '- {"op": "set_clip_speed", "clipId": string, "speed": float, "reverse"?: bool}\n'
            '- {"op": "freeze_frame", "timelineMs": int, "durationMs"?: int}\n'
            '- {"op": "detach_audio", "clipId": string}\n'
            '- {"op": "set_clip_audio", "clipId": string, "gainDb"?: float, "muted"?: bool}\n'
            '- {"op": "set_audio", "gainDb"?: float, "muteOriginal"?: bool, '
            '"dialogueEnhance"?: bool} '
            "(Note: gainDb=-60 is -infinity dB silence; +12 is max boost)\n"
            '- {"op": "set_subtitles", "enabled"?: bool, "censorProfanity"?: bool, '
            '"revealMode"?: "group"|"progressive"|"single_word", '
            '"preset"?: "bold_pop"|"karaoke_fill"|"clean_lower"|"boxed"'
            '|"cinema_neon_glow"|"viral_punch_glow", "marginVRatio"?: float}\n'
            '- {"op": "insert_word", "text": string, "startMs": int, "durationMs"?: int}\n'
            '- {"op": "update_word_timing", "wordId": string, "startMs": int, "endMs": int}\n'
            '- {"op": "delete_word", "wordId": string}\n'
            '- {"op": "add_overlay", "kind": "seam_card_white"|"hook_banner_dark"|"cta_pill"'
            '|"pov_top_bar"|"watermark_tag"|"cinema_credit", "text": string, '
            '"startMs"?: int, "endMs"?: int, "scale"?: float}\n'
            '- {"op": "update_overlay", "overlayId"?: string, "text"?: string, '
            '"scale"?: float, "opacity"?: float, "xOffsetRatio"?: float, "yOffsetRatio"?: float}\n'
            '- {"op": "delete_overlay", "overlayId"?: string, "kind"?: string} '
            "(Use overlayId='all' or omit overlayId to remove Headline Hook / banner overlays!)\n"
            '- {"op": "set_seam_title", "text": string}\n'
            '- {"op": "set_cold_open", "enabled": bool, '
            '"sourceStartMs"?: int, "durationMs"?: int}\n'
            '- {"op": "set_framing", "mode"?: "split"|"fit"|"centre"|"crop", '
            '"splitRatio"?: float, "panX"?: float, "panY"?: float, "zoom"?: float}\n'
            '- {"op": "set_bgm", "enabled"?: bool, "assetId"?: string, '
            '"gainDb"?: float, "duckingEnabled"?: bool}\n'
            '- {"op": "add_sfx", "assetId": "whoosh_flash"|"cinema_hit", "timelineStartMs": int}\n'
            '- {"op": "set_output", "ratio"?: "9:16"|"4:5"|"1:1"|"16:9", '
            '"borderStyle"?: "none"|"thin_rounded"|"double_cinema", '
            '"cinemaGrade"?: "off"|"crisp_hd"}\n'
            '- {"op": "tighten_silence", "minGapMs"?: int}'
        )
        f0 = edl.tracks.video.framing[0]
        sub_st = edl.tracks.subtitles.style
        aud_tr = edl.tracks.audio
        user_prompt = (
            f"Clip title: {edl.title}\n"
            f"Total duration: {mapper.total_duration_ms}ms (coldOpen={mapper.cold_open_ms}ms)\n"
            f"Current playhead: {playhead_ms}ms\n"
            f"Active selection scope: {selection or 'None'}\n"
            f"Clips (V1): {clips_preview}\n"
            f"Audio: gainDb={aud_tr.gain_db}, muteOriginal={aud_tr.mute_original}\n"
            f"Framing: mode={f0.mode}, splitRatio={f0.split_ratio}\n"
            f"Subtitles: enabled={edl.tracks.subtitles.enabled}, "
            f"revealMode={sub_st.reveal_mode}, preset={sub_st.preset}\n"
            f"Overlays (G1 — note 'seam_card_white' is the white Headline Hook box on screen!): "
            f"{overlays_preview or 'none'}\n"
            f"Words: {words_preview or 'none'}\n"
            f"Persistent Edit Boundaries (MUST OBEY): {boundaries or 'None'}\n\n"
            f"User instruction: {cleaned}"
        )
        try:
            if complete_json is not _orig_complete_json:
                resp = complete_json(
                    user_prompt,
                    system_prompt=system_prompt,
                    role="editor",
                    provider=provider_override,
                    model=model_override,
                    use_cache=False,
                )
                model_used = model_override or "mock"
            else:
                meta = complete_json_with_meta(
                    user_prompt,
                    system_prompt=system_prompt,
                    role="editor",
                    provider=provider_override,
                    model=model_override,
                    use_cache=False,
                )
                resp = meta.payload
                model_used = f"{meta.provider}:{meta.model_used}"
                llm_warning = meta.warning
            if isinstance(resp, dict) and isinstance(resp.get("ops"), list):
                ops = [item for item in resp["ops"] if isinstance(item, dict)]
                reply = str(resp.get("reply") or "Applied AI Co-Editor updates.").strip()
                provider = "llm"
        except Exception as exc:
            llm_warning = str(exc)
            log.info("Co-Editor LLM call failed (%s); trying deterministic NLE rules.", exc)

    if not ops and provider == "rules":
        ops, det_reply = _deterministic_ops_from_instruction(
            cleaned, edl, playhead_ms=playhead_ms, selection=selection
        )
        if det_reply:
            reply = det_reply

    if not ops:
        any_key = any(v for k, v in keys_presence().items() if k != "huggingface_token")
        if not reply:
            if llm_warning and any_key:
                reply = (
                    f"Provider error ({llm_warning}). Switch model in the Co-Editor picker "
                    f"(e.g. gemini-3.5-flash-lite) or use direct commands like "
                    f'"remove the hook", "speed 1.5x", "mute voice", or "cut 4s to 7s".'
                )
            elif not any_key:
                reply = (
                    "Offline rules mode couldn't map that phrasing yet. Try commands like "
                    '"remove the hook", "cut 4s to 7s", "speed 1.5x", "mute voice", '
                    "or add a Gemini/OpenAI/Groq key in Settings for conversational AI."
                )
            else:
                reply = "No timeline changes were needed for that request."
        snap = edl.model_copy(deep=True)
        return CoEditorResult(
            edl=snap,
            previous_edl=edl.model_copy(deep=True),
            applied=[],
            ops=[],
            reply=reply,
            provider=provider,
            model_used=model_used,
            llm_warning=llm_warning,
        )

    updated, before, summaries = apply_edl_patch(edl, ops)
    return CoEditorResult(
        edl=updated,
        previous_edl=before,
        applied=summaries,
        ops=ops,
        reply=reply or f"Applied {len(summaries)} change(s).",
        provider=provider,
        model_used=model_used,
        llm_warning=llm_warning,
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
            'Instagram Reels. Return STRICT JSON: {"title": string, "description": string, '
            '"hashtags": [string]} (5-8 concise tags without spaces, each starting with #).'
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
                    t if str(t).startswith("#") else f"#{t}" for t in raw_tags if str(t).strip()
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
