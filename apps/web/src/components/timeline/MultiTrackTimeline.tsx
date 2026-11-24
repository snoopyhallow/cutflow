import { useEffect, useMemo, useRef, useState } from "react";
import {
  Magnet,
  Plus,
  Scissors,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  formatTimecodeMs,
  getColdOpenDurationMs,
  getTotalDurationMs,
  snapToNearestOnsetMs,
  type OverlayItem,
  type SubtitleWord,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { ProjectPeaks } from "../../transport";
import { WaveformCanvas } from "./WaveformCanvas";

interface MultiTrackTimelineProps {
  peaks: ProjectPeaks | null;
  onError?: (msg: string) => void;
}

export function MultiTrackTimeline({ peaks, onError }: MultiTrackTimelineProps) {
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
    setPlayheadMs,
    setIsPlaying,
    setZoomPxPerSec,
    toggleSnapToWaveform,
    setInPointMs,
    setOutPointMs,
    clearInOut,
    selectWord,
    selectOverlay,
    setWordTiming,
    setWordText,
    addWord,
    updateOverlay,
    bladeCut,
    tightenSilence,
  } = useTimelineStore();

  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const [editingWordId, setEditingWordId] = useState<string | null>(null);
  const [editingWordDraft, setEditingWordDraft] = useState<string>("");

  // Live drag previews (committed cleanly on pointerUp -> single undo step)
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

  // Smoothly auto-scroll timeline viewport to keep playhead visible during playback
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

  return (
    <section className="flex h-full flex-col bg-[#131720] select-none">
      {/* Timeline Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222836] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setInPointMs(playheadMs)}
            title="Mark In (I)"
            className="rounded border border-[#222836] bg-[#0B0D12] px-2 py-0.5 text-[11px] font-medium text-[#CBD5E1] hover:border-[#6366F1] hover:text-white"
          >
            In {inPointMs !== null ? formatTimecodeMs(inPointMs) : "(I)"}
          </button>
          <button
            type="button"
            onClick={() => setOutPointMs(playheadMs)}
            title="Mark Out (O)"
            className="rounded border border-[#222836] bg-[#0B0D12] px-2 py-0.5 text-[11px] font-medium text-[#CBD5E1] hover:border-[#6366F1] hover:text-white"
          >
            Out {outPointMs !== null ? formatTimecodeMs(outPointMs) : "(O)"}
          </button>
          {hasRange && (
            <button
              type="button"
              onClick={clearInOut}
              className="text-[10px] text-[#64748B] hover:text-white"
            >
              Clear
            </button>
          )}

          <button
            type="button"
            onClick={handleBladeAction}
            title="Blade-cut marked range or 1.5s at playhead (S)"
            className="inline-flex items-center gap-1 rounded border border-[#8B5CF6]/45 bg-[#8B5CF6]/15 px-2.5 py-0.5 text-[11px] font-medium text-[#DDD6FE] hover:bg-[#8B5CF6]/25"
          >
            <Scissors className="h-3 w-3" />
            {hasRange ? "Cut In–Out (S)" : "Blade Cut (S)"}
          </button>

          <button
            type="button"
            onClick={() => {
              const res = tightenSilence(peaks?.rms, peaks?.rateHz ?? 100, 1100);
              if (res.cutsApplied === 0) {
                onError?.("No silent dead-air gaps (>= 1.1s) found to tighten.");
              }
            }}
            title="Auto jump-cut dead-air pauses >= 1.1s"
            className="inline-flex items-center gap-1 rounded border border-[#10B981]/45 bg-[#10B981]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#A7F3D0] hover:bg-[#10B981]/25"
          >
            <Wand2 className="h-3 w-3" />
            Tighten Silence
          </button>

          <button
            type="button"
            onClick={() => addWord("NEW", playheadMs, 650)}
            title="Insert caption word at playhead"
            className="inline-flex items-center gap-1 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] font-medium text-[#FDE68A] hover:bg-[#F59E0B]/20"
          >
            <Plus className="h-3 w-3" />
            Word
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSnapToWaveform}
            title="Magnetically snap word handles to nearest audio onset peak"
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              snapToWaveform
                ? "border-[#10B981]/50 bg-[#10B981]/15 text-[#A7F3D0]"
                : "border-[#222836] bg-[#0B0D12] text-[#64748B]"
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
              className="rounded p-0.5 text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              aria-label="Timeline zoom"
              min={20}
              max={280}
              step={10}
              value={zoomPxPerSec}
              onChange={(e) => setZoomPxPerSec(Number(e.target.value))}
              className="w-24 accent-[#6366F1]"
            />
            <button
              type="button"
              onClick={() => setZoomPxPerSec(zoomPxPerSec + 25)}
              aria-label="Zoom in"
              className="rounded p-0.5 text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Multi-Track Scrollable Container */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sticky Track Labels */}
        <div className="flex w-24 shrink-0 flex-col border-r border-[#222836] bg-[#0F131B] text-[11px] font-medium">
          <div className="flex h-6 items-center border-b border-[#222836] px-2.5 text-[10px] uppercase tracking-wider text-[#64748B]">
            Tracks
          </div>
          <div className="flex h-8 items-center border-b border-[#222836]/60 px-2.5 text-[#38BDF8]">
            Overlays
          </div>
          <div className="flex h-9 items-center border-b border-[#222836]/60 px-2.5 text-[#F59E0B]">
            Subtitles
          </div>
          <div className="flex h-9 items-center border-b border-[#222836]/60 px-2.5 text-[#8B5CF6]">
            Video
          </div>
          <div className="flex h-12 items-center px-2.5 text-[#10B981]">
            Waveform
          </div>
        </div>

        {/* Right Horizontally Scrollable Tracks + Ruler */}
        <div
          ref={tracksScrollRef}
          className="relative flex-1 overflow-x-auto overflow-y-hidden bg-[#0B0D12]"
        >
          <div className="relative" style={{ width: `${timelineWidthPx}px` }}>
            {/* Time Ruler (Scrubbable) */}
            <div
              onPointerDown={startRulerScrub}
              className="relative h-6 cursor-ew-resize border-b border-[#222836] bg-[#131720]"
            >
              {ticks.map((ms) => (
                <div
                  key={ms}
                  className="pointer-events-none absolute top-0 h-full border-l border-[#2E374A] pl-1 text-[9px] text-[#64748B] tabular-tc"
                  style={{ left: `${msToPx(ms)}px` }}
                >
                  {formatTimecodeMs(ms).slice(0, 5)}
                </div>
              ))}
            </div>

            {/* In/Out Selection Band */}
            {hasRange && (
              <div
                className="pointer-events-none absolute bottom-0 top-6 z-10 border-x border-[#F43F5E]/70 bg-[#F43F5E]/12"
                style={{
                  left: `${msToPx(rangeStart)}px`,
                  width: `${Math.max(4, msToPx(rangeEnd - rangeStart))}px`,
                }}
              />
            )}

            {/* Playhead Vertical Needle */}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-[#6366F1] shadow-[0_0_8px_rgba(99,102,241,0.9)]"
              style={{ left: `${msToPx(playheadMs)}px` }}
            >
              <div className="h-2.5 w-2.5 -translate-x-[4px] rounded-b-sm bg-[#6366F1]" />
            </div>

            {/* Track 1: Overlays (#38BDF8 Sky) */}
            <div className="relative h-8 border-b border-[#222836]/60">
              {edl.tracks.overlays.map((ov) => {
                const startMs = overlayDrag?.id === ov.id ? overlayDrag.startMs : ov.startMs;
                const endMs = overlayDrag?.id === ov.id ? overlayDrag.endMs : ov.endMs;
                const isSelected = selectedOverlayId === ov.id;
                return (
                  <div
                    key={ov.id}
                    onClick={() => selectOverlay(ov.id)}
                    className={`group absolute inset-y-1 flex cursor-pointer items-center rounded border px-2 text-[10px] font-medium ${
                      isSelected
                        ? "border-white bg-[#38BDF8]/35 text-white"
                        : "border-[#38BDF8]/55 bg-[#38BDF8]/20 text-[#E0F2FE]"
                    }`}
                    style={{
                      left: `${msToPx(startMs)}px`,
                      width: `${Math.max(24, msToPx(endMs - startMs))}px`,
                    }}
                  >
                    <div
                      onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "start")}
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l bg-[#38BDF8]/50 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                    <span className="truncate">{ov.text || ov.kind}</span>
                    <div
                      onPointerDown={(e) => startOverlayEdgeDrag(e, ov, "end")}
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r bg-[#38BDF8]/50 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </div>
                );
              })}
            </div>

            {/* Track 2: Subtitles Word Time-Stop Blocks (#F59E0B Amber) */}
            <div className="relative h-9 border-b border-[#222836]/60">
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
                    title={`${w.text} (${formatTimecodeMs(startMs)}–${formatTimecodeMs(endMs)}) · Drag edges to roll-trim, double-click to rename`}
                    className={`group absolute inset-y-1 flex cursor-grab items-center justify-center rounded border px-1 text-[10px] font-semibold active:cursor-grabbing ${
                      isSelected
                        ? "z-20 border-white bg-[#F59E0B] text-black shadow-md"
                        : "border-[#F59E0B]/60 bg-[#F59E0B]/25 text-[#FEF3C7] hover:bg-[#F59E0B]/35"
                    }`}
                    style={{
                      left: `${msToPx(startMs)}px`,
                      width: `${widthPx}px`,
                    }}
                  >
                    {/* Premiere-style Rolling Left Edge Handle */}
                    <div
                      onPointerDown={(e) => startWordEdgeDrag(e, w, "start")}
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l bg-white/70 opacity-0 transition-opacity group-hover:opacity-100"
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
                        className="w-full rounded bg-black px-1 text-[10px] text-white outline-none"
                      />
                    ) : (
                      <span className="truncate">{w.text}</span>
                    )}
                    {/* Premiere-style Rolling Right Edge Handle */}
                    <div
                      onPointerDown={(e) => startWordEdgeDrag(e, w, "end")}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-white/70 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </div>
                );
              })}
            </div>

            {/* Track 3: Video Slices & Cold-Open (#8B5CF6 Violet) */}
            <div className="relative flex h-9 items-center gap-0.5 border-b border-[#222836]/60 px-0 py-1">
              {coldOpenMs > 0 && (
                <div
                  className="flex h-full shrink-0 items-center justify-center truncate rounded border border-[#EC4899]/60 bg-[#EC4899]/25 px-1.5 text-[10px] font-semibold text-[#FCE7F3]"
                  style={{ width: `${msToPx(coldOpenMs)}px` }}
                >
                  Hook {(coldOpenMs / 1000).toFixed(1)}s
                </div>
              )}
              {edl.tracks.video.clips.map((clip) => {
                const dur = clip.sourceEndMs - clip.sourceStartMs;
                return (
                  <div
                    key={clip.id}
                    className="flex h-full shrink-0 items-center justify-between truncate rounded border border-[#8B5CF6]/55 bg-[#8B5CF6]/25 px-2 text-[10px] text-[#EDE9FE]"
                    style={{ width: `${msToPx(dur)}px` }}
                  >
                    <span className="font-medium">{clip.id}</span>
                    <span className="tabular-tc text-[#C4B5FD]">
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
                    title={`Framing keyframe: ${f.mode}`}
                    className="absolute top-0.5 z-10 cursor-pointer rounded bg-[#6366F1]/80 px-1 text-[8px] font-bold uppercase text-white"
                    style={{ left: `${msToPx(f.timelineStartMs) + 2}px` }}
                  >
                    {f.mode}
                  </div>
                ))}
            </div>

            {/* Track 4: High-DPI 100Hz Audio Waveform (#10B981 Emerald) */}
            <div
              onPointerDown={startRulerScrub}
              className="relative flex h-12 cursor-ew-resize items-center"
            >
              <WaveformCanvas
                peaks={peaks}
                totalDurationMs={totalDurationMs}
                widthPx={timelineWidthPx}
                heightPx={44}
                coldOpenMs={coldOpenMs}
                showOnsetMarkers={snapToWaveform}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
