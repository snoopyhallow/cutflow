import type {
  FramingSegment,
  OverlayItem,
  SubtitleWord,
  TimelineProject,
  VideoSlice,
} from "./schema";

export const MIN_WORD_MS = 60;
export const MIN_SLICE_MS = 100;

let idCounter = 1;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function cloneEdl(edl: TimelineProject): TimelineProject {
  return structuredClone(edl);
}

export function getColdOpenDurationMs(edl: TimelineProject): number {
  const co = edl.tracks.video.coldOpen;
  return co && co.enabled ? co.durationMs : 0;
}

interface ClipSpan {
  tStart: number;
  tEnd: number;
  clip: VideoSlice;
}

function buildSpans(edl: TimelineProject): {
  coldOpenMs: number;
  spans: ClipSpan[];
  totalDurationMs: number;
} {
  const coldOpenMs = getColdOpenDurationMs(edl);
  const spans: ClipSpan[] = [];
  let cursor = coldOpenMs;
  for (const clip of edl.tracks.video.clips) {
    const end = cursor + (clip.sourceEndMs - clip.sourceStartMs);
    spans.push({ tStart: cursor, tEnd: end, clip });
    cursor = end;
  }
  return { coldOpenMs, spans, totalDurationMs: cursor };
}

export function getTotalDurationMs(edl: TimelineProject): number {
  return buildSpans(edl).totalDurationMs;
}

export function timelineToSource(
  edl: TimelineProject,
  timelineMs: number,
): { isColdOpen: boolean; sourceMs: number } {
  const { coldOpenMs, spans, totalDurationMs } = buildSpans(edl);
  const t = Math.max(0, Math.min(totalDurationMs, Math.round(timelineMs)));
  const co = edl.tracks.video.coldOpen;
  if (co && co.enabled && t < coldOpenMs) {
    return { isColdOpen: true, sourceMs: co.sourceStartMs + t };
  }
  for (const span of spans) {
    if (t >= span.tStart && t <= span.tEnd) {
      return {
        isColdOpen: false,
        sourceMs: span.clip.sourceStartMs + (t - span.tStart),
      };
    }
  }
  const last = spans[spans.length - 1];
  return { isColdOpen: false, sourceMs: last.clip.sourceEndMs };
}

export function sourceToTimeline(
  edl: TimelineProject,
  sourceMs: number,
): number | null {
  const { spans } = buildSpans(edl);
  for (const span of spans) {
    if (sourceMs >= span.clip.sourceStartMs && sourceMs <= span.clip.sourceEndMs) {
      return span.tStart + (sourceMs - span.clip.sourceStartMs);
    }
  }
  return null;
}

function shiftInterval(
  startMs: number,
  endMs: number,
  cutStartMs: number,
  cutEndMs: number,
): [number, number] | null {
  const removed = cutEndMs - cutStartMs;
  if (endMs <= cutStartMs) {
    return [startMs, endMs];
  }
  if (startMs >= cutEndMs) {
    return [startMs - removed, endMs - removed];
  }
  if (startMs >= cutStartMs && endMs <= cutEndMs) {
    return null;
  }
  const newStart = Math.min(startMs, cutStartMs);
  const newEnd = endMs > cutEndMs ? endMs - removed : cutStartMs;
  return newEnd > newStart ? [newStart, newEnd] : null;
}

/**
 * Pure non-destructive blade cut: deletes `[cutStartMs, cutEndMs]` from the main
 * video body and ripples framing segments, subtitle words, mute ranges, and overlays.
 * Mirrors Python `cutflow.edl.ops.apply_blade_cut` deterministically.
 */
