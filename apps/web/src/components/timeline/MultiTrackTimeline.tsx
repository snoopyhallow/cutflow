import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsOutLineHorizontal,
  Copy,
  Cursor,
  Gauge,
  Lightning,
  LinkBreak,
  MagicWand,
  Magnet,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MusicNotes,
  PencilSimple,
  Plus,
  Scissors,
  Snowflake,
  SpeakerHigh,
  SpeakerSlash,
  Subtitles,
  Trash,
  Waveform,
} from "@phosphor-icons/react";
import {
  buildClipSpans,
  formatTimecodeMs,
  getAudioClipDurationMs,
  getBRollDurationMs,
  getColdOpenDurationMs,
  getTotalDurationMs,
  snapToNearestOnsetMs,
  type AudioClipItem,
  type BRollClip,
  type OverlayItem,
  type SubtitleWord,
  type VideoSlice,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { BgmAssetItem, ProjectPeaks } from "../../transport";
import {
  StudioContextMenu,
  type StudioContextMenuState,
} from "../ui/StudioContextMenu";
import { ScrubSlider } from "../ui/StudioControls";
import { WaveformCanvas } from "./WaveformCanvas";

interface MultiTrackTimelineProps {
  peaks: ProjectPeaks | null;
  filmstripUrl?: string | null;
  bgmAssets?: BgmAssetItem[];
  autoCaptioning?: boolean;
  onAutoCaptions?: () => void;
  onError?: (msg: string) => void;
}

export function MultiTrackTimeline({
  peaks,
  filmstripUrl,
  bgmAssets = [],
  autoCaptioning = false,
  onAutoCaptions,
  onError,
}: MultiTrackTimelineProps) {
  const {
    edl,
    playheadMs,
    isPlaying,
    zoomPxPerSec,
    snapToWaveform,
    activeTool,
    rippleMode,
    inPointMs,
    outPointMs,
    selectedWordId,
    selectedOverlayId,
    selectedClipId,
    selectedBrollId,
    selectedAudioClipId,
    setPlayheadMs,
    setIsPlaying,
    togglePlayback,
    setPlaybackRate,
    setZoomPxPerSec,
    toggleSnapToWaveform,
    setActiveTool,
    toggleRippleMode,
    askAiOnSelection,
    setInPointMs,
    setOutPointMs,
    selectWord,
    selectOverlay,
    selectClip,
    selectBroll,
    selectAudioClip,
    setInspectorContext,
    setWordTiming,
    setWordText,
    addWord,
    removeWord,
    updateOverlay,
    duplicateOverlay,
    removeOverlay,
    updateBroll,
    removeBroll,
    addAudioClip,
    updateAudioClip,
    removeAudioClip,
    updateBgm,
    updateSliceTransition,
    bladeCut,
    splitClipAtPlayhead,
    removeClip,
    duplicateSelectedClip,
    trimClip,
    updateClipProps,
    insertFreezeFrame,
    detachAudioFromClip,
    deleteActiveSelection,
    tightenSilence,
    undo,
    redo,
  } = useTimelineStore();

  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const [editingWordId, setEditingWordId] = useState<string | null>(null);
  const [editingWordDraft, setEditingWordDraft] = useState<string>("");
  const [contextMenu, setContextMenu] = useState<StudioContextMenuState | null>(
    null,
  );

  const [wordDrag, setWordDrag] = useState<{
    id: string;
    startMs: number;
    endMs: number;
  } | null>(null);
  const [overlayDrag, setOverlayDrag] = useState<{
    id: string;
    startMs: number;
    endMs: number;
  } | null>(null);

  const totalDurationMs = useMemo(
    () => (edl ? getTotalDurationMs(edl) : 0),
    [edl],
  );
  const coldOpenMs = useMemo(
    () => (edl ? getColdOpenDurationMs(edl) : 0),
    [edl],
  );
  const clipSpans = useMemo(
    () => (edl ? buildClipSpans(edl).spans : []),
    [edl],
  );

  const timelineWidthPx = useMemo(
    () =>
      Math.max(
        680,
        Math.round((Math.max(1000, totalDurationMs) / 1000) * zoomPxPerSec) + 96,
      ),
    [totalDurationMs, zoomPxPerSec],
  );

  const ticks = useMemo(() => {
    const stepSec = zoomPxPerSec >= 130 ? 1 : zoomPxPerSec >= 60 ? 2 : 5;
    const totalSec = Math.ceil(totalDurationMs / 1000);
    const out: number[] = [];
    for (let s = 0; s <= totalSec; s += stepSec) {
      out.push(s * 1000);
    }
    return out;
  }, [totalDurationMs, zoomPxPerSec]);

  // Global Premiere Pro / CapCut Desktop Keyboard Shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (e.target as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && key === "b") {
        e.preventDefault();
        try {
          splitClipAtPlayhead();
        } catch (err) {
          onError?.(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        const st = useTimelineStore.getState();
        if (st.selectedOverlayId) {
          duplicateOverlay(st.selectedOverlayId);
        } else {
          try {
            duplicateSelectedClip();
          } catch (err) {
            onError?.(err instanceof Error ? err.message : String(err));
          }
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const didDelete = deleteActiveSelection(e.shiftKey ? true : undefined);
        if (didDelete) e.preventDefault();
        return;
      }
      if (mod || e.altKey) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlayback();
      } else if (key === "v") {
        setActiveTool("select");
      } else if (key === "b" || key === "c") {
        setActiveTool("razor");
      } else if (key === "s") {
        try {
          splitClipAtPlayhead();
        } catch (err) {
          onError?.(err instanceof Error ? err.message : String(err));
        }
      } else if (key === "i") {
        setInPointMs(useTimelineStore.getState().playheadMs);
      } else if (key === "o") {
        setOutPointMs(useTimelineStore.getState().playheadMs);
      } else if (key === "k") {
        setIsPlaying(false);
      } else if (key === "l") {
        const st = useTimelineStore.getState();
        setIsPlaying(true);
        setPlaybackRate(st.isPlaying && st.playbackRate >= 1 ? Math.min(4, st.playbackRate * 2) : 1);
      } else if (key === "j") {
        setIsPlaying(true);
        setPlaybackRate(-1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    undo,
    redo,
    splitClipAtPlayhead,
    duplicateOverlay,
    duplicateSelectedClip,
    deleteActiveSelection,
    togglePlayback,
    setActiveTool,
    setInPointMs,
    setOutPointMs,
    setIsPlaying,
    setPlaybackRate,
    onError,
  ]);

  useEffect(() => {
    const el = tracksScrollRef.current;
    if (!el || !isPlaying || totalDurationMs <= 0) return;
    const playheadX = (playheadMs / Math.max(1, totalDurationMs)) * (timelineWidthPx - 96);
    const viewRight = el.scrollLeft + el.clientWidth;
    if (playheadX > viewRight - 80 || playheadX < el.scrollLeft) {
      el.scrollLeft = Math.max(0, playheadX - 120);
    }
  }, [playheadMs, isPlaying, totalDurationMs, timelineWidthPx]);

  if (!edl) return null;

  const usablePx = Math.max(580, timelineWidthPx - 96);

  function msToPx(ms: number): number {
    return (ms / Math.max(1, totalDurationMs)) * usablePx;
  }

  function clientXToMs(clientX: number, container: HTMLElement): number {
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(usablePx, clientX - rect.left));
    return Math.round((x / usablePx) * totalDurationMs);
  }

  function startRulerScrub(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsPlaying(false);
    const host = e.currentTarget;
    setPlayheadMs(clientXToMs(e.clientX, host));

    function onMove(ev: PointerEvent) {
      setPlayheadMs(clientXToMs(ev.clientX, host));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startWordEdgeDrag(
    e: React.PointerEvent,
    word: SubtitleWord,
    edge: "start" | "end" | "move",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectWord(word.id);
    const startClientX = e.clientX;
    const pxPerMs = usablePx / Math.max(1, totalDurationMs);
    const origS = word.startMs;
    const origE = word.endMs;
    let latestS = origS;
    let latestE = origE;

    function maybeSnap(ms: number): number {
      if (!snapToWaveform || !peaks || peaks.peaks.length === 0) return ms;
      const coOffset =
        peaks.durationMs < totalDurationMs - 200 ? coldOpenMs : 0;
      const snappedSampleMs = snapToNearestOnsetMs(
        Math.max(0, ms - coOffset),
        peaks.peaks,
        peaks.rateHz,
        120,
      );
      return snappedSampleMs + coOffset;
    }

    function onMove(ev: PointerEvent) {
      const deltaMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      if (edge === "start") {
        const rawS = Math.max(0, Math.min(origE - 60, origS + deltaMs));
        latestS = Math.min(origE - 60, maybeSnap(rawS));
        latestE = origE;
      } else if (edge === "end") {
        const rawE = Math.max(origS + 60, Math.min(totalDurationMs, origE + deltaMs));
        latestS = origS;
        latestE = Math.max(origS + 60, maybeSnap(rawE));
      } else {
        const dur = origE - origS;
        const clampedS = Math.max(0, Math.min(totalDurationMs - dur, origS + deltaMs));
        latestS = maybeSnap(clampedS);
        latestE = Math.min(totalDurationMs, latestS + dur);
      }
      setWordDrag({ id: word.id, startMs: latestS, endMs: latestE });
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWordDrag(null);
      if (latestS !== origS || latestE !== origE) {
        setWordTiming(word.id, latestS, latestE, true);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startOverlayEdgeDrag(
    e: React.PointerEvent,
    overlay: OverlayItem,
    edge: "start" | "end" | "move",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectOverlay(overlay.id);
    const startClientX = e.clientX;
    const pxPerMs = usablePx / Math.max(1, totalDurationMs);
    const origS = overlay.startMs;
    const origE = overlay.endMs;
    let latestS = origS;
    let latestE = origE;

    function onMove(ev: PointerEvent) {
      const deltaMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      if (edge === "start") {
        latestS = Math.max(0, Math.min(origE - 250, origS + deltaMs));
      } else if (edge === "end") {
        latestE = Math.max(origS + 250, Math.min(totalDurationMs, origE + deltaMs));
      } else {
        const dur = origE - origS;
        latestS = Math.max(0, Math.min(totalDurationMs - dur, origS + deltaMs));
        latestE = latestS + dur;
      }
      setOverlayDrag({ id: overlay.id, startMs: latestS, endMs: latestE });
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setOverlayDrag(null);
      if (latestS !== origS || latestE !== origE) {
        updateOverlay(overlay.id, { startMs: latestS, endMs: latestE });
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startClipTrimDrag(
    e: React.PointerEvent,
    clip: VideoSlice,
    edge: "start" | "end" | "move_gap",
    spanStartMs: number,
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    const startClientX = e.clientX;
    const pxPerMs = usablePx / Math.max(1, totalDurationMs);
    const origS = clip.sourceStartMs;
    const origE = clip.sourceEndMs;
    const spd = Math.max(0.25, clip.speed ?? 1);
    const maxSrc = Math.max(origE, edl?.sourceDurationMs ?? origE + 60_000);
    let latestS = origS;
    let latestE = origE;
    let latestTlStart = spanStartMs;

    function onMove(ev: PointerEvent) {
      const deltaTlMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      const deltaSrcMs = Math.round(deltaTlMs * spd);
      if (edge === "start") {
        latestS = Math.max(0, Math.min(origE - 150, origS + deltaSrcMs));
      } else if (edge === "end") {
        latestE = Math.max(origS + 150, Math.min(maxSrc, origE + deltaSrcMs));
      } else {
        latestTlStart = Math.max(coldOpenMs, spanStartMs + deltaTlMs);
      }
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        if (edge === "move_gap" && latestTlStart !== spanStartMs) {
          trimClip(clip.id, { timelineStartMs: latestTlStart });
        } else if (latestS !== origS || latestE !== origE) {
          trimClip(clip.id, { sourceStartMs: latestS, sourceEndMs: latestE });
        }
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startBrollTimelineDrag(
    e: React.PointerEvent,
    br: BRollClip,
    edge: "move" | "end",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectBroll(br.id);
    const startClientX = e.clientX;
    const pxPerMs = usablePx / Math.max(1, totalDurationMs);
    const origTl = br.timelineStartMs;
    const origEnd = br.sourceEndMs;
    let latestTl = origTl;
    let latestEnd = origEnd;

    function onMove(ev: PointerEvent) {
      const deltaMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      if (edge === "move") {
        latestTl = Math.max(0, origTl + deltaMs);
      } else {
        latestEnd = Math.max(br.sourceStartMs + 200, origEnd + deltaMs);
      }
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (edge === "move" && latestTl !== origTl) {
        updateBroll(br.id, { timelineStartMs: latestTl });
      } else if (edge === "end" && latestEnd !== origEnd) {
        updateBroll(br.id, { sourceEndMs: latestEnd });
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startAudioClipDrag(
    e: React.PointerEvent,
    ac: AudioClipItem,
    edge: "move" | "end",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectAudioClip(ac.id);
    const startClientX = e.clientX;
    const pxPerMs = usablePx / Math.max(1, totalDurationMs);
    const origTl = ac.timelineStartMs;
    const origEnd = ac.sourceEndMs;
    let latestTl = origTl;
    let latestEnd = origEnd;

    function onMove(ev: PointerEvent) {
      const deltaMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      if (edge === "move") {
        latestTl = Math.max(0, origTl + deltaMs);
      } else {
        latestEnd = Math.max(ac.sourceStartMs + 100, origEnd + deltaMs);
      }
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (edge === "move" && latestTl !== origTl) {
        updateAudioClip(ac.id, { timelineStartMs: latestTl });
      } else if (edge === "end" && latestEnd !== origEnd) {
        updateAudioClip(ac.id, { sourceEndMs: latestEnd });
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleSplitOrRangeAction() {
    try {
      if (
        inPointMs !== null &&
        outPointMs !== null &&
        Math.abs(outPointMs - inPointMs) >= 150
      ) {
        const s = Math.min(inPointMs, outPointMs);
        const e = Math.max(inPointMs, outPointMs);
        bladeCut(s, e);
      } else {
        splitClipAtPlayhead(playheadMs);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  function openClipContextMenu(
    e: React.MouseEvent,
    clip: VideoSlice,
    idx: number,
    clickedMs: number,
  ) {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    const canDelete = edl!.tracks.video.clips.length > 1;
    const curMuted = Boolean(clip.muted) || (clip.gainDb ?? 0) <= -59.5;
    const curSpeed = clip.speed ?? 1;

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      header: `${clip.label || `Scene ${idx + 1}`} · ${curSpeed}×`,
      items: [
        {
          id: "split_cursor",
          label: `Split Here (${formatTimecodeMs(clickedMs)})`,
          icon: <Scissors className="h-3.5 w-3.5" />,
          onSelect: () => {
            try {
              splitClipAtPlayhead(clickedMs);
            } catch (err) {
              onError?.(err instanceof Error ? err.message : String(err));
            }
          },
        },
        {
          id: "split_playhead",
          label: "Split at Playhead",
          shortcut: "Ctrl+B",
          onSelect: () => {
            try {
              splitClipAtPlayhead(playheadMs);
            } catch (err) {
              onError?.(err instanceof Error ? err.message : String(err));
            }
          },
        },
        {
          id: "dup_clip",
          label: "Duplicate Clip",
          shortcut: "Ctrl+D",
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => duplicateSelectedClip(clip.id),
        },
        {
          id: "freeze_clip",
          label: "Insert Freeze Frame (2.0s)",
          icon: <Snowflake className="h-3.5 w-3.5" />,
          onSelect: () => {
            try {
              insertFreezeFrame(clickedMs, 2000);
            } catch (err) {
              onError?.(err instanceof Error ? err.message : String(err));
            }
          },
        },
        { divider: true },
        {
          id: "mute_clip",
          label: curMuted ? "Unmute Clip Audio" : "Mute Clip Audio",
          icon: curMuted ? (
            <SpeakerHigh className="h-3.5 w-3.5" />
          ) : (
            <SpeakerSlash className="h-3.5 w-3.5" />
          ),
          onSelect: () =>
            updateClipProps(clip.id, {
              muted: !curMuted,
              gainDb: curMuted ? 0 : -60,
            }),
        },
        {
          id: "detach_audio",
          label: clip.audioDetached ? "Audio Detached (on A1)" : "Detach Audio to A1",
          disabled: Boolean(clip.audioDetached),
          icon: <LinkBreak className="h-3.5 w-3.5" />,
          onSelect: () => detachAudioFromClip(clip.id),
        },
        { divider: true },
        {
          id: "spd_05",
          label: "Speed: 0.5× (Slow Motion)",
          icon: <Gauge className="h-3.5 w-3.5" />,
          onSelect: () => updateClipProps(clip.id, { speed: 0.5 }),
        },
        {
          id: "spd_10",
          label: "Speed: 1.0× (Normal)",
          onSelect: () => updateClipProps(clip.id, { speed: 1.0, reverse: false }),
        },
        {
          id: "spd_15",
          label: "Speed: 1.5× (Snappy)",
          onSelect: () => updateClipProps(clip.id, { speed: 1.5 }),
        },
        {
          id: "spd_20",
          label: "Speed: 2.0× (Fast)",
          onSelect: () => updateClipProps(clip.id, { speed: 2.0 }),
        },
        {
          id: "rev_toggle",
          label: clip.reverse ? "Disable Reverse Playback" : "Reverse Clip Playback",
          onSelect: () => updateClipProps(clip.id, { reverse: !clip.reverse }),
        },
        { divider: true },
        {
          id: "trans_flash",
          label: "Incoming Cut: White Flash + Whoosh",
          disabled: idx === 0,
          icon: <Lightning className="h-3.5 w-3.5" />,
          onSelect: () =>
            updateSliceTransition(clip.id, {
              transitionIn: "flash_white",
              transitionSfx: "whoosh_flash",
            }),
        },
        {
          id: "trans_dip",
          label: "Incoming Cut: Dip Black + Sub Hit",
          disabled: idx === 0,
          onSelect: () =>
            updateSliceTransition(clip.id, {
              transitionIn: "dip_black",
              transitionSfx: "cinema_hit",
            }),
        },
        { divider: true },
        {
          id: "ask_ai_clip",
          label: "Ask AI Co-Editor on This Clip...",
          tone: "ai",
          icon: <MagicWand className="h-3.5 w-3.5" />,
          onSelect: () =>
            askAiOnSelection(`Clip "${clip.label || `Scene ${idx + 1}`}"`),
        },
        {
          id: "del_gap",
          label: "Delete Clip (Leave Gap)",
          shortcut: rippleMode ? undefined : "Del",
          disabled: !canDelete,
          tone: "danger",
          icon: <Trash className="h-3.5 w-3.5" />,
          onSelect: () => removeClip(clip.id, false),
        },
        {
          id: "del_ripple",
          label: "Ripple Delete Clip",
          shortcut: rippleMode ? "Del" : "Shift+Del",
          disabled: !canDelete,
          tone: "danger",
          onSelect: () => removeClip(clip.id, true),
        },
      ],
    });
  }

  const hasRange =
    inPointMs !== null &&
    outPointMs !== null &&
    Math.abs(outPointMs - inPointMs) >= 100;
  const rangeStart = hasRange ? Math.min(inPointMs!, outPointMs!) : 0;
  const rangeEnd = hasRange ? Math.max(inPointMs!, outPointMs!) : 0;

  const activeBgm = edl.tracks.audio.bgm;
  const activeBgmMeta = activeBgm
    ? bgmAssets.find((a) => a.id === activeBgm.assetId)
    : undefined;
  const detachedClips = (edl.tracks.audio.clips ?? []).filter(
    (c) => c.kind === "detached",
  );
  const sfxClips = (edl.tracks.audio.clips ?? []).filter(
    (c) => c.kind !== "detached",
  );
  const brollClips = edl.tracks.video.broll ?? [];

  return (
    <section
      onContextMenu={(e) => e.preventDefault()}
      className="flex h-full flex-col bg-[#111114] select-none"
    >
      {/* CapCut / Premiere Timeline Tool Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222228] bg-[#0E0E11] px-3 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          {/* Select (V) vs Razor (B) Tool Switcher */}
          <div className="inline-flex rounded border border-[#25252E] bg-[#09090B] p-0.5">
            <button
              type="button"
              onClick={() => setActiveTool("select")}
              title="Select & Move Tool (V)"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${
                activeTool === "select"
                  ? "bg-[#24242E] text-[#F4F4F5]"
                  : "text-[#71717A] hover:text-[#D4D4D8]"
              }`}
            >
              <Cursor className="h-3 w-3" />
              Select (V)
            </button>
            <button
              type="button"
              onClick={() => setActiveTool("razor")}
              title="Razor Split Tool (B / C) — Click any clip to split"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${
                activeTool === "razor"
                  ? "bg-[#F59E0B] text-[#09090B]"
                  : "text-[#71717A] hover:text-[#D4D4D8]"
              }`}
            >
              <Scissors className="h-3 w-3" />
              Razor (B)
            </button>
          </div>

          <div className="mx-0.5 h-3.5 w-px bg-[#222228]" />

          <button
            type="button"
            onClick={handleSplitOrRangeAction}
            title="Split clip at playhead (Ctrl+B) or cut marked In–Out range"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60"
          >
            <Scissors className="h-3 w-3 text-[#F59E0B]" />
            {hasRange ? "Cut In–Out" : "Split"}
          </button>

          <button
            type="button"
            onClick={() => deleteActiveSelection()}
            title="Delete selected item (Del / Shift+Del for Ripple)"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#EF4444]/60 hover:text-[#FCA5A5]"
          >
            <Trash className="h-3 w-3" />
            Delete
          </button>

          <button
            type="button"
            onClick={() => {
              try {
                insertFreezeFrame(playheadMs, 2000);
              } catch (err) {
                onError?.(err instanceof Error ? err.message : String(err));
              }
            }}
            title="Insert 2.0s Freeze Frame at playhead"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            <Snowflake className="h-3 w-3 text-[#38BDF8]" />
            Freeze
          </button>

          <button
            type="button"
            onClick={() => {
              try {
                detachAudioFromClip();
              } catch (err) {
                onError?.(err instanceof Error ? err.message : String(err));
              }
            }}
            title="Detach audio from selected video clip onto A1"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            <LinkBreak className="h-3 w-3 text-[#A1A1AA]" />
            Detach
          </button>

          <button
            type="button"
            onClick={() => {
              const res = tightenSilence(peaks?.rms, peaks?.rateHz ?? 100, 1100);
              if (res.cutsApplied === 0) {
                onError?.("No dead-air pauses (>= 1.1s) detected to tighten.");
              }
            }}
            title="Automatically jump-cut silent pauses >= 1.1s"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            <Waveform className="h-3.5 w-3.5 text-[#A1A1AA]" />
            Tighten
          </button>

          {onAutoCaptions && (
            <button
              type="button"
              disabled={autoCaptioning}
              onClick={onAutoCaptions}
              title="Generate synced word-level Auto-Captions from video audio"
              className="inline-flex items-center gap-1 rounded border border-[#F59E0B]/45 bg-[#F59E0B]/12 px-2 py-0.5 text-[11px] font-semibold text-[#FDE68A] hover:bg-[#F59E0B]/22 disabled:opacity-50"
            >
              <Subtitles className="h-3.5 w-3.5 text-[#F59E0B]" />
              {autoCaptioning ? "Transcribing..." : "Auto Captions"}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleRippleMode}
            title={
              rippleMode
                ? "Magnetic Ripple ON (CapCut style) — click for Free-Position Gaps (Premiere style)"
                : "Free-Position Gaps ON (Premiere style) — drag clips to create timeline gaps"
            }
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
              rippleMode
                ? "border-[#22C55E]/40 bg-[#22C55E]/10 text-[#86EFAC]"
                : "border-[#38BDF8]/40 bg-[#38BDF8]/10 text-[#7DD3FC]"
            }`}
          >
            <ArrowsOutLineHorizontal className="h-3 w-3" />
            {rippleMode ? "Ripple" : "Free Gap"}
          </button>

          <button
            type="button"
            onClick={toggleSnapToWaveform}
            title="Snap word trims to audio speech onsets"
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
              snapToWaveform
                ? "border-[#F59E0B]/50 bg-[#F59E0B]/12 text-[#FDE68A]"
                : "border-[#222228] bg-[#141418] text-[#71717A]"
            }`}
          >
            <Magnet className="h-3 w-3" />
            Snap
          </button>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoomPxPerSec(zoomPxPerSec - 25)}
              aria-label="Zoom out"
              className="rounded p-0.5 text-[#71717A] hover:bg-[#1C1C22] hover:text-white"
            >
              <MagnifyingGlassMinus className="h-3.5 w-3.5" />
            </button>
            <ScrubSlider
              ariaLabel="Timeline zoom"
              compact
              min={20}
              max={280}
              step={10}
              value={zoomPxPerSec}
              onChange={setZoomPxPerSec}
            />
            <button
              type="button"
              onClick={() => setZoomPxPerSec(zoomPxPerSec + 25)}
              aria-label="Zoom in"
              className="rounded p-0.5 text-[#71717A] hover:bg-[#1C1C22] hover:text-white"
            >
              <MagnifyingGlassPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 7-Track Scrollable Bay */}
      <div className="flex min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Left Sticky Track Headers */}
        <div className="tabular-tc flex w-[96px] shrink-0 flex-col border-r border-[#222228] bg-[#0C0C0F] text-[10px] font-medium text-[#A1A1AA]">
          <div className="flex h-6 shrink-0 items-center border-b border-[#222228] px-2.5 text-[9px] uppercase tracking-wider text-[#52525B]">
            TIMECODE
          </div>
          <div className="flex h-7 shrink-0 items-center border-b border-[#1C1C22] px-2.5">
            G1 · GFX
          </div>
          <div className="flex h-8 shrink-0 items-center border-b border-[#1C1C22] px-2.5">
            T1 · SUBS
          </div>
          <div className="flex h-8 shrink-0 items-center border-b border-[#1C1C22] px-2.5 text-[#7DD3FC]">
            V2 · B-ROLL
          </div>
          <div className="flex h-12 shrink-0 items-center border-b border-[#1C1C22] px-2.5 font-semibold text-[#F4F4F5]">
            V1 · VIDEO
          </div>
          <div className="flex h-9 shrink-0 items-center border-b border-[#1C1C22] px-2.5">
            A1 · VOICE
          </div>
          <div className="flex h-7 shrink-0 items-center border-b border-[#1C1C22] px-2.5">
            A2 · BGM
          </div>
          <div className="flex h-7 shrink-0 items-center px-2.5 text-[#FBBF24]">
            A3 · SFX
          </div>
        </div>

        {/* Right Horizontally Scrollable Tracks + Ruler */}
        <div
          ref={tracksScrollRef}
          className="relative flex-1 overflow-x-auto overflow-y-visible bg-[#09090B]"
        >
          <div className="relative" style={{ width: `${timelineWidthPx}px` }}>
            {/* Scrubbable Timecode Ruler */}
            <div
              onPointerDown={startRulerScrub}
              className="relative h-6 cursor-ew-resize border-b border-[#222228] bg-[#111114]"
            >
              {ticks.map((ms) => (
                <div
                  key={ms}
                  className="tabular-tc pointer-events-none absolute top-0 h-full border-l border-[#27272F] pl-1 pt-0.5 text-[9px] text-[#71717A]"
                  style={{ left: `${msToPx(ms)}px` }}
                >
                  {formatTimecodeMs(ms).slice(0, 5)}
                </div>
              ))}
            </div>

            {/* In/Out Range Highlight */}
            {hasRange && (
              <div
                className="pointer-events-none absolute bottom-0 top-6 z-10 border-x border-[#F59E0B]/70 bg-[#F59E0B]/8"
                style={{
                  left: `${msToPx(rangeStart)}px`,
                  width: `${Math.max(4, msToPx(rangeEnd - rangeStart))}px`,
                }}
              />
            )}

            {/* Warm Amber Playhead Needle */}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-30 w-[1.5px] bg-[#F59E0B]"
              style={{ left: `${msToPx(playheadMs)}px` }}
            >
              <div className="h-2.5 w-2.5 -translate-x-[4.5px] rounded-b-xs bg-[#F59E0B]" />
            </div>

            {/* G1: Graphic Overlays */}
            <div className="relative h-7 border-b border-[#19191F]">
              {edl.tracks.overlays.map((ov) => {
                const startMs =
                  overlayDrag?.id === ov.id ? overlayDrag.startMs : ov.startMs;
                const endMs =
                  overlayDrag?.id === ov.id ? overlayDrag.endMs : ov.endMs;
                const isSelected = selectedOverlayId === ov.id;
                return (
                  <div
                    key={ov.id}
                    onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "move")}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectOverlay(ov.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      selectOverlay(ov.id);
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        header: `Overlay · ${ov.text || ov.kind}`,
                        items: [
                          {
                            id: "dup_ov",
                            label: "Duplicate Overlay",
                            shortcut: "Ctrl+D",
                            icon: <Copy className="h-3.5 w-3.5" />,
                            onSelect: () => duplicateOverlay(ov.id),
                          },
                          {
                            id: "span_all",
                            label: "Match Entire Timeline",
                            onSelect: () =>
                              updateOverlay(ov.id, {
                                startMs: 0,
                                endMs: totalDurationMs,
                              }),
                          },
                          { divider: true },
                          {
                            id: "ai_ov",
                            label: "Ask AI on Overlay...",
                            tone: "ai",
                            icon: <MagicWand className="h-3.5 w-3.5" />,
                            onSelect: () =>
                              askAiOnSelection(
                                `Overlay "${ov.text.slice(0, 24)}" (${ov.kind})`,
                              ),
                          },
                          {
                            id: "del_ov",
                            label: "Delete Overlay",
                            shortcut: "Del",
                            tone: "danger",
                            icon: <Trash className="h-3.5 w-3.5" />,
                            onSelect: () => removeOverlay(ov.id),
                          },
                        ],
                      });
                    }}
                    className={`group absolute inset-y-1 flex cursor-grab items-center rounded border px-2 text-[10px] font-medium transition-colors active:cursor-grabbing ${
                      isSelected
                        ? "border-[#F59E0B] bg-[#24242C] text-[#F4F4F5]"
                        : "border-[#2C2C36] bg-[#17171D] text-[#D4D4D8] hover:border-[#3F3F4C]"
                    }`}
                    style={{
                      left: `${msToPx(startMs)}px`,
                      width: `${Math.max(24, msToPx(endMs - startMs))}px`,
                    }}
                  >
                    <div
                      onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "start")}
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l bg-[#F59E0B]/80 opacity-0 group-hover:opacity-100"
                    />
                    <span className="truncate">{ov.text || ov.kind}</span>
                    <div
                      onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "end")}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-[#F59E0B]/80 opacity-0 group-hover:opacity-100"
                    />
                  </div>
                );
              })}
            </div>

            {/* T1: Subtitle Word Time-Stops */}
            <div className="relative flex h-8 items-center border-b border-[#19191F]">
              {edl.tracks.subtitles.words.length === 0 ? (
                <div className="flex items-center gap-2 px-2 text-[10px] text-[#71717A]">
                  <span>No captions on timeline yet.</span>
                  {onAutoCaptions && (
                    <button
                      type="button"
                      disabled={autoCaptioning}
                      onClick={onAutoCaptions}
                      className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-1.5 py-0.5 font-semibold text-[#FBBF24] hover:bg-[#F59E0B]/20"
                    >
                      {autoCaptioning ? "Generating..." : "+ Generate Auto-Captions"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => addWord("CAPTION", playheadMs, 750)}
                    className="rounded border border-[#2C2C35] bg-[#16161C] px-1.5 py-0.5 text-[#D4D4D8] hover:text-white"
                  >
                    + Add Word
                  </button>
                </div>
              ) : (
                edl.tracks.subtitles.words.map((w) => {
                  const startMs =
                    wordDrag?.id === w.id ? wordDrag.startMs : w.startMs;
                  const endMs = wordDrag?.id === w.id ? wordDrag.endMs : w.endMs;
                  const isSelected = selectedWordId === w.id;
                  const isEditing = editingWordId === w.id;
                  const widthPx = Math.max(22, msToPx(endMs - startMs));

                  return (
                    <div
                      key={w.id}
                      onPointerDown={(e) => {
                        if (!isEditing) startWordEdgeDrag(e, w, "move");
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectWord(w.id);
                        setPlayheadMs(startMs);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingWordId(w.id);
                        setEditingWordDraft(w.text);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectWord(w.id);
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          header: `Caption · "${w.text}"`,
                          items: [
                            {
                              id: "edit_w",
                              label: "Edit Word Text",
                              shortcut: "Dbl-Click",
                              icon: <PencilSimple className="h-3.5 w-3.5" />,
                              onSelect: () => {
                                setEditingWordId(w.id);
                                setEditingWordDraft(w.text);
                              },
                            },
                            {
                              id: "ins_after",
                              label: "Insert Word After",
                              icon: <Plus className="h-3.5 w-3.5" />,
                              onSelect: () => addWord("WORD", endMs + 20, 600),
                            },
                            { divider: true },
                            {
                              id: "glow_gold",
                              label: "Neon Glow: Gold",
                              onSelect: () => setWordText(w.id, w.text, "#FBBF24"),
                            },
                            {
                              id: "glow_blue",
                              label: "Neon Glow: Electric Blue",
                              onSelect: () => setWordText(w.id, w.text, "#4F7CFF"),
                            },
                            {
                              id: "glow_clear",
                              label: "Clear Custom Glow",
                              onSelect: () => setWordText(w.id, w.text, null),
                            },
                            { divider: true },
                            {
                              id: "del_w",
                              label: "Delete Word",
                              shortcut: "Del",
                              tone: "danger",
                              icon: <Trash className="h-3.5 w-3.5" />,
                              onSelect: () => removeWord(w.id),
                            },
                          ],
                        });
                      }}
                      title={`${w.text} (${formatTimecodeMs(startMs)}–${formatTimecodeMs(endMs)})`}
                      className={`group absolute inset-y-1 flex cursor-grab items-center justify-center gap-1 rounded border px-1 text-[10px] font-medium active:cursor-grabbing ${
                        isSelected
                          ? "z-20 border-[#F59E0B] bg-[#F59E0B] font-semibold text-[#09090B]"
                          : "border-[#2E2E38] bg-[#18181E] text-[#E4E4E7] hover:border-[#444452]"
                      }`}
                      style={{
                        left: `${msToPx(startMs)}px`,
                        width: `${widthPx}px`,
                      }}
                    >
                      <div
                        onPointerDown={(e) => startWordEdgeDrag(e, w, "start")}
                        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l bg-white/70 opacity-0 group-hover:opacity-100"
                      />
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingWordDraft}
                          onChange={(e) => setEditingWordDraft(e.target.value)}
                          onBlur={() => {
                            setWordText(w.id, editingWordDraft);
                            setEditingWordId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              setWordText(w.id, editingWordDraft);
                              setEditingWordId(null);
                            } else if (e.key === "Escape") {
                              setEditingWordId(null);
                            }
                          }}
                          className="w-full rounded bg-[#09090B] px-1 text-[10px] text-white outline-none"
                        />
                      ) : (
                        <>
                          {w.glowColor && !isSelected && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: w.glowColor }}
                            />
                          )}
                          <span className="truncate">{w.text}</span>
                        </>
                      )}
                      <div
                        onPointerDown={(e) => startWordEdgeDrag(e, w, "end")}
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-white/70 opacity-0 group-hover:opacity-100"
                      />
                    </div>
                  );
                })
              )}
            </div>

            {/* V2: B-Roll / Picture-in-Picture Track */}
            <div className="relative flex h-8 items-center border-b border-[#19191F]">
              {brollClips.length === 0 ? (
                <span className="px-2 text-[10px] text-[#52525B]">
                  Drop or add B-Roll / PiP clips from Media Drawer...
                </span>
              ) : (
                brollClips.map((br) => {
                  const dur = getBRollDurationMs(br);
                  const isSel = selectedBrollId === br.id;
                  return (
                    <div
                      key={br.id}
                      onPointerDown={(e) => startBrollTimelineDrag(e, br, "move")}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectBroll(br.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectBroll(br.id);
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          header: `B-Roll · ${br.label || "PiP"}`,
                          items: [
                            {
                              id: "br_pip",
                              label: "Layout: Picture-in-Picture",
                              onSelect: () =>
                                updateBroll(br.id, {
                                  box: { x: 0.56, y: 0.06, w: 0.38, h: 0.28 },
                                }),
                            },
                            {
                              id: "br_full",
                              label: "Layout: Full Cutaway",
                              onSelect: () =>
                                updateBroll(br.id, {
                                  box: { x: 0, y: 0, w: 1, h: 1 },
                                }),
                            },
                            {
                              id: "br_mute",
                              label:
                                br.muted ?? true
                                  ? "Unmute B-Roll Audio"
                                  : "Mute B-Roll Audio",
                              onSelect: () =>
                                updateBroll(br.id, {
                                  muted: !(br.muted ?? true),
                                  gainDb: br.muted ?? true ? 0 : -60,
                                }),
                            },
                            { divider: true },
                            {
                              id: "br_del",
                              label: "Delete B-Roll",
                              shortcut: "Del",
                              tone: "danger",
                              icon: <Trash className="h-3.5 w-3.5" />,
                              onSelect: () => removeBroll(br.id),
                            },
                          ],
                        });
                      }}
                      style={{
                        left: `${msToPx(br.timelineStartMs)}px`,
                        width: `${Math.max(28, msToPx(dur))}px`,
                      }}
                      className={`group absolute inset-y-1 flex cursor-grab items-center justify-between rounded border px-2 text-[10px] font-medium active:cursor-grabbing ${
                        isSel
                          ? "border-[#38BDF8] bg-[#0C2636] text-[#E0F2FE]"
                          : "border-[#1E3A4C] bg-[#0E1B24] text-[#BAE6FD] hover:border-[#38BDF8]/60"
                      }`}
                    >
                      <span className="truncate">{br.label || "B-Roll"}</span>
                      <div
                        onPointerDown={(e) => startBrollTimelineDrag(e, br, "end")}
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-[#38BDF8] opacity-0 group-hover:opacity-100"
                      />
                    </div>
                  );
                })
              )}
            </div>

            {/* V1: Main Video Slices (Supports Magnetic Ripple, Free Gaps, Trim Handles & Right-Click) */}
            <div className="relative h-12 border-b border-[#19191F]">
              {coldOpenMs > 0 && (
                <div
                  className="absolute inset-y-1 left-0 flex items-center justify-center truncate rounded border border-[#F59E0B]/45 bg-[#1C1810] px-1.5 text-[10px] font-semibold text-[#FDE68A]"
                  style={{ width: `${msToPx(coldOpenMs)}px` }}
                >
                  Hook {(coldOpenMs / 1000).toFixed(1)}s
                </div>
              )}

              {clipSpans.map((span, idx) => {
                const { clip, tStart, tEnd } = span;
                const dur = tEnd - tStart;
                const displayLabel = clip.label?.trim() || `Scene ${idx + 1}`;
                const isSelectedClip = selectedClipId === clip.id;
                const hasTrans =
                  idx > 0 && clip.transitionIn && clip.transitionIn !== "none";
                const isFrozen = Boolean(
                  clip.freezeDurationMs && clip.freezeDurationMs > 0,
                );
                const isMutedClip =
                  Boolean(clip.muted) ||
                  Boolean(clip.audioDetached) ||
                  (clip.gainDb ?? 0) <= -59.5;
                const spd = clip.speed ?? 1;

                return (
                  <div
                    key={clip.id}
                    onPointerDown={(e) => {
                      if (activeTool === "select" && !rippleMode) {
                        startClipTrimDrag(e, clip, "move_gap", tStart);
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const host = e.currentTarget.parentElement as HTMLElement;
                      const clickedMs = clientXToMs(e.clientX, host);
                      if (activeTool === "razor") {
                        try {
                          splitClipAtPlayhead(clickedMs);
                        } catch (err) {
                          onError?.(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                        return;
                      }
                      selectClip(clip.id);
                    }}
                    onContextMenu={(e) => {
                      const host = e.currentTarget.parentElement as HTMLElement;
                      const clickedMs = clientXToMs(e.clientX, host);
                      openClipContextMenu(e, clip, idx, clickedMs);
                    }}
                    style={{
                      left: `${msToPx(tStart)}px`,
                      width: `${Math.max(24, msToPx(dur))}px`,
                      ...(filmstripUrl
                        ? {
                            backgroundImage: `linear-gradient(rgba(9,9,11,0.56), rgba(9,9,11,0.76)), url("${filmstripUrl}")`,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                          }
                        : {}),
                    }}
                    className={`group absolute inset-y-1 flex items-center justify-between overflow-hidden rounded border px-2 text-[10px] transition-colors ${
                      activeTool === "razor"
                        ? "cursor-crosshair"
                        : rippleMode
                          ? "cursor-pointer"
                          : "cursor-grab active:cursor-grabbing"
                    } ${
                      isSelectedClip
                        ? "z-10 border-[#F59E0B] bg-[#1F1F27] text-white"
                        : "border-[#2E2E38] bg-[#16161C] text-[#E4E4E7] hover:border-[#454554]"
                    }`}
                  >
                    {/* Left Trim Handle */}
                    <div
                      onPointerDown={(e) =>
                        startClipTrimDrag(e, clip, "start", tStart)
                      }
                      title="Drag left edge to trim clip In point"
                      className="absolute inset-y-0 left-0 z-20 w-2 cursor-ew-resize rounded-l bg-[#F59E0B]/85 opacity-0 transition-opacity group-hover:opacity-100"
                    />

                    <div className="flex min-w-0 items-center gap-1.5">
                      {idx > 0 && (
                        <button
                          type="button"
                          title="Click to cycle cut transition"
                          onClick={(e) => {
                            e.stopPropagation();
                            const cur = clip.transitionIn ?? "none";
                            const next =
                              cur === "none"
                                ? "flash_white"
                                : cur === "flash_white"
                                  ? "dip_black"
                                  : "none";
                            const sfx =
                              next === "flash_white"
                                ? "whoosh_flash"
                                : next === "dip_black"
                                  ? "cinema_hit"
                                  : "none";
                            updateSliceTransition(clip.id, {
                              transitionIn: next,
                              transitionSfx: sfx,
                            });
                          }}
                          className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold ${
                            hasTrans
                              ? "bg-[#F59E0B] text-[#09090B]"
                              : "bg-black/60 text-[#A1A1AA] hover:text-white"
                          }`}
                        >
                          <Lightning weight="fill" className="h-2.5 w-2.5" />
                          {clip.transitionIn === "flash_white"
                            ? "Flash"
                            : clip.transitionIn === "dip_black"
                              ? "Dip"
                              : "Cut"}
                        </button>
                      )}
                      <span className="truncate font-medium drop-shadow">
                        {displayLabel}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {isFrozen && (
                        <span className="rounded bg-[#0284C7]/30 px-1 text-[8px] font-bold text-[#7DD3FC]">
                          FREEZE
                        </span>
                      )}
                      {Math.abs(spd - 1) >= 0.01 && !isFrozen && (
                        <span className="tabular-tc rounded bg-[#F59E0B]/20 px-1 text-[8px] font-bold text-[#FBBF24]">
                          {spd}×
                        </span>
                      )}
                      {clip.reverse && (
                        <span className="rounded bg-purple-500/25 px-1 text-[8px] font-bold text-purple-300">
                          REV
                        </span>
                      )}
                      {isMutedClip && (
                        <SpeakerSlash className="h-3 w-3 text-[#EF4444]" />
                      )}
                      <span className="tabular-tc text-[10px] text-[#A1A1AA]">
                        {(dur / 1000).toFixed(1)}s
                      </span>
                    </div>

                    {/* Right Trim Handle */}
                    <div
                      onPointerDown={(e) =>
                        startClipTrimDrag(e, clip, "end", tStart)
                      }
                      title="Drag right edge to trim clip Out point"
                      className="absolute inset-y-0 right-0 z-20 w-2 cursor-ew-resize rounded-r bg-[#F59E0B]/85 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </div>
                );
              })}

              {edl.tracks.video.framing.length > 1 &&
                edl.tracks.video.framing.map((f) => (
                  <div
                    key={f.id}
                    onClick={() => setPlayheadMs(f.timelineStartMs)}
                    title={`Shot keyframe: ${f.mode}`}
                    className="tabular-tc absolute top-0.5 z-10 cursor-pointer rounded border border-[#3F3F4C] bg-[#09090B]/90 px-1 text-[8px] font-semibold uppercase text-[#FBBF24]"
                    style={{ left: `${msToPx(f.timelineStartMs) + 2}px` }}
                  >
                    {f.mode}
                  </div>
                ))}
            </div>

            {/* A1: 100Hz Dialogue Waveform + Detached Audio Clips */}
            <div
              onPointerDown={startRulerScrub}
              className="relative flex h-9 cursor-ew-resize items-center border-b border-[#19191F]"
            >
              <WaveformCanvas
                peaks={peaks}
                totalDurationMs={totalDurationMs}
                widthPx={usablePx}
                heightPx={32}
                coldOpenMs={coldOpenMs}
                showOnsetMarkers={snapToWaveform}
              />
              {detachedClips.map((ac) => {
                const dur = getAudioClipDurationMs(ac);
                const isSel = selectedAudioClipId === ac.id;
                return (
                  <div
                    key={ac.id}
                    onPointerDown={(e) => startAudioClipDrag(e, ac, "move")}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectAudioClip(ac.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      selectAudioClip(ac.id);
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        header: `Detached Audio · ${ac.label || "A1"}`,
                        items: [
                          {
                            id: "ac_mute",
                            label: ac.muted ? "Unmute Audio Clip" : "Mute Audio Clip",
                            onSelect: () =>
                              updateAudioClip(ac.id, { muted: !ac.muted }),
                          },
                          {
                            id: "ac_reset",
                            label: "Reset Volume (0 dB)",
                            onSelect: () =>
                              updateAudioClip(ac.id, { gainDb: 0, muted: false }),
                          },
                          { divider: true },
                          {
                            id: "ac_del",
                            label: "Delete Detached Audio",
                            shortcut: "Del",
                            tone: "danger",
                            icon: <Trash className="h-3.5 w-3.5" />,
                            onSelect: () => removeAudioClip(ac.id),
                          },
                        ],
                      });
                    }}
                    style={{
                      left: `${msToPx(ac.timelineStartMs)}px`,
                      width: `${Math.max(28, msToPx(dur))}px`,
                    }}
                    className={`group absolute inset-y-1 z-10 flex cursor-grab items-center justify-between rounded border px-2 text-[10px] font-medium active:cursor-grabbing ${
                      isSel
                        ? "border-[#22C55E] bg-[#0B2918]/90 text-[#BBF7D0]"
                        : "border-[#1E462D] bg-[#0D2115]/85 text-[#86EFAC]"
                    }`}
                  >
                    <span className="truncate">{ac.label || "Detached Audio"}</span>
                    <div
                      onPointerDown={(e) => startAudioClipDrag(e, ac, "end")}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-[#22C55E] opacity-0 group-hover:opacity-100"
                    />
                  </div>
                );
              })}
            </div>

            {/* A2: Background Music & Auto-Ducking Track */}
            <div
              onClick={() => setInspectorContext("audio")}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  header: "A2 · Background Music",
                  items: activeBgm
                    ? [
                        {
                          id: "bgm_duck",
                          label: activeBgm.duckingEnabled
                            ? "Disable Sidechain Auto-Duck"
                            : "Enable Sidechain Auto-Duck",
                          onSelect: () =>
                            updateBgm({
                              duckingEnabled: !activeBgm.duckingEnabled,
                            }),
                        },
                        {
                          id: "bgm_open",
                          label: "Open Audio Mixer...",
                          onSelect: () => setInspectorContext("audio"),
                        },
                        { divider: true },
                        {
                          id: "bgm_remove",
                          label: "Remove BGM Track",
                          tone: "danger",
                          icon: <Trash className="h-3.5 w-3.5" />,
                          onSelect: () => updateBgm(null),
                        },
                      ]
                    : [
                        {
                          id: "bgm_cinema",
                          label: "Add Dark Cinema Synth Pulse",
                          onSelect: () =>
                            updateBgm({
                              assetId: "dark_cinema_pulse",
                              duckingEnabled: true,
                            }),
                        },
                        {
                          id: "bgm_upbeat",
                          label: "Add Upbeat Challenge Drive",
                          onSelect: () =>
                            updateBgm({
                              assetId: "upbeat_challenge_drive",
                              duckingEnabled: true,
                            }),
                        },
                      ],
                });
              }}
              className="relative flex h-7 cursor-pointer items-center border-b border-[#19191F] px-0.5"
            >
              {activeBgm ? (
                <div className="flex h-5 items-center justify-between rounded border border-[#2C2C38] bg-[#14141A] px-2.5 text-[10px] text-[#D4D4D8] hover:border-[#F59E0B]/50" style={{ width: `${usablePx}px` }}>
                  <span className="inline-flex items-center gap-1.5 truncate font-medium">
                    <MusicNotes className="h-3 w-3 text-[#F59E0B]" />
                    {activeBgmMeta?.name ?? activeBgm.assetId ?? "BGM Bed"}
                  </span>
                  <span className="tabular-tc text-[9px] text-[#A1A1AA]">
                    {activeBgm.gainDb <= -59.5
                      ? "-∞ dB"
                      : `${activeBgm.gainDb.toFixed(1)} dB`}
                    {activeBgm.duckingEnabled ? " · SIDECHAIN DUCK" : ""}
                  </span>
                </div>
              ) : (
                <span className="px-2 text-[10px] text-[#52525B] hover:text-[#A1A1AA]">
                  + Click or right-click to attach Background Music bed...
                </span>
              )}
            </div>

            {/* A3: Multi-SFX & Custom Audio Track */}
            <div className="relative flex h-7 items-center px-0.5">
              {sfxClips.length === 0 ? (
                <div className="flex items-center gap-2 px-2 text-[10px] text-[#52525B]">
                  <span>A3 Sound Effects</span>
                  <button
                    type="button"
                    onClick={() =>
                      addAudioClip({
                        kind: "sfx",
                        assetId: "whoosh_flash",
                        label: "Whoosh",
                        sourceEndMs: 450,
                        timelineStartMs: playheadMs,
                      })
                    }
                    className="rounded border border-[#272730] bg-[#141418] px-1.5 py-0.5 text-[9px] text-[#A1A1AA] hover:text-white"
                  >
                    + Whoosh
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addAudioClip({
                        kind: "sfx",
                        assetId: "cinema_hit",
                        label: "Sub Hit",
                        sourceEndMs: 900,
                        timelineStartMs: playheadMs,
                      })
                    }
                    className="rounded border border-[#272730] bg-[#141418] px-1.5 py-0.5 text-[9px] text-[#A1A1AA] hover:text-white"
                  >
                    + Sub Hit
                  </button>
                </div>
              ) : (
                sfxClips.map((ac) => {
                  const dur = getAudioClipDurationMs(ac);
                  const isSel = selectedAudioClipId === ac.id;
                  return (
                    <div
                      key={ac.id}
                      onPointerDown={(e) => startAudioClipDrag(e, ac, "move")}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectAudioClip(ac.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectAudioClip(ac.id);
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          header: `SFX · ${ac.label || ac.assetId}`,
                          items: [
                            {
                              id: "sfx_dup",
                              label: "Duplicate SFX",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onSelect: () =>
                                addAudioClip({
                                  kind: ac.kind,
                                  assetId: ac.assetId,
                                  sourceId: ac.sourceId,
                                  label: ac.label,
                                  sourceStartMs: ac.sourceStartMs,
                                  sourceEndMs: ac.sourceEndMs,
                                  timelineStartMs: ac.timelineStartMs + dur + 100,
                                  gainDb: ac.gainDb,
                                }),
                            },
                            {
                              id: "sfx_mute",
                              label: ac.muted ? "Unmute SFX" : "Mute SFX",
                              onSelect: () =>
                                updateAudioClip(ac.id, { muted: !ac.muted }),
                            },
                            { divider: true },
                            {
                              id: "sfx_del",
                              label: "Delete SFX",
                              shortcut: "Del",
                              tone: "danger",
                              icon: <Trash className="h-3.5 w-3.5" />,
                              onSelect: () => removeAudioClip(ac.id),
                            },
                          ],
                        });
                      }}
                      style={{
                        left: `${msToPx(ac.timelineStartMs)}px`,
                        width: `${Math.max(26, msToPx(dur))}px`,
                      }}
                      className={`group absolute inset-y-1 flex cursor-grab items-center justify-between rounded border px-1.5 text-[9px] font-semibold active:cursor-grabbing ${
                        isSel
                          ? "border-[#F59E0B] bg-[#2D200B] text-[#FDE68A]"
                          : "border-[#4A3514] bg-[#1F170B] text-[#FBBF24] hover:border-[#F59E0B]/60"
                      }`}
                    >
                      <span className="truncate">{ac.label || "SFX"}</span>
                      <div
                        onPointerDown={(e) => startAudioClipDrag(e, ac, "end")}
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-[#F59E0B] opacity-0 group-hover:opacity-100"
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <StudioContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    </section>
  );
}
