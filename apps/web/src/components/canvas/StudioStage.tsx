import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Pause,
  Play,
  SkipBack,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  formatTimecodeMs,
  getColdOpenDurationMs,
  getTotalDurationMs,
  timelineToSource,
  type FramingSegment,
  type NormalizedBox,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";

interface StudioStageProps {
  mediaUrl: string | null;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const srcRatio = sw / Math.max(1, sh);
  const dstRatio = dw / Math.max(1, dh);
  let cx = sx;
  let cy = sy;
  let cw = sw;
  let ch = sh;
  if (srcRatio > dstRatio) {
    cw = sh * dstRatio;
    cx = sx + (sw - cw) / 2;
  } else {
    ch = sw / dstRatio;
    cy = sy + (sh - ch) / 2;
  }
  ctx.drawImage(video, cx, cy, cw, ch, dx, dy, dw, dh);
}

function drawDemoBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  framing: FramingSegment,
  playheadMs: number,
  isColdOpen: boolean,
) {
  const t = playheadMs / 1000;
  if (framing.mode === "split") {
    const seamY = Math.round(h * framing.splitRatio);
    // Top stylized facecam band
    const topGrad = ctx.createLinearGradient(0, 0, w, seamY);
    topGrad.addColorStop(0, "#1E1B4B");
    topGrad.addColorStop(1, "#0F172A");
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, w, seamY);

    // Subtle animated facecam silhouette ring
    ctx.fillStyle = "rgba(99, 102, 241, 0.22)";
    ctx.beginPath();
    ctx.arc(w * 0.5, seamY * 0.52, Math.min(w, seamY) * 0.26, 0, Math.PI * 2);
    ctx.fill();

    // Bottom stylized gameplay canvas with subtle motion grid
    const botGrad = ctx.createLinearGradient(0, seamY, 0, h);
    botGrad.addColorStop(0, "#0F172A");
    botGrad.addColorStop(1, "#020617");
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, seamY, w, h - seamY);

    ctx.strokeStyle = "rgba(56, 189, 248, 0.12)";
    ctx.lineWidth = 1;
    const shift = (t * 24) % 32;
    for (let y = seamY + shift; y < h; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  } else {
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#1E1B4B");
    bg.addColorStop(1, "#020617");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.fillStyle = "rgba(148, 163, 184, 0.65)";
  ctx.font = "600 11px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    isColdOpen ? "COLD-OPEN FLASH-FORWARD" : "LIVE 60FPS CANVAS STAGE",
    w / 2,
    h - 16,
  );
}