export function applyBladeCut(
  edl: TimelineProject,
  cutStartMs: number,
  cutEndMs: number,
): TimelineProject {
  const { coldOpenMs: bodyStart, totalDurationMs } = buildSpans(edl);
  const cStart = Math.max(bodyStart, Math.round(cutStartMs));
  const cEnd = Math.min(totalDurationMs, Math.round(cutEndMs));

  if (cEnd - cStart < MIN_SLICE_MS) {
    throw new Error("Blade cut must remove at least 100ms inside the main clip body.");
  }
  if (totalDurationMs - bodyStart - (cEnd - cStart) < MIN_SLICE_MS) {
    throw new Error("Cannot delete the entire clip; at least 100ms must remain.");
  }

  const next = cloneEdl(edl);
  const newClips: VideoSlice[] = [];
  let cursor = bodyStart;

  for (const clip of next.tracks.video.clips) {
    const sT0 = cursor;
    const sT1 = cursor + (clip.sourceEndMs - clip.sourceStartMs);
    cursor = sT1;

    if (sT1 <= cStart || sT0 >= cEnd) {
      newClips.push(clip);
      continue;
    }

    if (sT0 < cStart) {
      const leftDur = cStart - sT0;
      if (leftDur >= MIN_SLICE_MS) {
        newClips.push({
          id: clip.id,
          sourceStartMs: clip.sourceStartMs,
          sourceEndMs: clip.sourceStartMs + leftDur,
        });
      }
    }

    if (sT1 > cEnd) {
      const rightOffset = cEnd - sT0;
      const rightDur = sT1 - cEnd;
      if (rightDur >= MIN_SLICE_MS) {
        newClips.push({
          id: nextId(clip.id),
          sourceStartMs: clip.sourceStartMs + rightOffset,
          sourceEndMs: clip.sourceEndMs,
        });
      }
    }
  }

  if (newClips.length === 0) {
    throw new Error("Blade cut produced zero remaining video slices.");
  }

  next.tracks.video.clips = newClips;
  const newTotal = getTotalDurationMs(next);

  // Ripple framing segments
  const newFraming: FramingSegment[] = [];
  for (const seg of next.tracks.video.framing) {
    const shifted = shiftInterval(seg.timelineStartMs, seg.timelineEndMs, cStart, cEnd);
    if (shifted) {
      newFraming.push({
        ...seg,
        timelineStartMs: shifted[0],
        timelineEndMs: shifted[1],
      });
    }
  }
  if (newFraming.length > 0) {
    newFraming[0].timelineStartMs = 0;
    newFraming[newFraming.length - 1].timelineEndMs = newTotal;
    for (let i = 0; i < newFraming.length - 1; i += 1) {
      newFraming[i].timelineEndMs = newFraming[i + 1].timelineStartMs;
    }
    next.tracks.video.framing = newFraming.filter(
      (f) => f.timelineEndMs > f.timelineStartMs,
    );
  }

  // Ripple subtitle words
  const newWords: SubtitleWord[] = [];
  for (const word of next.tracks.subtitles.words) {
    const shifted = shiftInterval(word.startMs, word.endMs, cStart, cEnd);
    if (shifted && shifted[1] - shifted[0] >= MIN_WORD_MS) {
      newWords.push({
        ...word,
        startMs: shifted[0],
        endMs: shifted[1],
      });
    }
  }
  next.tracks.subtitles.words = newWords;

  // Ripple mute ranges
  const newMutes: [number, number][] = [];
  for (const [mStart, mEnd] of next.tracks.subtitles.muteRanges) {
    const shifted = shiftInterval(mStart, mEnd, cStart, cEnd);
    if (shifted) {
      newMutes.push(shifted);
    }
  }
  next.tracks.subtitles.muteRanges = newMutes;

  // Ripple overlays
  const newOverlays: OverlayItem[] = [];
  for (const ov of next.tracks.overlays) {
    const shifted = shiftInterval(ov.startMs, ov.endMs, cStart, cEnd);
    if (shifted) {
      newOverlays.push({
        ...ov,
        startMs: shifted[0],
        endMs: Math.min(newTotal, shifted[1]),
      });
    }
  }
  next.tracks.overlays = newOverlays;

  return next;
}

/**
 * Adjust a word's start/end time stops with optional Premiere-style rolling edit
 * on adjacent words so neighbouring captions never overlap.
 */
export function updateWordTiming(
  edl: TimelineProject,
  wordId: string,
  startMs: number,
  endMs: number,
  rollingAdjacent = true,
): TimelineProject {
  const next = cloneEdl(edl);
  const words = next.tracks.subtitles.words;
  const idx = words.findIndex((w) => w.id === wordId);
  if (idx === -1) {
    throw new Error(`Word '${wordId}' not found.`);
  }

  const totalMs = getTotalDurationMs(next);
  let newStart = Math.max(0, Math.min(totalMs - MIN_WORD_MS, Math.round(startMs)));
  let newEnd = Math.max(newStart + MIN_WORD_MS, Math.min(totalMs, Math.round(endMs)));

  if (idx > 0) {
    const prev = words[idx - 1];
    if (newStart < prev.endMs) {
      if (rollingAdjacent && newStart >= prev.startMs + MIN_WORD_MS) {
        prev.endMs = newStart;
      } else {
        newStart = prev.endMs;
        newEnd = Math.max(newStart + MIN_WORD_MS, newEnd);
      }
    }
  }

  if (idx + 1 < words.length) {
    const nxt = words[idx + 1];
    if (newEnd > nxt.startMs) {
      if (rollingAdjacent && newEnd <= nxt.endMs - MIN_WORD_MS) {
        nxt.startMs = newEnd;
      } else {
        newEnd = Math.max(newStart + MIN_WORD_MS, nxt.startMs);
      }
    }
  }

  words[idx].startMs = newStart;
  words[idx].endMs = newEnd;
  return next;
}

