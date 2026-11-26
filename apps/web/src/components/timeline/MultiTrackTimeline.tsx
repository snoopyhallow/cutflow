import { useEffect, useMemo, useRef, useState } from "react";
import {
  Lightning,
  Magnet,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MusicNotes,
  Plus,
  Scissors,
  Waveform,
} from "@phosphor-icons/react";
import {
  formatTimecodeMs,
  getColdOpenDurationMs,
  getTotalDurationMs,
  snapToNearestOnsetMs,
  type OverlayItem,
  type SubtitleWord,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { BgmAssetItem, ProjectPeaks } from "../../transport";
import { ScrubSlider } from "../ui/StudioControls";
import { WaveformCanvas } from "./WaveformCanvas";

interface MultiTrackTimelineProps {
  peaks: ProjectPeaks | null;
  filmstripUrl?: string | null;
  bgmAssets?: BgmAssetItem[];
  onError?: (msg: string) => void;
}

export function MultiTrackTimeline({
  peaks,
  filmstripUrl,
  bgmAssets = [],
  onError,
}: MultiTrackTimelineProps) {
  const {
    edl,
    playheadMs,
    isPlaying,
    zoomPxPerSec,
    snapToWaveform,
    inPointMs,
    outPointMs,
    selectedWordId,
    selectedOverlayId,
    selectedClipId,
    setPlayheadMs,
    setIsPlaying,
    setZoomPxPerSec,
    toggleSnapToWaveform,
    setInPointMs,
    setOutPointMs,
    clearInOut,
    selectWord,
    selectOverlay,
    selectClip,
    setInspectorContext,
    setWordTiming,
    setWordText,
    addWord,
    updateOverlay,
    updateSliceTransition,
    bladeCut,
    tightenSilence,
  } = useTimelineStore();

  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const [editingWordId, setEditingWordId] = useState<string | null>(null);
  const [editingWordDraft, setEditingWordDraft] = useState<string>("");

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

  const totalDurationMs = useMemo(() => (edl ? getTotalDurationMs(edl) : 0), [edl]);
  const coldOpenMs = useMemo(() => (edl ? getColdOpenDurationMs(edl) : 0), [edl]);

  const timelineWidthPx = useMemo(
    () => Math.max(680, Math.round((Math.max(1000, totalDurationMs) / 1000) * zoomPxPerSec)),
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

  useEffect(() => {
    const el = tracksScrollRef.current;
    if (!el || !isPlaying || totalDurationMs <= 0) return;
    const playheadX = (playheadMs / totalDurationMs) * timelineWidthPx;
    const viewRight = el.scrollLeft + el.clientWidth;
    if (playheadX > viewRight - 80 || playheadX < el.scrollLeft) {
      el.scrollLeft = Math.max(0, playheadX - 120);
    }
  }, [playheadMs, isPlaying, totalDurationMs, timelineWidthPx]);

  if (!edl) return null;

  function msToPx(ms: number): number {
    return (ms / Math.max(1, totalDurationMs)) * timelineWidthPx;
  }

  function clientXToMs(clientX: number, container: HTMLElement): number {
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(timelineWidthPx, clientX - rect.left));
    return Math.round((x / timelineWidthPx) * totalDurationMs);
  }

  function startRulerScrub(e: React.PointerEvent<HTMLDivElement>) {
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
    e.preventDefault();
    e.stopPropagation();
    selectWord(word.id);
    const startClientX = e.clientX;
    const pxPerMs = timelineWidthPx / Math.max(1, totalDurationMs);
    const origS = word.startMs;
    const origE = word.endMs;
    let latestS = origS;
    let latestE = origE;

    function maybeSnap(ms: number): number {
      if (!snapToWaveform || !peaks || peaks.peaks.length === 0) return ms;
      return snapToNearestOnsetMs(ms, peaks.peaks, peaks.rateHz, 120);
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
    edge: "start" | "end",
  ) {
    e.preventDefault();
    e.stopPropagation();
    selectOverlay(overlay.id);
    const startClientX = e.clientX;
    const pxPerMs = timelineWidthPx / Math.max(1, totalDurationMs);
    const origS = overlay.startMs;
    const origE = overlay.endMs;
    let latestS = origS;
    let latestE = origE;

    function onMove(ev: PointerEvent) {
      const deltaMs = Math.round((ev.clientX - startClientX) / pxPerMs);
      if (edge === "start") {
        latestS = Math.max(0, Math.min(origE - 250, origS + deltaMs));
      } else {
        latestE = Math.max(origS + 250, Math.min(totalDurationMs, origE + deltaMs));
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

  function handleBladeAction() {
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
        const cutS = Math.max(coldOpenMs, playheadMs);
        const cutE = Math.min(totalDurationMs, cutS + 1500);
        bladeCut(cutS, cutE);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  const hasRange =
    inPointMs !== null && outPointMs !== null && Math.abs(outPointMs - inPointMs) >= 100;
  const rangeStart = hasRange ? Math.min(inPointMs!, outPointMs!) : 0;
  const rangeEnd = hasRange ? Math.max(inPointMs!, outPointMs!) : 0;

  const activeBgm = edl.tracks.audio.bgm;
  const activeBgmMeta = activeBgm
    ? bgmAssets.find((a) => a.id === activeBgm.assetId)
    : undefined;

  return (
    <section className="flex h-full flex-col bg-[#111114] select-none">
      {/* Studio Timeline Action Deck */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222228] bg-[#0E0E11] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setInPointMs(playheadMs)}
            title="Mark In (I)"
            className="tabular-tc rounded border border-[#222228] bg-[#141418] px-2 py-0.5 text-[10px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            IN {inPointMs !== null ? formatTimecodeMs(inPointMs) : "(I)"}
          </button>
          <button
            type="button"
            onClick={() => setOutPointMs(playheadMs)}
            title="Mark Out (O)"
            className="tabular-tc rounded border border-[#222228] bg-[#141418] px-2 py-0.5 text-[10px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            OUT {outPointMs !== null ? formatTimecodeMs(outPointMs) : "(O)"}
          </button>
          {hasRange && (
            <button
              type="button"
              onClick={clearInOut}
              className="text-[10px] text-[#71717A] hover:text-white"
            >
              Clear
            </button>
          )}

          <div className="mx-1 h-3.5 w-px bg-[#222228]" />

          <button
            type="button"
            onClick={handleBladeAction}
            title="Blade-cut marked range or 1.5s at playhead (S)"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2.5 py-0.5 text-[11px] font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60"
          >
            <Scissors className="h-3 w-3 text-[#F59E0B]" />
            {hasRange ? "Cut In–Out (S)" : "Razor Cut (S)"}
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
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2.5 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            <Waveform className="h-3.5 w-3.5 text-[#A1A1AA]" />
            Tighten Pauses
          </button>

          <button
            type="button"
            onClick={() => addWord("NEW", playheadMs, 650)}
            title="Insert caption word at playhead"
            className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white"
          >
            <Plus className="h-3 w-3 text-[#F59E0B]" />
            Word
          </button>
        </div>

        <div className="flex items-center gap-3">
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

          <div className="flex items-center gap-1.5">
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

      {/* Multi-Track Scrollable Bay */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sticky Track Headers */}
        <div className="tabular-tc flex w-[92px] shrink-0 flex-col border-r border-[#222228] bg-[#0C0C0F] text-[10px] font-medium text-[#A1A1AA]">
          <div className="flex h-6 items-center border-b border-[#222228] px-2.5 text-[9px] uppercase tracking-wider text-[#52525B]">
            TC
          </div>
          <div className="flex h-7 items-center border-b border-[#1C1C22] px-2.5">
            G1 · GFX
          </div>
          <div className="flex h-8 items-center border-b border-[#1C1C22] px-2.5">
            T1 · SUBS
          </div>
          <div className="flex h-11 items-center border-b border-[#1C1C22] px-2.5 text-[#F4F4F5]">
            V1 · VIDEO
          </div>
          <div className="flex h-10 items-center border-b border-[#1C1C22] px-2.5">
            A1 · VOICE
          </div>
          <div className="flex h-7 items-center px-2.5 text-[#A1A1AA]">
            A2 · BGM
          </div>
        </div>

        {/* Right Horizontally Scrollable Tracks + Ruler */}
        <div
          ref={tracksScrollRef}
          className="relative flex-1 overflow-x-auto overflow-y-hidden bg-[#09090B]"
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
                const startMs = overlayDrag?.id === ov.id ? overlayDrag.startMs : ov.startMs;
                const endMs = overlayDrag?.id === ov.id ? overlayDrag.endMs : ov.endMs;
                const isSelected = selectedOverlayId === ov.id;
                return (
                  <div
                    key={ov.id}
                    onClick={() => selectOverlay(ov.id)}
                    className={`group absolute inset-y-1 flex cursor-pointer items-center rounded border px-2 text-[10px] font-medium transition-colors ${
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
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l bg-[#F59E0B]/70 opacity-0 group-hover:opacity-100"
                    />
                    <span className="truncate">{ov.text || ov.kind}</span>
                    <div
                      onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "end")}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-[#F59E0B]/70 opacity-0 group-hover:opacity-100"
                    />
                  </div>
                );
              })}
            </div>

            {/* T1: Subtitle Word Time-Stops */}
            <div className="relative h-8 border-b border-[#19191F]">
              {edl.tracks.subtitles.words.map((w) => {
                const startMs = wordDrag?.id === w.id ? wordDrag.startMs : w.startMs;
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
              })}
            </div>

            {/* V1: Video Filmstrip Slices & Transition Badges */}
            <div className="relative flex h-11 items-center gap-[2px] border-b border-[#19191F] py-1">
              {coldOpenMs > 0 && (
                <div
                  className="flex h-full shrink-0 items-center justify-center truncate rounded border border-[#F59E0B]/45 bg-[#1C1810] px-1.5 text-[10px] font-semibold text-[#FDE68A]"
                  style={{ width: `${msToPx(coldOpenMs)}px` }}
                >
                  Hook {(coldOpenMs / 1000).toFixed(1)}s
                </div>
              )}

              {edl.tracks.video.clips.map((clip, idx) => {
                const dur = clip.sourceEndMs - clip.sourceStartMs;
                const displayLabel = clip.label?.trim() || `Scene ${idx + 1}`;
                const isSelectedClip = selectedClipId === clip.id;
                const hasTrans =
                  idx > 0 && clip.transitionIn && clip.transitionIn !== "none";

                return (
                  <div
                    key={clip.id}
                    onClick={() => selectClip(clip.id)}
                    style={{
                      width: `${msToPx(dur)}px`,
                      ...(filmstripUrl
                        ? {
                            backgroundImage: `linear-gradient(rgba(9,9,11,0.58), rgba(9,9,11,0.74)), url("${filmstripUrl}")`,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                          }
                        : {}),
                    }}
                    className={`relative flex h-full shrink-0 cursor-pointer items-center justify-between overflow-hidden rounded border px-2 text-[10px] transition-colors ${
                      isSelectedClip
                        ? "border-[#F59E0B] bg-[#1F1F27] text-white"
                        : "border-[#2E2E38] bg-[#16161C] text-[#E4E4E7] hover:border-[#454554]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {idx > 0 && (
                        <button
                          type="button"
                          title="Click to cycle cut transition (None → White Flash → Dip Black)"
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
                      <span className="truncate font-medium drop-shadow">{displayLabel}</span>
                    </div>
                    <span className="tabular-tc shrink-0 text-[10px] text-[#A1A1AA]">
                      {(dur / 1000).toFixed(1)}s
                    </span>
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

            {/* A1: 100Hz Dialogue Waveform */}
            <div
              onPointerDown={startRulerScrub}
              className="relative flex h-10 cursor-ew-resize items-center border-b border-[#19191F]"
            >
              <WaveformCanvas
                peaks={peaks}
                totalDurationMs={totalDurationMs}
                widthPx={timelineWidthPx}
                heightPx={36}
                coldOpenMs={coldOpenMs}
                showOnsetMarkers={snapToWaveform}
              />
            </div>

            {/* A2: Background Music & Auto-Ducking Track */}
            <div
              onClick={() => setInspectorContext("audio")}
              title="Click to configure BGM track & auto-ducking in Audio Inspector"
              className="relative flex h-7 cursor-pointer items-center px-0.5"
            >
              {activeBgm ? (
                <div className="flex h-5 w-full items-center justify-between rounded border border-[#2C2C38] bg-[#14141A] px-2.5 text-[10px] text-[#D4D4D8] hover:border-[#F59E0B]/50">
                  <span className="inline-flex items-center gap-1.5 truncate font-medium">
                    <MusicNotes className="h-3 w-3 text-[#F59E0B]" />
                    {activeBgmMeta?.name ?? activeBgm.assetId ?? "BGM Bed"}
                  </span>
                  <span className="tabular-tc text-[9px] text-[#A1A1AA]">
                    {activeBgm.gainDb.toFixed(1)} dB
                    {activeBgm.duckingEnabled ? " · SIDECHAIN DUCK" : ""}
                  </span>
                </div>
              ) : (
                <span className="px-2 text-[10px] text-[#52525B] hover:text-[#A1A1AA]">
                  + Click to attach Background Music bed...
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