export function StudioStage({ mediaUrl }: StudioStageProps) {
  const {
    edl,
    playheadMs,
    isPlaying,
    playbackRate,
    selectedOverlayId,
    setPlayheadMs,
    setIsPlaying,
    togglePlayback,
    selectOverlay,
    updateFraming,
    updateOverlay,
    mutateEdl,
  } = useTimelineStore();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [editingCamCrop, setEditingCamCrop] = useState(false);

  // Live preview overrides while pointer-dragging (committed once on pointerUp -> 1 undo step!)
  const [dragSplitRatio, setDragSplitRatio] = useState<number | null>(null);
  const [dragCaptionMargin, setDragCaptionMargin] = useState<number | null>(null);
  const [dragOverlayOffset, setDragOverlayOffset] = useState<{
    id: string;
    ratio: number;
  } | null>(null);
  const [dragCamBox, setDragCamBox] = useState<NormalizedBox | null>(null);

  const totalDurationMs = useMemo(() => (edl ? getTotalDurationMs(edl) : 0), [edl]);
  const coldOpenMs = useMemo(() => (edl ? getColdOpenDurationMs(edl) : 0), [edl]);

  const framing = edl?.tracks.video.framing[0] ?? null;
  const activeSplitRatio = dragSplitRatio ?? framing?.splitRatio ?? 0.35;
  const activeCaptionMargin =
    dragCaptionMargin ?? edl?.tracks.subtitles.marginVRatio ?? 0.22;
  const activeCamBox =
    dragCamBox ?? framing?.camBox ?? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 };

  // Canvas logical aspect ratio dimensions
  const [canvasW, canvasH] = useMemo(() => {
    const ratio = edl?.output.ratio ?? "9:16";
    if (ratio === "1:1") return [480, 480];
    if (ratio === "16:9") return [640, 360];
    return [360, 640];
  }, [edl?.output.ratio]);

  // 60fps playback ticker + Single-<video> synchronization across Cold-Open & Blade Cuts
  useEffect(() => {
    if (!edl) return;
    let rafId = 0;
    let lastTs = performance.now();

    function tick(now: number) {
      const dt = Math.min(80, now - lastTs);
      lastTs = now;
      const state = useTimelineStore.getState();
      const currentEdl = state.edl;
      if (!currentEdl) return;

      let nextMs = state.playheadMs;
      const total = getTotalDurationMs(currentEdl);
      if (state.isPlaying) {
        nextMs = state.playheadMs + dt * state.playbackRate;
        if (nextMs >= total) {
          nextMs = total;
          state.setIsPlaying(false);
        } else if (nextMs < 0) {
          nextMs = 0;
          state.setIsPlaying(false);
        }
        state.setPlayheadMs(nextMs);
      }

      // Sync single hidden <video> element to timelineToSource(nextMs)
      const video = videoRef.current;
      const mapped = timelineToSource(currentEdl, nextMs);
      if (video && mediaUrl) {
        const expectedSec = Math.max(0, (mapped.sourceMs - state.sliceOriginMs) / 1000);
        if (video.readyState >= 1) {
          const drift = Math.abs(video.currentTime - expectedSec);
          if (!state.isPlaying || drift > 0.18 || state.playbackRate < 0) {
            if (drift > 0.03) {
              try {
                video.currentTime = expectedSec;
              } catch {
                // ignore seek while loading
              }
            }
          }
          if (state.isPlaying && state.playbackRate > 0) {
            video.playbackRate = Math.max(0.25, Math.min(4, state.playbackRate));
            if (video.paused) {
              void video.play().catch(() => undefined);
            }
          } else if (!video.paused) {
            video.pause();
          }
        }
      }

      // Paint 60fps composite onto <canvas>
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      const seg = currentEdl.tracks.video.framing[0];
      if (canvas && ctx && seg) {
        const liveSeg: FramingSegment = {
          ...seg,
          splitRatio: dragSplitRatio ?? seg.splitRatio,
          camBox: dragCamBox ?? seg.camBox,
        };
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (video && mediaUrl && video.readyState >= 2 && video.videoWidth > 0) {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (liveSeg.mode === "split" && liveSeg.camBox) {
            const seamY = Math.round(canvas.height * liveSeg.splitRatio);
            const cam = liveSeg.camBox;
            drawCover(
              ctx,
              video,
              cam.x * vw,
              cam.y * vh,
              cam.w * vw,
              cam.h * vh,
              0,
              0,
              canvas.width,
              seamY,
            );
            const gb = liveSeg.gameBox;
            drawCover(
              ctx,
              video,
              gb ? gb.x * vw : 0,
              gb ? gb.y * vh : 0,
              gb ? gb.w * vw : vw,
              gb ? gb.h * vh : vh,
              0,
              seamY,
              canvas.width,
              canvas.height - seamY,
            );
          } else if (liveSeg.mode === "fit") {
            ctx.save();
            ctx.filter = "blur(14px) brightness(0.65)";
            drawCover(ctx, video, 0, 0, vw, vh, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            const scale = Math.min(canvas.width / vw, canvas.height / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            ctx.drawImage(
              video,
              (canvas.width - dw) / 2,
              (canvas.height - dh) / 2,
              dw,
              dh,
            );
          } else {
            drawCover(ctx, video, 0, 0, vw, vh, 0, 0, canvas.width, canvas.height);
          }
        } else {
          drawDemoBackdrop(
            ctx,
            canvas.width,
            canvas.height,
            liveSeg,
            nextMs,
            mapped.isColdOpen,
          );
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [edl, mediaUrl, dragSplitRatio, dragCamBox]);

  const activeSubtitleWords = useMemo(() => {
    if (!edl || !edl.tracks.subtitles.enabled) return [];
    const words = edl.tracks.subtitles.words;
    const mode = edl.tracks.subtitles.style.revealMode;
    const activeIdx = words.findIndex(
      (w) => playheadMs >= w.startMs && playheadMs <= w.endMs,
    );
    if (activeIdx === -1) return [];
    if (mode === "single_word") return [words[activeIdx]];
    const chunkStart = Math.floor(activeIdx / 3) * 3;
    const chunk = words.slice(chunkStart, chunkStart + 3);
    if (mode === "progressive") {
      return chunk.filter((w) => playheadMs >= w.startMs);
    }
    return chunk;
  }, [edl, playheadMs]);

  const visibleOverlays = useMemo(
    () =>
      edl?.tracks.overlays.filter(
        (o) => o.text.trim() && playheadMs >= o.startMs && playheadMs <= o.endMs,
      ) ?? [],
    [edl, playheadMs],
  );

  if (!edl || !framing) return null;

  function startSeamDrag(e: React.PointerEvent) {
    e.preventDefault();
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    let latest = activeSplitRatio;

    function onMove(ev: PointerEvent) {
      const ratio = (ev.clientY - box!.top) / box!.height;
      latest = Math.max(0.2, Math.min(0.65, Number(ratio.toFixed(3))));
      setDragSplitRatio(latest);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragSplitRatio(null);
      updateFraming({ splitRatio: latest });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startCaptionDrag(e: React.PointerEvent) {
    e.preventDefault();
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    let latest = activeCaptionMargin;

    function onMove(ev: PointerEvent) {
      const fromBottom = (box!.bottom - ev.clientY) / box!.height;
      latest = Math.max(0.05, Math.min(0.85, Number(fromBottom.toFixed(3))));
      setDragCaptionMargin(latest);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragCaptionMargin(null);
      mutateEdl("Move caption height", (draft) => {
        draft.tracks.subtitles.marginVRatio = latest;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startOverlayDrag(
    e: React.PointerEvent,
    overlayId: string,
    anchorBaseRatio: number,
  ) {
    e.preventDefault();
    e.stopPropagation();
    selectOverlay(overlayId);
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    let latestOffset = 0;

    function onMove(ev: PointerEvent) {
      const pointerRatio = (ev.clientY - box!.top) / box!.height;
      latestOffset = Math.max(
        -0.5,
        Math.min(0.5, Number((pointerRatio - anchorBaseRatio).toFixed(3))),
      );
      setDragOverlayOffset({ id: overlayId, ratio: latestOffset });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragOverlayOffset(null);
      updateOverlay(overlayId, { yOffsetRatio: latestOffset });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startCamBoxDrag(
    e: React.PointerEvent,
    mode: "move" | "resize",
    container: HTMLDivElement,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const rect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...activeCamBox };
    let latest = { ...orig };

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      if (mode === "move") {
        latest = {
          ...orig,
          x: Number(Math.max(0, Math.min(1 - orig.w, orig.x + dx)).toFixed(4)),
          y: Number(Math.max(0, Math.min(1 - orig.h, orig.y + dy)).toFixed(4)),
        };
      } else {
        latest = {
          ...orig,
          w: Number(Math.max(0.1, Math.min(1 - orig.x, orig.w + dx)).toFixed(4)),
          h: Number(Math.max(0.1, Math.min(1 - orig.y, orig.h + dy)).toFixed(4)),
        };
      }
      setDragCamBox(latest);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragCamBox(null);
      updateFraming({ mode: "split", camBox: latest });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const aspectClass =
    edl.output.ratio === "1:1"
      ? "aspect-square"
      : edl.output.ratio === "16:9"
        ? "aspect-video"
        : "aspect-[9/16]";

  return (
    <section className="flex h-full flex-col bg-[#0B0D12]">
      {/* Hidden Single-<video> Decoder */}
      <video
        ref={videoRef}
        src={mediaUrl ?? undefined}
        muted={muted}
        playsInline
        preload="auto"
        className="hidden"
      />

      {/* Top Stage Quick-Bar */}
      <div className="flex items-center justify-between border-b border-[#222836] bg-[#131720]/70 px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-1">
          {(["split", "fit", "centre"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() =>
                updateFraming({
                  mode: m,
                  camBox:
                    m === "split" && !framing.camBox
                      ? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 }
                      : framing.camBox,
                })
              }
              className={`rounded px-2 py-0.5 font-medium capitalize transition-colors ${
                framing.mode === m
                  ? "bg-[#6366F1] text-white"
                  : "text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {coldOpenMs > 0 && (
            <button
              type="button"
              onClick={() => {
                setPlayheadMs(0);
                setIsPlaying(true);
              }}
              className="inline-flex items-center gap-1 rounded border border-[#EC4899]/40 bg-[#EC4899]/10 px-2 py-0.5 text-[10px] font-medium text-[#FBCFE8] hover:bg-[#EC4899]/20"
            >
              <Sparkles className="h-3 w-3" />
              Preview Hook
            </button>
          )}
          {framing.mode === "split" && (
            <button
              type="button"
              onClick={() => setEditingCamCrop((v) => !v)}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium ${
                editingCamCrop
                  ? "border-[#6366F1] bg-[#6366F1]/25 text-white"
                  : "border-[#222836] text-[#CBD5E1] hover:border-[#2E374A]"
              }`}
            >
              <Camera className="h-3 w-3" />
              {editingCamCrop ? "Done Cam Crop" : "Edit Cam Crop"}
            </button>
          )}
        </div>
      </div>

      {/* Center Direct-Manipulation Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <div
          ref={stageBoxRef}
          className={`relative ${aspectClass} h-full max-h-[420px] select-none overflow-hidden rounded-xl border border-[#222836] bg-black shadow-2xl`}
        >
          <canvas
            ref={canvasRef}
            width={canvasW}
            height={canvasH}
            className="h-full w-full block"
          />

          {/* Draggable Split-Seam Line */}
          {framing.mode === "split" && (
            <div
              onPointerDown={startSeamDrag}
              title="Drag split seam ratio"
              className="group absolute inset-x-0 z-10 h-3 -translate-y-1/2 cursor-ns-resize"
              style={{ top: `${activeSplitRatio * 100}%` }}
            >
              <div className="mx-auto mt-1 h-0.5 w-full bg-[#6366F1]/50 transition-colors group-hover:bg-[#6366F1]" />
            </div>
          )}

          {/* Direct-Manipulation Overlay Cards */}
          {visibleOverlays.map((ov) => {
            const anchorBase =
              ov.yAnchor === "split_seam"
                ? activeSplitRatio
                : ov.yAnchor === "top"
                  ? 0.11
                  : 0.85;
            const liveOffset =
              dragOverlayOffset?.id === ov.id
                ? dragOverlayOffset.ratio
                : ov.yOffsetRatio;
            const topPct = Math.max(6, Math.min(92, (anchorBase + liveOffset) * 100));
            const isSelected = selectedOverlayId === ov.id;
            const cardTone =
              ov.kind === "seam_card_white"
                ? "bg-white text-[#0F172A] shadow-lg"
                : ov.kind === "cta_pill"
                  ? "bg-[#6366F1] text-white shadow-lg"
                  : "bg-[#0B0D12]/90 text-white border border-[#6366F1]/70";
            return (
              <div
                key={ov.id}
                onPointerDown={(e) => startOverlayDrag(e, ov.id, anchorBase)}
                title="Drag vertically to reposition overlay"
                className={`absolute inset-x-3 z-20 -translate-y-1/2 cursor-grab rounded-lg px-3 py-1.5 text-center text-[11px] font-extrabold leading-tight active:cursor-grabbing ${cardTone} ${
                  isSelected ? "ring-2 ring-[#38BDF8]" : ""
                }`}
                style={{ top: `${topPct}%` }}
              >
                {ov.text}
              </div>
            );
          })}

          {/* Direct-Manipulation Live Progressive Captions */}
          {activeSubtitleWords.length > 0 && (
            <div
              onPointerDown={startCaptionDrag}
              title="Drag vertically to adjust caption height"
              className="absolute inset-x-2 z-20 cursor-ns-resize text-center"
              style={{ bottom: `${activeCaptionMargin * 100}%` }}
            >
              <span className="inline-flex flex-wrap justify-center gap-1 rounded bg-black/50 px-2 py-0.5 text-sm font-black uppercase tracking-tight">
                {activeSubtitleWords.map((w) => {
                  const isCurrent =
                    playheadMs >= w.startMs && playheadMs <= w.endMs;
                  return (
                    <span
                      key={w.id}
                      style={{
                        color: isCurrent
                          ? edl.tracks.subtitles.style.accentColor
                          : edl.tracks.subtitles.style.primaryColor,
                      }}
                    >
                      {w.text}
                    </span>
                  );
                })}
              </span>
            </div>
          )}

          {/* Cold-Open Badge */}
          {playheadMs < coldOpenMs && (
            <span className="pointer-events-none absolute left-2 top-2 z-30 rounded bg-[#EC4899] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
              Cold Open
            </span>
          )}
        </div>

        {/* Interactive 16:9 Source Cam-Crop Box Modal */}
        {editingCamCrop && (
          <div className="absolute inset-4 z-40 flex items-center justify-center rounded-xl border border-[#6366F1]/50 bg-[#0B0D12]/95 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">
                  Drag &amp; Resize Facecam Crop Region
                </span>
                <span className="tabular-tc text-[11px] text-[#94A3B8]">
                  x:{(activeCamBox.x * 100).toFixed(0)}% y:{(activeCamBox.y * 100).toFixed(0)}% ·{" "}
                  {(activeCamBox.w * 100).toFixed(0)}×{(activeCamBox.h * 100).toFixed(0)}%
                </span>
              </div>
              <div
                className="relative aspect-video w-full overflow-hidden rounded-lg border border-[#2E374A] bg-gradient-to-br from-[#1E293B] to-[#0F172A]"
                ref={(el) => {
                  if (!el) return;
                  el.dataset.camCropHost = "1";
                }}
              >
                <div
                  onPointerDown={(e) => {
                    const host = e.currentTarget.parentElement as HTMLDivElement;
                    startCamBoxDrag(e, "move", host);
                  }}
                  className="absolute cursor-move rounded border-2 border-[#6366F1] bg-[#6366F1]/25 shadow-lg"
                  style={{
                    left: `${activeCamBox.x * 100}%`,
                    top: `${activeCamBox.y * 100}%`,
                    width: `${activeCamBox.w * 100}%`,
                    height: `${activeCamBox.h * 100}%`,
                  }}
                >
                  <span className="pointer-events-none absolute left-1 top-0.5 text-[9px] font-bold uppercase text-white">
                    CAM
                  </span>
                  <div
                    onPointerDown={(e) => {
                      const host =
                        e.currentTarget.parentElement!.parentElement as HTMLDivElement;
                      startCamBoxDrag(e, "resize", host);
                    }}
                    className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-white bg-[#6366F1]"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Stage Transport Controls */}
      <div className="flex items-center justify-between border-t border-[#222836] bg-[#131720] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPlayheadMs(0)}
            title="Jump to start"
            className="rounded p-1 text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={togglePlayback}
            title="Play / Pause (Space)"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[#6366F1] text-white hover:bg-[#5558E6]"
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5 translate-x-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            title={muted ? "Unmute" : "Mute"}
            className="rounded p-1 text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5 text-[#F43F5E]" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="tabular-tc text-[11px] font-medium text-[#CBD5E1]">
          <span className="text-[#6366F1]">{formatTimecodeMs(playheadMs)}</span>
          <span className="mx-1 text-[#64748B]">/</span>
          <span>{formatTimecodeMs(totalDurationMs)}</span>
        </div>

        <div className="tabular-tc text-[10px] text-[#64748B]">
          {playbackRate !== 1 ? `${playbackRate}x · ` : ""}
          Space · J/K/L · I/O · S
        </div>
      </div>
    </section>
  );
}
