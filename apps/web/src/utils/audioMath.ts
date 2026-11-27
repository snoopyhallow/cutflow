export function dbToLinearGain(db: number): number {
  if (db <= -59.5) return 0;
  return Math.pow(10, db / 20);
}

export function formatDbLabel(db: number): string {
  if (db <= -59.5) return "-∞ dB";
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}
