export function dbToLinearGain(db: number): number {
  if (db <= -59.5) return 0;
  return Math.pow(10, db / 20);
}

export function formatDbLabel(db: number): string {
  if (db <= -59.5) return "-∞ dB";
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function computeMediaSliceSeekSec(opts: {
  sourceStartMs: number;
  elapsedTimelineMs: number;
  speed?: number;
  clipSourceId?: string | null;
  assetId?: string | null;
  projectSourceId?: string;
  hasProjectMediaUrl: boolean;
  sliceOriginMs: number;
}): number {
  const spd = Math.max(0.25, opts.speed ?? 1);
  const usesProjectSlice =
    !opts.assetId &&
    Boolean(opts.clipSourceId) &&
    opts.clipSourceId === opts.projectSourceId &&
    opts.hasProjectMediaUrl;
  const originMs = usesProjectSlice ? opts.sliceOriginMs : 0;
  return Math.max(
    0,
    (opts.sourceStartMs - originMs + opts.elapsedTimelineMs * spd) / 1000,
  );
}
