import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  MusicNotes,
  Pause,
  Play,
  SkipBack,
  SpeakerHigh,
  SpeakerSlash,
} from "@phosphor-icons/react";
import {
  formatTimecodeMs,
  getActiveFramingAt,
  getColdOpenDurationMs,
  getTotalDurationMs,
  timelineToSource,
  type FramingSegment,
  type NormalizedBox,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { ProjectPeaks } from "../../transport";

interface StudioStageProps {
  mediaUrl: string | null;
  bgmUrl: string | null;
  peaks: ProjectPeaks | null;
}

const DEFAULT_NEON_PALETTE = [
  "#4F7CFF",
  "#4ADE80",
  "#FBBF24",
  "#F472B6",
  "#F87171",
];

function drawPanZoomCover(
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
  panX = 0.5,
  panY = 0.5,
  zoom = 1.0,
) {
  const safeZoom = Math.max(1.0, Math.min(2.5, zoom));
  const srcRatio = sw / Math.max(1, sh);
  const dstRatio = dw / Math.max(1, dh);
  let baseW = sw;
  let baseH = sh;
  if (srcRatio > dstRatio) {
    baseW = sh * dstRatio;
  } else {
    baseH = sw / dstRatio;
  }
  const cw = baseW / safeZoom;
  const ch = baseH / safeZoom;
  const slackX = Math.max(0, sw - cw);
  const slackY = Math.max(0, sh - ch);
  const cx = sx + slackX * Math.max(0, Math.min(1, panX));
  const cy = sy + slackY * Math.max(0, Math.min(1, panY));
  ctx.drawImage(video, cx, cy, cw, ch, dx, dy, dw, dh);
}

function drawCarbonDemoBackdrop(
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
    const topGrad = ctx.createLinearGradient(0, 0, w, seamY);
    topGrad.addColorStop(0, "#18181D");
    topGrad.addColorStop(1, "#0E0E12");
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, w, seamY);

    ctx.strokeStyle = "rgba(245, 158, 11, 0.22)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(w * 0.5, seamY * 0.52, Math.min(w, seamY) * 0.24, 0, Math.PI * 2);
    ctx.stroke();

    const botGrad = ctx.createLinearGradient(0, seamY, 0, h);
    botGrad.addColorStop(0, "#111116");
    botGrad.addColorStop(1, "#070709");
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, seamY, w, h - seamY);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    const shift = (t * 22) % 28;
    for (let y = seamY + shift; y < h; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  } else {
    const bg = ctx.createRadialGradient(
      w * (framing.panX ?? 0.5),
      h * (framing.panY ?? 0.45),
      w * 0.06,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.75,
    );
    bg.addColorStop(0, "#202028");
    bg.addColorStop(0.55, "#111116");
    bg.addColorStop(1, "#070709");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Subtle cinema framing reticle
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.48, Math.min(w, h) * 0.28, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(161, 161, 170, 0.5)";
  ctx.font = "500 10px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(
    isColdOpen ? "COLD OPEN · PREVIEW STAGE" : "60FPS STUDIO STAGE",
    w / 2,
    h - 16,
  );
}

