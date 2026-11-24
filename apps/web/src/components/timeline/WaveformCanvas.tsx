import { useEffect, useRef } from "react";
import type { ProjectPeaks } from "../../transport";

interface WaveformCanvasProps {
  peaks: ProjectPeaks | null;
  totalDurationMs: number;
  widthPx: number;
  heightPx?: number;
  coldOpenMs?: number;
  showOnsetMarkers?: boolean;
}

export function WaveformCanvas({
  peaks,
  totalDurationMs,
  widthPx,
  heightPx = 44,
  coldOpenMs = 0,
  showOnsetMarkers = true,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(100, Math.round(widthPx));
    const h = heightPx;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Subtle baseline
    const midY = h / 2;
    ctx.strokeStyle = "rgba(16, 185, 129, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (!peaks || peaks.peaks.length === 0 || totalDurationMs <= 0) {
      return;
    }

    const barStep = 2;
    const nBars = Math.floor(w / barStep);
    const totalSamples = peaks.peaks.length;
    const samplesPerMs = peaks.rateHz / 1000;

    for (let b = 0; b < nBars; b += 1) {
      const x = b * barStep;
      const tMs = (x / w) * totalDurationMs;
      // Offset waveform body cleanly if cold open precedes main peaks
      const sampleTimeMs = Math.max(0, tMs - (peaks.durationMs < totalDurationMs - 200 ? coldOpenMs : 0));
      const idx = Math.min(totalSamples - 1, Math.max(0, Math.floor(sampleTimeMs * samplesPerMs)));
      const peakVal = peaks.peaks[idx] ?? 0;
      const rmsVal = peaks.rms[idx] ?? peakVal * 0.7;

      const peakH = Math.max(1.5, peakVal * (h * 0.46));
      const rmsH = Math.max(1, rmsVal * (h * 0.44));

      // Outer peak bar (Emerald)
      ctx.fillStyle = "rgba(16, 185, 129, 0.42)";
      ctx.fillRect(x, midY - peakH, 1.5, peakH * 2);

      // Inner dense RMS bar
      ctx.fillStyle = peakVal > 0.5 ? "rgba(52, 211, 153, 0.92)" : "rgba(16, 185, 129, 0.72)";
      ctx.fillRect(x, midY - rmsH, 1.5, rmsH * 2);

      // Highlight sharp voice onsets when Snap-to-Waveform is active
      if (showOnsetMarkers && idx > 0) {
        const rise = peakVal - (peaks.peaks[idx - 1] ?? 0);
        if (rise > 0.22 && peakVal > 0.32) {
          ctx.fillStyle = "rgba(245, 158, 11, 0.55)";
          ctx.fillRect(x, 1, 1, 5);
        }
      }
    }
  }, [peaks, totalDurationMs, widthPx, heightPx, coldOpenMs, showOnsetMarkers]);

  return (
    <canvas
      ref={canvasRef}
      className="block select-none"
      aria-label="100Hz Audio Waveform"
    />
  );
}