export function insertWord(
  edl: TimelineProject,
  text: string,
  startMs: number,
  durationMs = 800,
  speaker: string | null = null,
): TimelineProject {
  const cleaned = text.trim();
  if (!cleaned) {
    throw new Error("Word text cannot be empty.");
  }

  const next = cloneEdl(edl);
  const totalMs = getTotalDurationMs(next);
  const s = Math.max(0, Math.min(Math.max(0, totalMs - MIN_WORD_MS), Math.round(startMs)));
  const e = Math.min(
    totalMs,
    Math.max(s + MIN_WORD_MS, s + Math.max(MIN_WORD_MS, Math.round(durationMs))),
  );

  const word: SubtitleWord = {
    id: nextId("w"),
    text: cleaned,
    startMs: s,
    endMs: e,
    speaker,
  };

  const words = [...next.tracks.subtitles.words, word].sort((a, b) =>
    a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
  );

  for (let i = 1; i < words.length; i += 1) {
    if (words[i].startMs < words[i - 1].endMs) {
      if (words[i].startMs > words[i - 1].startMs + MIN_WORD_MS) {
        words[i - 1].endMs = words[i].startMs;
      } else {
        words[i].startMs = words[i - 1].endMs;
        words[i].endMs = Math.max(words[i].startMs + MIN_WORD_MS, words[i].endMs);
      }
    }
  }

  next.tracks.subtitles.words = words;
  return next;
}

export function deleteWord(edl: TimelineProject, wordId: string): TimelineProject {
  const next = cloneEdl(edl);
  const before = next.tracks.subtitles.words.length;
  next.tracks.subtitles.words = next.tracks.subtitles.words.filter((w) => w.id !== wordId);
  if (next.tracks.subtitles.words.length === before) {
    throw new Error(`Word '${wordId}' not found.`);
  }
  return next;
}