export function StudioStage({ mediaUrl, bgmUrl, peaks }: StudioStageProps) {
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
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const duckGainRef = useRef<number>(1.0);
  const [muted, setMuted] = useState(false);
  const [editingCamCrop, setEditingCamCrop] = useState(false);

  // Live preview overrides while pointer-dragging (single undo commit on pointerUp)
  const [dragSplitRatio, setDragSplitRatio] = useState<number | null>(null);
  const [dragCaptionMargin, setDragCaptionMargin] = useState<number | null>(null);
  const [dragPan, setDragPan] = useState<{ panX: number; panY: number } | null>(null);
  const [dragOverlayPos, setDragOverlayPos] = useState<{
    id: string;
    xRatio: number;
    yRatio: number;
  } | null>(null);
  const [dragCamBox, setDragCamBox] = useState<NormalizedBox | null>(null);

  const totalDurationMs = useMemo(() => (edl ? getTotalDurationMs(edl) : 0), [edl]);
  const coldOpenMs = useMemo(() => (edl ? getColdOpenDurationMs(edl) : 0), [edl]);

  const cutBoundaries = useMemo(() => {
    if (!edl) return [];
    const list: {
      cutMs: number;
      kind: "flash_white" | "dip_black" | "dissolve";
      durationMs: number;
    }[] = [];
    let cursor = getColdOpenDurationMs(edl);
    edl.tracks.video.clips.forEach((clip, idx) => {
      const dur = clip.sourceEndMs - clip.sourceStartMs;
      const isFirstOverall = idx === 0 && cursor === 0;
      if (
        !isFirstOverall &&
        clip.transitionIn &&
        clip.transitionIn !== "none"
      ) {
        list.push({
          cutMs: cursor,
          kind: clip.transitionIn,
          durationMs: clip.transitionDurationMs ?? 240,
        });
      }
      cursor += dur;
    });
    return list;
  }, [edl]);

  const framing = useMemo(
    () => (edl ? getActiveFramingAt(edl, playheadMs) : null),
    [edl, playheadMs],
  );
  const activeSplitRatio = dragSplitRatio ?? framing?.splitRatio ?? 0.35;
  const activeCaptionMargin =
    dragCaptionMargin ?? edl?.tracks.subtitles.marginVRatio ?? 0.22;
  const activeCamBox =
    dragCamBox ?? framing?.camBox ?? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 };

  const [canvasW, canvasH] = useMemo(() => {
    const ratio = edl?.output.ratio ?? "9:16";
    if (ratio === "1:1") return [480, 480];
    if (ratio === "4:5") return [432, 540];
    if (ratio === "16:9") return [640, 360];
    return [360, 640];
  }, [edl?.output.ratio]);

  // 60fps playback ticker + Single-<video> + Live Auto-Ducked BGM <audio>
  useEffect(() => {
    if (!edl) return;
    const bgmNode = bgmAudioRef.current;
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

      // 1. Sync hidden <video>
      const video = videoRef.current;
      const mapped = timelineToSource(currentEdl, nextMs);
      if (video && mediaUrl) {
        video.muted = muted || Boolean(currentEdl.tracks.audio.muteOriginal);
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

      // 2. Sync hidden <audio> BGM bed + live RMS sidechain auto-ducking
      const bgmEl = bgmAudioRef.current;
      const bgmCfg = currentEdl.tracks.audio.bgm;
      if (bgmEl && bgmUrl && bgmCfg && !muted) {
        const rawSec = ((bgmCfg.startOffsetMs ?? 0) + nextMs) / 1000;
        const dur = Number.isFinite(bgmEl.duration) && bgmEl.duration > 0.2 ? bgmEl.duration : 0;
        const targetBgmSec = dur > 0 ? rawSec % dur : rawSec;
        if (bgmEl.readyState >= 1) {
          const bDrift = Math.abs(bgmEl.currentTime - targetBgmSec);
          if (!state.isPlaying || bDrift > 0.28) {
            if (bDrift > 0.08) {
              try {
                bgmEl.currentTime = targetBgmSec;
              } catch {
                // ignore seek
              }
            }
          }
          // Compute live gain + fade-in/out + smooth dialogue ducking
          const baseLinear = Math.pow(10, (bgmCfg.gainDb ?? -16) / 20);
          const fadeInS = (bgmCfg.fadeInMs ?? 500) / 1000;
          const fadeOutS = (bgmCfg.fadeOutMs ?? 1000) / 1000;
          const curS = nextMs / 1000;
          const totS = Math.max(0.2, total / 1000);
          let env = 1.0;
          if (fadeInS > 0 && curS < fadeInS) env *= curS / fadeInS;
          if (fadeOutS > 0 && totS - curS < fadeOutS) {
            env *= Math.max(0, (totS - curS) / fadeOutS);
          }

          let targetDuck = 1.0;
          if (bgmCfg.duckingEnabled && !currentEdl.tracks.audio.muteOriginal && peaks?.rms?.length) {
            const idx = Math.min(
              peaks.rms.length - 1,
              Math.max(0, Math.floor((nextMs / 1000) * peaks.rateHz)),
            );
            const speechRms = peaks.rms[idx] ?? 0;
            targetDuck = speechRms > 0.14 ? 0.34 : 1.0;
          }
          // Smooth attack (fast) and release (gentle Cinema swell)
          const alpha = targetDuck < duckGainRef.current ? 0.25 : 0.06;
          duckGainRef.current += (targetDuck - duckGainRef.current) * alpha;
          bgmEl.volume = Math.max(0, Math.min(1, baseLinear * env * duckGainRef.current * 2.2));

          if (state.isPlaying && state.playbackRate > 0) {
            bgmEl.playbackRate = Math.max(0.5, Math.min(2, state.playbackRate));
            if (bgmEl.paused) {
              void bgmEl.play().catch(() => undefined);
            }
          } else if (!bgmEl.paused) {
            bgmEl.pause();
          }
        }
      } else if (bgmEl && !bgmEl.paused) {
        bgmEl.pause();
      }

      // 3. Paint 60fps composite onto <canvas>
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      const seg = getActiveFramingAt(currentEdl, nextMs);
      if (canvas && ctx && seg) {
        const liveSeg: FramingSegment = {
          ...seg,
          splitRatio: dragSplitRatio ?? seg.splitRatio,
          camBox: dragCamBox ?? seg.camBox,
          panX: dragPan?.panX ?? seg.panX ?? 0.5,
          panY: dragPan?.panY ?? seg.panY ?? 0.5,
        };
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (video && mediaUrl && video.readyState >= 2 && video.videoWidth > 0) {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const sc = liveSeg.sourceCropBox;
          const sx0 = sc ? sc.x * vw : 0;
          const sy0 = sc ? sc.y * vh : 0;
          const sw0 = sc ? sc.w * vw : vw;
          const sh0 = sc ? sc.h * vh : vh;

          ctx.save();
          if (currentEdl.output.cinemaGrade === "crisp_hd") {
            ctx.filter = "contrast(1.06) saturate(1.08)";
          }

          if (liveSeg.mode === "split" && liveSeg.camBox) {
            const seamY = Math.round(canvas.height * liveSeg.splitRatio);
            const cam = liveSeg.camBox;
            drawPanZoomCover(
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
            drawPanZoomCover(
              ctx,
              video,
              gb ? gb.x * vw : sx0,
              gb ? gb.y * vh : sy0,
              gb ? gb.w * vw : sw0,
              gb ? gb.h * vh : sh0,
              0,
              seamY,
              canvas.width,
              canvas.height - seamY,
            );
          } else if (liveSeg.mode === "fit") {
            if (liveSeg.fitBackdrop === "black") {
              ctx.fillStyle = "#000000";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
            } else {
              ctx.save();
              ctx.filter = "blur(16px) brightness(0.62)";
              drawPanZoomCover(ctx, video, sx0, sy0, sw0, sh0, 0, 0, canvas.width, canvas.height);
              ctx.restore();
            }
            const scale = Math.min(canvas.width / sw0, canvas.height / sh0);
            const dw = sw0 * scale;
            const dh = sh0 * scale;
            ctx.drawImage(
              video,
              sx0,
              sy0,
              sw0,
              sh0,
              (canvas.width - dw) / 2,
              (canvas.height - dh) / 2,
              dw,
              dh,
            );
          } else {
            drawPanZoomCover(
              ctx,
              video,
              sx0,
              sy0,
              sw0,
              sh0,
              0,
              0,
              canvas.width,
              canvas.height,
              liveSeg.panX ?? 0.5,
              liveSeg.panY ?? 0.5,
              liveSeg.zoom ?? 1.0,
            );
          }
          ctx.restore();
        } else {
          drawCarbonDemoBackdrop(
            ctx,
            canvas.width,
            canvas.height,
            liveSeg,
            nextMs,
            mapped.isColdOpen,
          );
        }

        // Paint zero-drift flash_white / dip_black transition overlays across slice cuts
        for (const cb of cutBoundaries) {
          const half = cb.durationMs * 0.5;
          const dist = Math.abs(nextMs - cb.cutMs);
          if (dist <= half) {
            const alpha = Math.max(0, Math.min(1, 1 - dist / Math.max(1, half)));
            ctx.fillStyle =
              cb.kind === "flash_white"
                ? `rgba(255, 255, 255, ${(alpha * 0.92).toFixed(3)})`
                : `rgba(0, 0, 0, ${(alpha * 0.94).toFixed(3)})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      if (bgmNode && !bgmNode.paused) bgmNode.pause();
    };
  }, [edl, mediaUrl, bgmUrl, muted, peaks, cutBoundaries, dragSplitRatio, dragCamBox, dragPan]);

  const subtitleRenderGroup = useMemo(() => {
    if (!edl || !edl.tracks.subtitles.enabled) return { words: [], chunkIdx: 0 };
    const words = edl.tracks.subtitles.words;
    const mode = edl.tracks.subtitles.style.revealMode;
    const activeIdx = words.findIndex(
      (w) => playheadMs >= w.startMs && playheadMs <= w.endMs,
    );
    if (activeIdx === -1) return { words: [], chunkIdx: 0 };
    if (mode === "single_word") {
      return { words: [words[activeIdx]], chunkIdx: activeIdx };
    }
    const maxPerGroup = edl.tracks.subtitles.style.preset === "cinema_neon_glow" ? 4 : 3;
    const chunkIdx = Math.floor(activeIdx / maxPerGroup);
    const chunkStart = chunkIdx * maxPerGroup;
    const chunk = words.slice(chunkStart, chunkStart + maxPerGroup);
    if (mode === "progressive") {
      return { words: chunk.filter((w) => playheadMs >= w.startMs), chunkIdx };
    }
    return { words: chunk, chunkIdx };
  }, [edl, playheadMs]);

  const visibleOverlays = useMemo(
    () =>
      edl?.tracks.overlays.filter(
        (o) => o.text.trim() && playheadMs >= o.startMs && playheadMs <= o.endMs,
      ) ?? [],
    [edl, playheadMs],
  );

  if (!edl || !framing) return null;

  function startCanvasPanDrag(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!framing || (framing.mode !== "crop" && framing.mode !== "centre")) return;
    e.preventDefault();
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = framing.panX ?? 0.5;
    const origY = framing.panY ?? 0.5;
    let latestX = origX;
    let latestY = origY;
    let moved = false;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / Math.max(1, box!.width);
      const dy = (ev.clientY - startY) / Math.max(1, box!.height);
      if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) moved = true;
      latestX = Math.max(0, Math.min(1, Number((origX - dx).toFixed(3))));
      latestY = Math.max(0, Math.min(1, Number((origY - dy).toFixed(3))));
      setDragPan({ panX: latestX, panY: latestY });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragPan(null);
      if (moved) {
        updateFraming({ panX: latestX, panY: latestY });
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

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

  function startOverlay2DDrag(
    e: React.PointerEvent,
    overlayId: string,
    anchorBaseRatio: number,
    origXRatio: number,
    allowHorizontal: boolean,
  ) {
    e.preventDefault();
    e.stopPropagation();
    selectOverlay(overlayId);
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    const startX = e.clientX;
    let latestX = origXRatio;
    let latestY = 0;

    function onMove(ev: PointerEvent) {
      const pointerYRatio = (ev.clientY - box!.top) / box!.height;
      latestY = Math.max(
        -0.5,
        Math.min(0.5, Number((pointerYRatio - anchorBaseRatio).toFixed(3))),
      );
      if (allowHorizontal) {
        const dx = (ev.clientX - startX) / box!.width;
        latestX = Math.max(-0.45, Math.min(0.45, Number((origXRatio + dx).toFixed(3))));
      }
      setDragOverlayPos({ id: overlayId, xRatio: latestX, yRatio: latestY });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragOverlayPos(null);
      updateOverlay(overlayId, {
        yOffsetRatio: latestY,
        ...(allowHorizontal ? { xOffsetRatio: latestX } : {}),
      });
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
      : edl.output.ratio === "4:5"
        ? "aspect-[4/5]"
        : edl.output.ratio === "16:9"
          ? "aspect-video"
          : "aspect-[9/16]";

  const subStyle = edl.tracks.subtitles.style;
  const palette =
    subStyle.colorPalette && subStyle.colorPalette.length > 0
      ? subStyle.colorPalette
      : DEFAULT_NEON_PALETTE;
  const activeNeonHex = palette[subtitleRenderGroup.chunkIdx % palette.length];
  const borderStyle = edl.output.borderStyle ?? "none";

  return (
    <section className="flex h-full flex-col bg-[#09090B]">
      {/* Hidden Single-<video> & Synced Auto-Ducked BGM <audio> */}
      <video
        ref={videoRef}
        src={mediaUrl ?? undefined}
        muted={muted}
        playsInline
        preload="auto"
        className="hidden"
      />
      <audio
        ref={bgmAudioRef}
        src={bgmUrl ?? undefined}
        loop
        preload="auto"
        className="hidden"
      />

      {/* Top Stage Bar */}
      <div className="flex items-center justify-between border-b border-[#222228] bg-[#111114] px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-1">
          {(["split", "fit", "crop"] as const).map((m) => {
            const active =
              framing.mode === m || (m === "crop" && framing.mode === "centre");
            return (
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
                  active
                    ? "bg-[#22222A] text-[#F4F4F5] ring-1 ring-[#383844]"
                    : "text-[#A1A1AA] hover:bg-[#18181C] hover:text-[#F4F4F5]"
                }`}
              >
                {m}
              </button>
            );
          })}

          <div className="mx-1.5 h-3.5 w-px bg-[#222228]" />

          {(["9:16", "4:5", "1:1", "16:9"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() =>
                mutateEdl(`Ratio → ${r}`, (d) => {
                  d.output.ratio = r;
                })
              }
              className={`tabular-tc rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                edl.output.ratio === r
                  ? "bg-[#F59E0B]/15 text-[#FBBF24] ring-1 ring-[#F59E0B]/40"
                  : "text-[#71717A] hover:text-[#D4D4D8]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {edl.tracks.audio.bgm && (
            <span
              title="Auto-ducked BGM bed active"
              className="inline-flex items-center gap-1 rounded border border-[#27272F] bg-[#16161B] px-1.5 py-0.5 text-[10px] text-[#A1A1AA]"
            >
              <MusicNotes className="h-3 w-3 text-[#F59E0B]" />
              BGM
            </span>
          )}
          {coldOpenMs > 0 && (
            <button
              type="button"
              onClick={() => {
                setPlayheadMs(0);
                setIsPlaying(true);
              }}
              className="rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[10px] font-medium text-[#D4D4D8] hover:border-[#F59E0B]/50 hover:text-white"
            >
              Preview Hook
            </button>
          )}
          {framing.mode === "split" && (
            <button
              type="button"
              onClick={() => setEditingCamCrop((v) => !v)}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium ${
                editingCamCrop
                  ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                  : "border-[#222228] text-[#A1A1AA] hover:border-[#32323B] hover:text-white"
              }`}
            >
              <Camera className="h-3 w-3" />
              {editingCamCrop ? "Done Cam" : "Cam Crop"}
            </button>
          )}
        </div>
      </div>

      {/* Center Direct-Manipulation Stage */}
      <div className="studio-stage-grid relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <div
          ref={stageBoxRef}
          className={`relative ${aspectClass} h-full max-h-[430px] select-none overflow-hidden rounded-lg border border-[#27272F] bg-black shadow-[0_18px_48px_rgba(0,0,0,0.75)]`}
        >
          <canvas
            ref={canvasRef}
            width={canvasW}
            height={canvasH}
            onPointerDown={startCanvasPanDrag}
            title={
              framing.mode === "crop" || framing.mode === "centre"
                ? "Drag directly on frame to pan speaker focus"
                : undefined
            }
            className={`block h-full w-full ${
              framing.mode === "crop" || framing.mode === "centre"
                ? "cursor-grab active:cursor-grabbing"
                : ""
            }`}
          />

          {/* Inner Rounded Cinema Border Overlay (JJ_EDIT style) */}
          {borderStyle !== "none" && (
            <div className="pointer-events-none absolute inset-[2.2%] z-10 rounded-2xl border border-white/55">
              {borderStyle === "thin_rounded" && (
                <div className="absolute -top-[2px] left-1/2 h-[3px] w-[15%] -translate-x-1/2 rounded-full bg-white/95" />
              )}
              {borderStyle === "double_cinema" && (
                <div className="absolute inset-[4px] rounded-[12px] border border-white/30" />
              )}
            </div>
          )}

          {/* Draggable Split-Seam Line */}
          {framing.mode === "split" && (
            <div
              onPointerDown={startSeamDrag}
              title="Drag split seam ratio"
              className="group absolute inset-x-0 z-10 h-3 -translate-y-1/2 cursor-ns-resize"
              style={{ top: `${activeSplitRatio * 100}%` }}
            >
              <div className="mx-auto mt-1 h-0.5 w-full bg-[#F59E0B]/50 transition-colors group-hover:bg-[#F59E0B]" />
            </div>
          )}

          {/* Direct-Manipulation Overlays (POV Bar, Seam Card, 2D Watermark, Credits, CTA) */}
          {visibleOverlays.map((ov) => {
            const isSelected = selectedOverlayId === ov.id;
            const liveYOffset =
              dragOverlayPos?.id === ov.id ? dragOverlayPos.yRatio : ov.yOffsetRatio;
            const liveXOffset =
              dragOverlayPos?.id === ov.id ? dragOverlayPos.xRatio : (ov.xOffsetRatio ?? 0);
            const opacityVal = ov.opacity ?? 1;

            if (ov.kind === "pov_top_bar") {
              return (
                <div
                  key={ov.id}
                  onPointerDown={(e) =>
                    startOverlay2DDrag(e, ov.id, 0, 0, false)
                  }
                  style={{
                    top: `${Math.max(0, Math.min(35, liveYOffset * 100))}%`,
                    opacity: opacityVal,
                  }}
                  className={`font-caption-stage absolute inset-x-0 z-20 cursor-ns-resize border-b border-zinc-300 bg-white px-3 py-2 text-center text-[11px] font-extrabold uppercase tracking-[0.04em] text-[#09090B] shadow-md ${
                    isSelected ? "ring-2 ring-[#F59E0B]" : ""
                  }`}
                >
                  {ov.text}
                </div>
              );
            }

            const anchorBase =
              ov.yAnchor === "split_seam"
                ? activeSplitRatio
                : ov.yAnchor === "top"
                  ? 0.11
                  : 0.85;
            const topPct = Math.max(5, Math.min(94, (anchorBase + liveYOffset) * 100));
            const leftPct = Math.max(8, Math.min(92, (0.5 + liveXOffset) * 100));

            if (ov.kind === "watermark_tag") {
              return (
                <div
                  key={ov.id}
                  onPointerDown={(e) =>
                    startOverlay2DDrag(e, ov.id, anchorBase, ov.xOffsetRatio ?? 0, true)
                  }
                  title="Drag 2D anywhere on frame to position watermark"
                  style={{
                    top: `${topPct}%`,
                    left: `${leftPct}%`,
                    opacity: opacityVal,
                    textShadow: "0 2px 8px rgba(0,0,0,0.85)",
                  }}
                  className={`font-caption-stage absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-move px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.26em] whitespace-nowrap text-white ${
                    isSelected ? "rounded ring-1 ring-[#F59E0B]" : ""
                  }`}
                >
                  {ov.text}
                </div>
              );
            }

            const cardTone =
              ov.kind === "seam_card_white"
                ? "bg-white text-[#09090B] shadow-lg rounded-md px-3 py-1.5 font-extrabold"
                : ov.kind === "cta_pill"
                  ? "bg-[#F59E0B] text-[#09090B] shadow-lg rounded-full px-3 py-1 font-bold"
                  : ov.kind === "cinema_credit"
                    ? "bg-[#09090B]/85 text-[#F4F4F5] border border-white/25 rounded-full px-3 py-1 text-[10px] font-semibold tracking-wider uppercase"
                    : "bg-[#09090B]/90 text-[#F4F4F5] border border-white/20 rounded-md px-3 py-1.5 font-bold";

            const displayTxt =
              ov.kind === "cinema_credit" && !ov.text.includes("·")
                ? `FILM · ${ov.text}`
                : ov.text;

            return (
              <div
                key={ov.id}
                onPointerDown={(e) =>
                  startOverlay2DDrag(e, ov.id, anchorBase, ov.xOffsetRatio ?? 0, true)
                }
                title="Drag to position overlay"
                style={{
                  top: `${topPct}%`,
                  left: `${leftPct}%`,
                  opacity: opacityVal,
                }}
                className={`absolute z-20 max-w-[88%] -translate-x-1/2 -translate-y-1/2 cursor-grab text-center text-[11px] leading-tight active:cursor-grabbing ${cardTone} ${
                  isSelected ? "ring-2 ring-[#F59E0B]" : ""
                }`}
              >
                {displayTxt}
              </div>
            );
          })}

          {/* Direct-Manipulation Captions (Standard, Karaoke, Cinema Neon Glow & Viral Punch Glow) */}
          {subtitleRenderGroup.words.length > 0 && (
            <div
              onPointerDown={startCaptionDrag}
              title="Drag vertically to adjust caption height"
              className="absolute inset-x-3 z-20 cursor-ns-resize text-center"
              style={{ bottom: `${activeCaptionMargin * 100}%` }}
            >
              <span
                className={`font-caption-stage inline-flex flex-wrap justify-center gap-1.5 px-2 py-0.5 text-sm font-black ${
                  subStyle.preset === "boxed"
                    ? "rounded bg-black/75"
                    : ""
                } ${
                  subStyle.preset === "clean_lower" ? "" : "uppercase"
                }`}
                style={{
                  letterSpacing:
                    subStyle.preset === "cinema_neon_glow"
                      ? `${Math.max(0.12, (subStyle.letterSpacing ?? 3.5) * 0.045)}em`
                      : "-0.01em",
                }}
              >
                {subtitleRenderGroup.words.map((w) => {
                  const isCurrent =
                    playheadMs >= w.startMs && playheadMs <= w.endMs;
                  const preset = subStyle.preset;

                  if (preset === "cinema_neon_glow") {
                    const glow = w.glowColor || activeNeonHex;
                    return (
                      <span
                        key={w.id}
                        style={{
                          color: isCurrent ? subStyle.primaryColor : glow,
                          textShadow: `0 0 10px ${glow}, 0 0 22px ${glow}, 0 2px 6px rgba(0,0,0,0.92)`,
                        }}
                      >
                        {w.text}
                      </span>
                    );
                  }

                  if (preset === "viral_punch_glow") {
                    const punch = w.glowColor;
                    return (
                      <span
                        key={w.id}
                        style={{
                          color: punch || subStyle.primaryColor,
                          textShadow: punch
                            ? `0 0 12px ${punch}, 0 0 24px ${punch}, 0 2px 5px rgba(0,0,0,0.95)`
                            : "0 2px 6px rgba(0,0,0,0.92)",
                        }}
                      >
                        {w.text}
                      </span>
                    );
                  }

                  if (preset === "karaoke_fill") {
                    const pct =
                      playheadMs >= w.endMs
                        ? 100
                        : playheadMs <= w.startMs
                          ? 0
                          : Math.round(
                              ((playheadMs - w.startMs) /
                                Math.max(1, w.endMs - w.startMs)) *
                                100,
                            );
                    return (
                      <span
                        key={w.id}
                        style={{
                          backgroundImage: `linear-gradient(90deg, ${subStyle.accentColor} ${pct}%, ${subStyle.primaryColor} ${pct}%)`,
                          WebkitBackgroundClip: "text",
                          backgroundClip: "text",
                          color: "transparent",
                          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.85))",
                        }}
                      >
                        {w.text}
                      </span>
                    );
                  }

                  return (
                    <span
                      key={w.id}
                      style={{
                        color: isCurrent ? subStyle.accentColor : subStyle.primaryColor,
                        textShadow: "0 2px 6px rgba(0,0,0,0.92)",
                      }}
                    >
                      {w.text}
                    </span>
                  );
                })}
              </span>
            </div>
          )}

          {/* Cold-Open Indicator */}
          {playheadMs < coldOpenMs && (
            <span className="tabular-tc pointer-events-none absolute left-2.5 top-2.5 z-30 rounded border border-[#F59E0B]/50 bg-[#09090B]/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#FBBF24]">
              Cold Open
            </span>
          )}
        </div>

        {/* Interactive 16:9 Source Cam-Crop Box Modal */}
        {editingCamCrop && (
          <div className="absolute inset-4 z-40 flex items-center justify-center rounded-lg border border-[#32323B] bg-[#09090B]/95 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#F4F4F5]">
                  Position Facecam Region
                </span>
                <span className="tabular-tc text-[11px] text-[#A1A1AA]">
                  x:{(activeCamBox.x * 100).toFixed(0)}% y:{(activeCamBox.y * 100).toFixed(0)}% ·{" "}
                  {(activeCamBox.w * 100).toFixed(0)}×{(activeCamBox.h * 100).toFixed(0)}%
                </span>
              </div>
              <div
                className="studio-stage-grid relative aspect-video w-full overflow-hidden rounded-md border border-[#2C2C35]"
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
                  className="absolute cursor-move rounded border-2 border-[#F59E0B] bg-[#F59E0B]/20 shadow-lg"
                  style={{
                    left: `${activeCamBox.x * 100}%`,
                    top: `${activeCamBox.y * 100}%`,
                    width: `${activeCamBox.w * 100}%`,
                    height: `${activeCamBox.h * 100}%`,
                  }}
                >
                  <span className="tabular-tc pointer-events-none absolute left-1 top-0.5 text-[9px] font-bold uppercase text-[#F4F4F5]">
                    CAM
                  </span>
                  <div
                    onPointerDown={(e) => {
                      const host =
                        e.currentTarget.parentElement!.parentElement as HTMLDivElement;
                      startCamBoxDrag(e, "resize", host);
                    }}
                    className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-xs border border-[#09090B] bg-[#F59E0B]"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Stage Transport Deck */}
      <div className="flex items-center justify-between border-t border-[#222228] bg-[#111114] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPlayheadMs(0)}
            title="Return to 00:00.00"
            className="rounded p-1 text-[#A1A1AA] hover:bg-[#1C1C22] hover:text-[#F4F4F5]"
          >
            <SkipBack weight="fill" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={togglePlayback}
            title="Play / Pause (Space)"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-[#F59E0B] text-[#09090B] transition-colors hover:bg-[#FBBF24]"
          >
            {isPlaying ? (
              <Pause weight="fill" className="h-3.5 w-3.5" />
            ) : (
              <Play weight="fill" className="h-3.5 w-3.5 translate-x-[1px]" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            title={muted ? "Unmute Stage" : "Mute Stage"}
            className="rounded p-1 text-[#A1A1AA] hover:bg-[#1C1C22] hover:text-[#F4F4F5]"
          >
            {muted ? (
              <SpeakerSlash className="h-3.5 w-3.5 text-[#EF4444]" />
            ) : (
              <SpeakerHigh className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="tabular-tc text-[11px] font-medium text-[#D4D4D8]">
          <span className="text-[#F59E0B]">{formatTimecodeMs(playheadMs)}</span>
          <span className="mx-1 text-[#52525B]">/</span>
          <span>{formatTimecodeMs(totalDurationMs)}</span>
        </div>

        <div className="tabular-tc text-[10px] text-[#71717A]">
          {playbackRate !== 1 ? `${playbackRate}x · ` : ""}
          SPACE · J/K/L · I/O · S
        </div>
      </div>
    </section>
  );
}