export function formatTimecodeMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centis = Math.floor((clamped % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/**
 * Snap a dragged timestamp onto the nearest rising audio-onset peak in 100Hz peaks
 * within `toleranceMs`, helping editors align word time stops magnetically.
 */
export function snapToNearestOnsetMs(
  targetMs: number,
  peaks: number[],
  rateHz: number,
  toleranceMs = 120,
): number {
  if (peaks.length < 4 || rateHz <= 0) return Math.round(targetMs);
  const centerIdx = Math.round((targetMs / 1000) * rateHz);
  const radius = Math.max(1, Math.round((toleranceMs / 1000) * rateHz));
  const startIdx = Math.max(1, centerIdx - radius);
  const endIdx = Math.min(peaks.length - 1, centerIdx + radius);

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const rise = peaks[i] - peaks[i - 1];
    if (rise > 0.14 && peaks[i] > 0.25) {
      const distPenalty = 1 - Math.abs(i - centerIdx) / (radius + 1);
      const score = rise * (0.6 + 0.4 * distPenalty);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
  }
  if (bestIdx === -1) return Math.round(targetMs);
  return Math.round((bestIdx / rateHz) * 1000);
}

export function getActiveFramingAt(
  edl: TimelineProject,
  timelineMs: number,
): FramingSegment {
  const segs = edl.tracks.video.framing;
  const t = Math.max(0, Math.round(timelineMs));
  return (
    segs.find((s) => t >= s.timelineStartMs && t < s.timelineEndMs) ??
    segs[segs.length - 1] ??
    segs[0]
  );
}

export function splitFramingSegment(
  edl: TimelineProject,
  splitAtMs: number,
  rightMode?: FramingSegment["mode"],
): TimelineProject {
  const t = Math.round(splitAtMs);
  const next = cloneEdl(edl);
  const out: FramingSegment[] = [];
  let didSplit = false;

  for (const seg of next.tracks.video.framing) {
    if (
      !didSplit &&
      t >= seg.timelineStartMs + MIN_SLICE_MS &&
      t <= seg.timelineEndMs - MIN_SLICE_MS
    ) {
      const nextMode = rightMode ?? seg.mode;
      out.push({ ...seg, timelineEndMs: t });
      out.push({
        ...seg,
        id: nextId(seg.id),
        timelineStartMs: t,
        mode: nextMode,
        camBox:
          seg.camBox ??
          (nextMode === "split" ? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 } : null),
      });
      didSplit = true;
    } else {
      out.push(seg);
    }
  }

  if (!didSplit) {
    throw new Error("Move playhead at least 100ms inside a framing segment to split.");
  }
  next.tracks.video.framing = out;
  return next;
}

/**
 * Automatically jump-cut silent dead-air pauses >= `minGapMs` inside the main clip body
 * (preserving Cold-Open and leaving `padMs` natural breath padding around speech).
 */
export function autoTightenSilence(
  edl: TimelineProject,
  opts?: {
    rms100hz?: number[];
    rateHz?: number;
    minGapMs?: number;
    padMs?: number;
    rmsThreshold?: number;
  },
): { edl: TimelineProject; cutsApplied: number; savedMs: number } {
  const rms = opts?.rms100hz;
  const rateHz = opts?.rateHz ?? 100;
  const minGapMs = opts?.minGapMs ?? 1100;
  const padMs = opts?.padMs ?? 160;
  const rmsThreshold = opts?.rmsThreshold ?? 0.09;

  const bodyStart = getColdOpenDurationMs(edl);
  const totalMs = getTotalDurationMs(edl);
  if (totalMs - bodyStart < minGapMs + 400) {
    return { edl: cloneEdl(edl), cutsApplied: 0, savedMs: 0 };
  }

  const occupied: [number, number][] = [];
  const bodyWords = edl.tracks.subtitles.words
    .filter((w) => w.endMs > bodyStart)
    .sort((a, b) => a.startMs - b.startMs);

  if (bodyWords.length > 0) {
    for (const w of bodyWords) {
      const s = Math.max(bodyStart, w.startMs - padMs);
      const e = Math.min(totalMs, w.endMs + padMs);
      if (occupied.length > 0 && s <= occupied[occupied.length - 1][1]) {
        occupied[occupied.length - 1][1] = Math.max(occupied[occupied.length - 1][1], e);
      } else {
        occupied.push([s, e]);
      }
    }
  } else if (rms && rms.length > 0 && rateHz > 0) {
    const stepMs = 1000 / rateHz;
    let inSpeech = false;
    let segS = bodyStart;
    for (let i = 0; i < rms.length; i += 1) {
      const tMs = bodyStart + Math.round(i * stepMs);
      if (tMs > totalMs) break;
      if (rms[i] >= rmsThreshold && !inSpeech) {
        inSpeech = true;
        segS = Math.max(bodyStart, tMs - padMs);
      } else if (rms[i] < rmsThreshold && inSpeech) {
        inSpeech = false;
        const segE = Math.min(totalMs, tMs + padMs);
        if (occupied.length > 0 && segS <= occupied[occupied.length - 1][1]) {
          occupied[occupied.length - 1][1] = Math.max(occupied[occupied.length - 1][1], segE);
        } else {
          occupied.push([segS, segE]);
        }
      }
    }
    if (inSpeech) occupied.push([segS, totalMs]);
  }

  if (occupied.length === 0) {
    return { edl: cloneEdl(edl), cutsApplied: 0, savedMs: 0 };
  }

  const gaps: [number, number][] = [];
  let cursor = bodyStart;
  for (const [occS, occE] of occupied) {
    if (occS - cursor >= minGapMs) {
      let isQuiet = true;
      if (rms && rms.length > 0 && rateHz > 0) {
        const i0 = Math.max(0, Math.floor(((cursor - bodyStart) / 1000) * rateHz));
        const i1 = Math.min(rms.length, Math.floor(((occS - bodyStart) / 1000) * rateHz));
        if (i1 > i0) {
          let sum = 0;
          for (let k = i0; k < i1; k += 1) sum += rms[k];
          isQuiet = sum / (i1 - i0) < rmsThreshold * 1.6;
        }
      }
      if (isQuiet) gaps.push([cursor, occS]);
    }
    cursor = Math.max(cursor, occE);
  }
  if (totalMs - cursor >= minGapMs) {
    gaps.push([cursor, totalMs]);
  }

  let current = cloneEdl(edl);
  let cutsApplied = 0;
  let savedMs = 0;
  for (let i = gaps.length - 1; i >= 0; i -= 1) {
    const [gStart, gEnd] = gaps[i];
    const rem = getTotalDurationMs(current) - bodyStart;
    if (rem - (gEnd - gStart) < 1200) continue;
    current = applyBladeCut(current, gStart, gEnd);
    cutsApplied += 1;
    savedMs += gEnd - gStart;
  }

  return { edl: current, cutsApplied, savedMs };
}

