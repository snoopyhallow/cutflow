import type {
  AudioClipItem,
  BRollClip,
  FramingSegment,
  NormalizedBox,
  OverlayItem,
  SubtitleWord,
  TimelineProject,
  VideoSlice,
} from "./schema";

export const MIN_WORD_MS = 60;
export const MIN_SLICE_MS = 100;

let idCounter = 1;

export function nextEdlId(prefix: string): string {
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

export function getClipTimelineDurationMs(clip: VideoSlice): number {
  if (clip.freezeDurationMs && clip.freezeDurationMs > 0) {
    return clip.freezeDurationMs;
  }
  const raw = clip.sourceEndMs - clip.sourceStartMs;
  const spd = Math.max(0.25, clip.speed ?? 1);
  return Math.max(60, Math.round(raw / spd));
}

export function getBRollDurationMs(clip: BRollClip): number {
  const raw = clip.sourceEndMs - clip.sourceStartMs;
  const spd = Math.max(0.25, clip.speed ?? 1);
  return Math.max(60, Math.round(raw / spd));
}

export function getAudioClipDurationMs(clip: AudioClipItem): number {
  const raw = clip.sourceEndMs - clip.sourceStartMs;
  const spd = Math.max(0.25, clip.speed ?? 1);
  return Math.max(60, Math.round(raw / spd));
}

export interface ClipSpan {
  tStart: number;
  tEnd: number;
  clip: VideoSlice;
}

export function buildClipSpans(edl: TimelineProject): {
  coldOpenMs: number;
  spans: ClipSpan[];
  totalDurationMs: number;
} {
  const coldOpenMs = getColdOpenDurationMs(edl);
  const spans: ClipSpan[] = [];
  let cursor = coldOpenMs;
  for (const clip of edl.tracks.video.clips) {
    const tStart =
      clip.timelineStartMs !== undefined && clip.timelineStartMs !== null
        ? Math.max(cursor, Math.round(clip.timelineStartMs))
        : cursor;
    const tEnd = tStart + getClipTimelineDurationMs(clip);
    spans.push({ tStart, tEnd, clip });
    cursor = tEnd;
  }
  return { coldOpenMs, spans, totalDurationMs: cursor };
}

export function getTotalDurationMs(edl: TimelineProject): number {
  return buildClipSpans(edl).totalDurationMs;
}

export interface ResolvedTimelinePoint {
  isColdOpen: boolean;
  isGap: boolean;
  sourceMs: number;
  clip: VideoSlice | null;
  clipElapsedMs: number;
  clipDurationMs: number;
}

export function resolveTimelinePoint(
  edl: TimelineProject,
  timelineMs: number,
): ResolvedTimelinePoint {
  const { coldOpenMs, spans, totalDurationMs } = buildClipSpans(edl);
  const t = Math.max(0, Math.min(totalDurationMs, Math.round(timelineMs)));
  const co = edl.tracks.video.coldOpen;
  if (co && co.enabled && t < coldOpenMs) {
    return {
      isColdOpen: true,
      isGap: false,
      sourceMs: co.sourceStartMs + t,
      clip: null,
      clipElapsedMs: t,
      clipDurationMs: coldOpenMs,
    };
  }
  for (const span of spans) {
    if (t < span.tStart) {
      return {
        isColdOpen: false,
        isGap: true,
        sourceMs: span.clip.sourceStartMs,
        clip: span.clip,
        clipElapsedMs: 0,
        clipDurationMs: span.tEnd - span.tStart,
      };
    }
    if (t >= span.tStart && t <= span.tEnd) {
      const elapsed = t - span.tStart;
      const dur = span.tEnd - span.tStart;
      if (span.clip.freezeDurationMs && span.clip.freezeDurationMs > 0) {
        return {
          isColdOpen: false,
          isGap: false,
          sourceMs: span.clip.sourceStartMs,
          clip: span.clip,
          clipElapsedMs: elapsed,
          clipDurationMs: dur,
        };
      }
      const spd = Math.max(0.25, span.clip.speed ?? 1);
      const relSrc = Math.round(elapsed * spd);
      const srcMs = span.clip.reverse
        ? Math.max(span.clip.sourceStartMs, span.clip.sourceEndMs - relSrc)
        : Math.min(span.clip.sourceEndMs, span.clip.sourceStartMs + relSrc);
      return {
        isColdOpen: false,
        isGap: false,
        sourceMs: srcMs,
        clip: span.clip,
        clipElapsedMs: elapsed,
        clipDurationMs: dur,
      };
    }
  }
  const last = spans[spans.length - 1];
  const lastDur = last.tEnd - last.tStart;
  return {
    isColdOpen: false,
    isGap: false,
    sourceMs: last.clip.reverse ? last.clip.sourceStartMs : last.clip.sourceEndMs,
    clip: last.clip,
    clipElapsedMs: lastDur,
    clipDurationMs: lastDur,
  };
}

export function timelineToSource(
  edl: TimelineProject,
  timelineMs: number,
): { isColdOpen: boolean; sourceMs: number } {
  const pt = resolveTimelinePoint(edl, timelineMs);
  return { isColdOpen: pt.isColdOpen, sourceMs: pt.sourceMs };
}

export function sourceToTimeline(
  edl: TimelineProject,
  sourceMs: number,
): number | null {
  const { spans } = buildClipSpans(edl);
  for (const span of spans) {
    if (sourceMs >= span.clip.sourceStartMs && sourceMs <= span.clip.sourceEndMs) {
      if (span.clip.freezeDurationMs && span.clip.freezeDurationMs > 0) {
        return span.tStart;
      }
      const spd = Math.max(0.25, span.clip.speed ?? 1);
      const offset = span.clip.reverse
        ? span.clip.sourceEndMs - sourceMs
        : sourceMs - span.clip.sourceStartMs;
      return span.tStart + Math.round(offset / spd);
    }
  }
  return null;
}

export function syncFramingToDuration(edl: TimelineProject): void {
  const newTotal = Math.max(MIN_SLICE_MS, getTotalDurationMs(edl));
  let segs = edl.tracks.video.framing.filter(
    (f) => f.timelineEndMs > f.timelineStartMs,
  );
  if (segs.length === 0) {
    segs = [
      {
        id: "f_default",
        timelineStartMs: 0,
        timelineEndMs: newTotal,
        mode: "fit",
        splitRatio: 0.35,
        camBox: null,
        gameBox: null,
      },
    ];
  }
  segs[0].timelineStartMs = 0;
  const kept: FramingSegment[] = [];
  for (const seg of segs) {
    if (seg.timelineStartMs >= newTotal) break;
    seg.timelineEndMs = Math.min(
      newTotal,
      Math.max(seg.timelineStartMs + 1, seg.timelineEndMs),
    );
    kept.push(seg);
  }
  if (kept.length === 0) {
    kept.push({ ...segs[0], timelineStartMs: 0, timelineEndMs: newTotal });
  }
  kept[kept.length - 1].timelineEndMs = newTotal;
  for (let i = 0; i < kept.length - 1; i += 1) {
    kept[i].timelineEndMs = kept[i + 1].timelineStartMs;
  }
  edl.tracks.video.framing = kept.filter((f) => f.timelineEndMs > f.timelineStartMs);
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
 * video body and ripples framing segments, subtitle words, mute ranges, overlays, B-roll, & audio clips.
 * Mirrors Python `cutflow.edl.ops.apply_blade_cut` deterministically.
 */
export function applyBladeCut(
  edl: TimelineProject,
  cutStartMs: number,
  cutEndMs: number,
): TimelineProject {
  const { coldOpenMs: bodyStart, spans, totalDurationMs } = buildClipSpans(edl);
  const cStart = Math.max(bodyStart, Math.round(cutStartMs));
  const cEnd = Math.min(totalDurationMs, Math.round(cutEndMs));
  const removed = cEnd - cStart;

  if (removed < MIN_SLICE_MS) {
    throw new Error("Blade cut must remove at least 100ms inside the main clip body.");
  }
  if (totalDurationMs - bodyStart - removed < MIN_SLICE_MS) {
    throw new Error("Cannot delete the entire clip; at least 100ms must remain.");
  }

  const next = cloneEdl(edl);
  const newClips: VideoSlice[] = [];

  for (let i = 0; i < next.tracks.video.clips.length; i += 1) {
    const clip = next.tracks.video.clips[i];
    const { tStart: sT0, tEnd: sT1 } = spans[i];

    if (sT1 <= cStart) {
      newClips.push(clip);
      continue;
    }
    if (sT0 >= cEnd) {
      newClips.push(
        clip.timelineStartMs !== undefined && clip.timelineStartMs !== null
          ? { ...clip, timelineStartMs: Math.max(0, clip.timelineStartMs - removed) }
          : clip,
      );
      continue;
    }

    const spd = Math.max(0.25, clip.speed ?? 1);
    if (sT0 < cStart) {
      const leftTlDur = cStart - sT0;
      if (leftTlDur >= MIN_SLICE_MS) {
        if (clip.freezeDurationMs && clip.freezeDurationMs > 0) {
          newClips.push({ ...clip, freezeDurationMs: leftTlDur });
        } else {
          const srcDelta = Math.max(MIN_SLICE_MS, Math.round(leftTlDur * spd));
          if (clip.reverse) {
            const newS0 = Math.max(clip.sourceStartMs, clip.sourceEndMs - srcDelta);
            if (clip.sourceEndMs > newS0) {
              newClips.push({ ...clip, sourceStartMs: newS0 });
            }
          } else {
            const newE0 = Math.min(clip.sourceEndMs, clip.sourceStartMs + srcDelta);
            if (newE0 > clip.sourceStartMs) {
              newClips.push({ ...clip, sourceEndMs: newE0 });
            }
          }
        }
      }
    }

    if (sT1 > cEnd) {
      const rightTlOffset = cEnd - sT0;
      const rightTlDur = sT1 - cEnd;
      if (rightTlDur >= MIN_SLICE_MS) {
        const rightTlStart =
          sT0 >= cStart && clip.timelineStartMs !== undefined && clip.timelineStartMs !== null
            ? cStart
            : null;
        if (clip.freezeDurationMs && clip.freezeDurationMs > 0) {
          newClips.push({
            ...clip,
            id: nextEdlId(clip.id),
            freezeDurationMs: rightTlDur,
            timelineStartMs: rightTlStart,
            transitionIn: "none",
            transitionSfx: "none",
          });
        } else {
          const srcOffset = Math.round(rightTlOffset * spd);
          if (clip.reverse) {
            const newE1 = Math.max(
              clip.sourceStartMs + MIN_SLICE_MS,
              clip.sourceEndMs - srcOffset,
            );
            if (newE1 > clip.sourceStartMs) {
              newClips.push({
                ...clip,
                id: nextEdlId(clip.id),
                sourceEndMs: newE1,
                timelineStartMs: rightTlStart,
                transitionIn: "none",
                transitionSfx: "none",
              });
            }
          } else {
            const newS1 = Math.min(
              clip.sourceEndMs - MIN_SLICE_MS,
              clip.sourceStartMs + srcOffset,
            );
            if (clip.sourceEndMs > newS1) {
              newClips.push({
                ...clip,
                id: nextEdlId(clip.id),
                sourceStartMs: newS1,
                timelineStartMs: rightTlStart,
                transitionIn: "none",
                transitionSfx: "none",
              });
            }
          }
        }
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
    next.tracks.video.framing = newFraming;
  }
  syncFramingToDuration(next);

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
      const clampedEnd = Math.min(newTotal, shifted[1]);
      if (clampedEnd > shifted[0]) {
        newOverlays.push({
          ...ov,
          startMs: shifted[0],
          endMs: clampedEnd,
        });
      }
    }
  }
  next.tracks.overlays = newOverlays;

  // Ripple V2 B-Roll
  if (next.tracks.video.broll) {
    next.tracks.video.broll = next.tracks.video.broll
      .map((br) => {
        const shifted = shiftInterval(
          br.timelineStartMs,
          br.timelineStartMs + getBRollDurationMs(br),
          cStart,
          cEnd,
        );
        return shifted && shifted[1] - shifted[0] >= MIN_SLICE_MS
          ? { ...br, timelineStartMs: shifted[0] }
          : null;
      })
      .filter((x): x is BRollClip => x !== null);
  }

  // Ripple A1/A3 Audio Clips
  if (next.tracks.audio.clips) {
    next.tracks.audio.clips = next.tracks.audio.clips
      .map((ac) => {
        const shifted = shiftInterval(
          ac.timelineStartMs,
          ac.timelineStartMs + getAudioClipDurationMs(ac),
          cStart,
          cEnd,
        );
        return shifted && shifted[1] - shifted[0] >= MIN_WORD_MS
          ? { ...ac, timelineStartMs: shifted[0] }
          : null;
      })
      .filter((x): x is AudioClipItem => x !== null);
  }

  return next;
}

export function splitClipAt(edl: TimelineProject, splitAtMs: number): TimelineProject {
  const t = Math.round(splitAtMs);
  const { spans } = buildClipSpans(edl);
  const next = cloneEdl(edl);
  const out: VideoSlice[] = [];
  let didSplit = false;

  for (let i = 0; i < next.tracks.video.clips.length; i += 1) {
    const clip = next.tracks.video.clips[i];
    const { tStart: sT0, tEnd: sT1 } = spans[i];
    if (!didSplit && t >= sT0 + MIN_SLICE_MS && t <= sT1 - MIN_SLICE_MS) {
      const leftTlDur = t - sT0;
      const rightTlDur = sT1 - t;
      if (clip.freezeDurationMs && clip.freezeDurationMs > 0) {
        out.push({ ...clip, freezeDurationMs: leftTlDur });
        out.push({
          ...clip,
          id: nextEdlId(clip.id),
          freezeDurationMs: rightTlDur,
          timelineStartMs: null,
          transitionIn: "none",
          transitionSfx: "none",
        });
        didSplit = true;
        continue;
      }

      const spd = Math.max(0.25, clip.speed ?? 1);
      const srcDelta = Math.round(leftTlDur * spd);
      if (clip.reverse) {
        const pivot = clip.sourceEndMs - srcDelta;
        if (pivot >= clip.sourceStartMs + MIN_SLICE_MS && pivot <= clip.sourceEndMs - MIN_SLICE_MS) {
          out.push({ ...clip, sourceStartMs: pivot });
          out.push({
            ...clip,
            id: nextEdlId(clip.id),
            sourceEndMs: pivot,
            timelineStartMs: null,
            transitionIn: "none",
            transitionSfx: "none",
          });
          didSplit = true;
          continue;
        }
      } else {
        const pivot = clip.sourceStartMs + srcDelta;
        if (pivot >= clip.sourceStartMs + MIN_SLICE_MS && pivot <= clip.sourceEndMs - MIN_SLICE_MS) {
          out.push({ ...clip, sourceEndMs: pivot });
          out.push({
            ...clip,
            id: nextEdlId(clip.id),
            sourceStartMs: pivot,
            timelineStartMs: null,
            transitionIn: "none",
            transitionSfx: "none",
          });
          didSplit = true;
          continue;
        }
      }
    }
    out.push(clip);
  }

  if (!didSplit) {
    throw new Error("Move playhead at least 100ms inside a video clip to split.");
  }
  next.tracks.video.clips = out;
  syncFramingToDuration(next);
  return next;
}

export function deleteClip(
  edl: TimelineProject,
  clipId: string,
  ripple = true,
): TimelineProject {
  const clips = edl.tracks.video.clips;
  if (clips.length <= 1) {
    throw new Error("At least one clip must remain on the main video track.");
  }
  const { spans } = buildClipSpans(edl);
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) {
    throw new Error(`Clip '${clipId}' not found.`);
  }
  const { tStart: sT0, tEnd: sT1 } = spans[idx];
  if (ripple) {
    return applyBladeCut(edl, sT0, sT1);
  }

  const next = cloneEdl(edl);
  const nxtSpanStart = idx + 1 < spans.length ? spans[idx + 1].tStart : null;
  const remaining: VideoSlice[] = [];
  for (let i = 0; i < next.tracks.video.clips.length; i += 1) {
    if (i === idx) continue;
    let c = next.tracks.video.clips[i];
    if (i === idx + 1 && nxtSpanStart !== null) {
      c = { ...c, timelineStartMs: nxtSpanStart };
    }
    remaining.push(c);
  }
  next.tracks.video.clips = remaining;
  syncFramingToDuration(next);
  return next;
}

function remapTracksAfterClipEdit(
  beforeEdl: TimelineProject,
  nextEdl: TimelineProject,
  editedIdx: number,
): void {
  const before = buildClipSpans(beforeEdl);
  const after = buildClipSpans(nextEdl);
  if (before.spans.length === 0 || before.spans.length !== after.spans.length) {
    return;
  }

  const bodyStart = before.coldOpenMs;
  const oldTotal = before.totalDurationMs;
  const newTotal = after.totalDurationMs;

  const remappedWords: SubtitleWord[] = [];
  for (const w of nextEdl.tracks.subtitles.words) {
    if (w.endMs <= bodyStart) {
      const clampedE = Math.min(newTotal, w.endMs);
      if (clampedE - w.startMs >= MIN_WORD_MS) {
        remappedWords.push({ ...w, endMs: clampedE });
      }
      continue;
    }

    const mid = 0.5 * (w.startMs + w.endMs);
    let spanIdx = before.spans.length - 1;
    for (let k = 0; k < before.spans.length; k += 1) {
      if (mid <= before.spans[k].tEnd) {
        spanIdx = k;
        break;
      }
    }

    const bSpan = before.spans[spanIdx];
    const aSpan = after.spans[spanIdx];
    if (spanIdx !== editedIdx) {
      const shift = aSpan.tStart - bSpan.tStart;
      const ns = Math.max(0, w.startMs + shift);
      const ne = Math.min(newTotal, w.endMs + shift);
      if (ne - ns >= MIN_WORD_MS) {
        remappedWords.push({ ...w, startMs: ns, endMs: ne });
      }
      continue;
    }

    const bClip = bSpan.clip;
    const aClip = aSpan.clip;
    if (
      (bClip.freezeDurationMs && bClip.freezeDurationMs > 0) ||
      (aClip.freezeDurationMs && aClip.freezeDurationMs > 0)
    ) {
      const ns = Math.max(
        aSpan.tStart,
        Math.min(aSpan.tEnd - MIN_WORD_MS, aSpan.tStart + (w.startMs - bSpan.tStart)),
      );
      const ne = Math.min(
        aSpan.tEnd,
        Math.max(ns + MIN_WORD_MS, aSpan.tStart + (w.endMs - bSpan.tStart)),
      );
      if (ne - ns >= MIN_WORD_MS) {
        remappedWords.push({ ...w, startMs: ns, endMs: ne });
      }
      continue;
    }

    const bSpd = Math.max(0.25, bClip.speed ?? 1);
    const aSpd = Math.max(0.25, aClip.speed ?? 1);
    const relS = w.startMs - bSpan.tStart;
    const relE = w.endMs - bSpan.tStart;
    const srcLo = bClip.reverse
      ? bClip.sourceEndMs - relE * bSpd
      : bClip.sourceStartMs + relS * bSpd;
    const srcHi = bClip.reverse
      ? bClip.sourceEndMs - relS * bSpd
      : bClip.sourceStartMs + relE * bSpd;

    const cLo = Math.max(aClip.sourceStartMs, srcLo);
    const cHi = Math.min(aClip.sourceEndMs, srcHi);
    if ((cHi - cLo) / aSpd < MIN_WORD_MS) {
      continue;
    }

    let ns = aClip.reverse
      ? aSpan.tStart + Math.round((aClip.sourceEndMs - cHi) / aSpd)
      : aSpan.tStart + Math.round((cLo - aClip.sourceStartMs) / aSpd);
    let ne = aClip.reverse
      ? aSpan.tStart + Math.round((aClip.sourceEndMs - cLo) / aSpd)
      : aSpan.tStart + Math.round((cHi - aClip.sourceStartMs) / aSpd);

    ns = Math.max(aSpan.tStart, Math.min(Math.max(aSpan.tStart, aSpan.tEnd - MIN_WORD_MS), ns));
    ne = Math.min(aSpan.tEnd, Math.max(ns + MIN_WORD_MS, ne));
    if (ne - ns >= MIN_WORD_MS) {
      remappedWords.push({ ...w, startMs: ns, endMs: ne });
    }
  }

  remappedWords.sort((a, b) =>
    a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
  );
  nextEdl.tracks.subtitles.words = remappedWords;

  const oldEditEnd = before.spans[editedIdx].tEnd;
  const tailDelta = after.spans[editedIdx].tEnd - oldEditEnd;
  if (tailDelta !== 0) {
    if (nextEdl.tracks.video.broll) {
      for (const br of nextEdl.tracks.video.broll) {
        if (br.timelineStartMs >= oldEditEnd) {
          br.timelineStartMs = Math.max(0, br.timelineStartMs + tailDelta);
        }
      }
    }
    if (nextEdl.tracks.audio.clips) {
      for (const ac of nextEdl.tracks.audio.clips) {
        if (ac.timelineStartMs >= oldEditEnd) {
          ac.timelineStartMs = Math.max(0, ac.timelineStartMs + tailDelta);
        }
      }
    }
  }

  const keptOverlays: OverlayItem[] = [];
  for (const ov of nextEdl.tracks.overlays) {
    if (ov.startMs === 0 && ov.endMs >= Math.max(250, oldTotal - 50)) {
      keptOverlays.push({ ...ov, endMs: Math.max(250, newTotal) });
    } else if (ov.startMs >= oldEditEnd && tailDelta !== 0) {
      const ns = Math.max(0, ov.startMs + tailDelta);
      const ne = Math.min(newTotal, ov.endMs + tailDelta);
      if (ne - ns >= 150) {
        keptOverlays.push({ ...ov, startMs: ns, endMs: ne });
      }
    } else {
      const clampedEnd = Math.min(newTotal, ov.endMs);
      if (clampedEnd > ov.startMs) {
        keptOverlays.push({ ...ov, endMs: clampedEnd });
      }
    }
  }
  nextEdl.tracks.overlays = keptOverlays;
}

export function setColdOpen(
  edl: TimelineProject,
  opts: {
    enabled: boolean;
    sourceStartMs?: number;
    durationMs?: number;
    fadeOutMs?: number;
  },
): TimelineProject {
  const before = buildClipSpans(edl);
  const oldCo = before.coldOpenMs;
  const oldTotal = before.totalDurationMs;
  const next = cloneEdl(edl);
  const prevBlock = edl.tracks.video.coldOpen;

  let newCo = 0;
  if (!opts.enabled) {
    next.tracks.video.coldOpen = null;
  } else {
    const firstClip = next.tracks.video.clips[0];
    const defaultSrc = Math.round(
      firstClip.sourceStartMs + (firstClip.sourceEndMs - firstClip.sourceStartMs) * 0.6,
    );
    const resolvedSrc = Math.max(
      0,
      Math.round(opts.sourceStartMs ?? prevBlock?.sourceStartMs ?? defaultSrc),
    );
    const resolvedDur = Math.max(
      500,
      Math.min(4000, Math.round(opts.durationMs ?? prevBlock?.durationMs ?? 1500)),
    );
    const resolvedFade = Math.max(
      0,
      Math.min(1000, Math.round(opts.fadeOutMs ?? prevBlock?.fadeOutMs ?? 120)),
    );
    next.tracks.video.coldOpen = {
      enabled: true,
      sourceStartMs: resolvedSrc,
      durationMs: resolvedDur,
      fadeOutMs: resolvedFade,
    };
    newCo = resolvedDur;
  }

  const delta = newCo - oldCo;
  if (delta === 0) {
    syncFramingToDuration(next);
    return next;
  }

  for (const clip of next.tracks.video.clips) {
    if (clip.timelineStartMs !== undefined && clip.timelineStartMs !== null) {
      clip.timelineStartMs = Math.max(newCo, clip.timelineStartMs + delta);
    }
  }

  const newTotal = getTotalDurationMs(next);

  const shiftedWords: SubtitleWord[] = [];
  for (const w of next.tracks.subtitles.words) {
    if (oldCo > 0 && w.endMs <= oldCo) continue;
    const ns = Math.max(newCo, w.startMs + delta);
    const ne = Math.min(newTotal, Math.max(ns + MIN_WORD_MS, w.endMs + delta));
    if (ns < newTotal && ne - ns >= MIN_WORD_MS) {
      shiftedWords.push({ ...w, startMs: ns, endMs: ne });
    }
  }
  next.tracks.subtitles.words = shiftedWords;

  const shiftedMutes: [number, number][] = [];
  for (const [m0, m1] of next.tracks.subtitles.muteRanges) {
    const nm0 = Math.max(0, m0 + delta);
    const nm1 = Math.min(newTotal, m1 + delta);
    if (nm1 > nm0) shiftedMutes.push([nm0, nm1]);
  }
  next.tracks.subtitles.muteRanges = shiftedMutes;

  for (const seg of next.tracks.video.framing) {
    if (seg.timelineStartMs > 0) {
      seg.timelineStartMs = Math.max(1, seg.timelineStartMs + delta);
    }
    if (seg.timelineEndMs < oldTotal) {
      seg.timelineEndMs = Math.max(seg.timelineStartMs + 1, seg.timelineEndMs + delta);
    }
  }
  syncFramingToDuration(next);

  const shiftedOverlays: OverlayItem[] = [];
  for (const ov of next.tracks.overlays) {
    if (ov.startMs === 0 && ov.endMs >= Math.max(250, oldTotal - 50)) {
      shiftedOverlays.push({ ...ov, endMs: Math.max(250, newTotal) });
    } else if (ov.startMs === 0) {
      shiftedOverlays.push({ ...ov, endMs: Math.min(newTotal, Math.max(200, ov.endMs)) });
    } else {
      const ns = Math.max(0, Math.min(Math.max(0, newTotal - 200), ov.startMs + delta));
      const ne = Math.min(newTotal, Math.max(ns + 200, ov.endMs + delta));
      if (ne > ns) {
        shiftedOverlays.push({ ...ov, startMs: ns, endMs: ne });
      }
    }
  }
  next.tracks.overlays = shiftedOverlays;

  if (next.tracks.video.broll) {
    for (const br of next.tracks.video.broll) {
      if (oldCo === 0 || br.timelineStartMs >= oldCo) {
        br.timelineStartMs = Math.max(0, br.timelineStartMs + delta);
      }
    }
  }
  if (next.tracks.audio.clips) {
    for (const ac of next.tracks.audio.clips) {
      if (oldCo === 0 || ac.timelineStartMs >= oldCo) {
        ac.timelineStartMs = Math.max(0, ac.timelineStartMs + delta);
      }
    }
  }

  return next;
}

export function trimClipEdges(
  edl: TimelineProject,
  clipId: string,
  opts: {
    sourceStartMs?: number;
    sourceEndMs?: number;
    timelineStartMs?: number | null;
  },
): TimelineProject {
  const next = cloneEdl(edl);
  const idx = next.tracks.video.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) {
    throw new Error(`Clip '${clipId}' not found.`);
  }
  const target = next.tracks.video.clips[idx];
  const s0 =
    opts.sourceStartMs !== undefined
      ? Math.max(0, Math.round(opts.sourceStartMs))
      : target.sourceStartMs;
  const e0 =
    opts.sourceEndMs !== undefined
      ? Math.max(s0 + MIN_SLICE_MS, Math.round(opts.sourceEndMs))
      : target.sourceEndMs;
  if (e0 - s0 < MIN_SLICE_MS) {
    throw new Error("Clip duration must be at least 100ms.");
  }
  target.sourceStartMs = s0;
  target.sourceEndMs = e0;
  if ("timelineStartMs" in opts) {
    target.timelineStartMs =
      opts.timelineStartMs === null || opts.timelineStartMs === undefined
        ? null
        : Math.max(0, Math.round(opts.timelineStartMs));
  }
  remapTracksAfterClipEdit(edl, next, idx);
  syncFramingToDuration(next);
  return next;
}

export function duplicateClip(edl: TimelineProject, clipId: string): TimelineProject {
  const next = cloneEdl(edl);
  const idx = next.tracks.video.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) {
    throw new Error(`Clip '${clipId}' not found.`);
  }
  const orig = next.tracks.video.clips[idx];
  next.tracks.video.clips.splice(idx + 1, 0, {
    ...orig,
    id: nextEdlId(orig.id),
    timelineStartMs: null,
    label: orig.label ? `${orig.label} (Copy)` : "Scene Copy",
  });
  syncFramingToDuration(next);
  return next;
}

export function setClipSpeed(
  edl: TimelineProject,
  clipId: string,
  speed: number,
  reverse?: boolean,
): TimelineProject {
  const next = cloneEdl(edl);
  const idx = next.tracks.video.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) {
    throw new Error(`Clip '${clipId}' not found.`);
  }
  const target = next.tracks.video.clips[idx];
  target.speed = Math.round(Math.max(0.25, Math.min(4.0, speed)) * 1000) / 1000;
  target.freezeDurationMs = 0;
  if (reverse !== undefined) {
    target.reverse = reverse;
  }
  remapTracksAfterClipEdit(edl, next, idx);
  syncFramingToDuration(next);
  return next;
}

export function freezeFrameAt(
  edl: TimelineProject,
  timelineMs: number,
  durationMs = 2000,
): TimelineProject {
  const holdMs = Math.max(200, Math.min(30000, Math.round(durationMs)));
  const { spans } = buildClipSpans(edl);
  const pt = resolveTimelinePoint(edl, timelineMs);
  if (!pt.clip || pt.isColdOpen || pt.isGap) {
    throw new Error("Move playhead onto an active video clip to insert a freeze frame.");
  }
  const targetIdx = edl.tracks.video.clips.findIndex((c) => c.id === pt.clip!.id);
  const { tStart: sT0, tEnd: sT1, clip: orig } = spans[targetIdx];
  const freezeSrc = Math.max(0, pt.sourceMs);
  const freezeSlice: VideoSlice = {
    id: nextEdlId("frz"),
    sourceStartMs: freezeSrc,
    sourceEndMs: freezeSrc + 100,
    sourceId: orig.sourceId ?? null,
    label: "Freeze Frame",
    freezeDurationMs: holdMs,
    muted: true,
  };

  let next = cloneEdl(edl);
  let insertPos = targetIdx + 1;
  if (timelineMs >= sT0 + MIN_SLICE_MS && timelineMs <= sT1 - MIN_SLICE_MS) {
    next = splitClipAt(next, timelineMs);
    insertPos = targetIdx + 1;
    next.tracks.video.clips.splice(insertPos, 0, freezeSlice);
  } else if (timelineMs <= sT0 + MIN_SLICE_MS) {
    insertPos = targetIdx;
    next.tracks.video.clips.splice(insertPos, 0, freezeSlice);
  } else {
    insertPos = targetIdx + 1;
    next.tracks.video.clips.splice(insertPos, 0, freezeSlice);
  }

  // Ripple downstream pinned clips, words, overlays, B-roll, and audio clips forward by holdMs
  for (let i = insertPos + 1; i < next.tracks.video.clips.length; i += 1) {
    const c = next.tracks.video.clips[i];
    if (c.timelineStartMs !== undefined && c.timelineStartMs !== null) {
      c.timelineStartMs += holdMs;
    }
  }
  for (const w of next.tracks.subtitles.words) {
    if (w.startMs >= timelineMs) {
      w.startMs += holdMs;
      w.endMs += holdMs;
    } else if (w.endMs > timelineMs) {
      w.endMs += holdMs;
    }
  }
  for (const ov of next.tracks.overlays) {
    if (ov.startMs >= timelineMs) {
      ov.startMs += holdMs;
      ov.endMs += holdMs;
    } else if (ov.endMs > timelineMs) {
      ov.endMs += holdMs;
    }
  }
  if (next.tracks.video.broll) {
    for (const br of next.tracks.video.broll) {
      if (br.timelineStartMs >= timelineMs) {
        br.timelineStartMs += holdMs;
      }
    }
  }
  if (next.tracks.audio.clips) {
    for (const ac of next.tracks.audio.clips) {
      if (ac.timelineStartMs >= timelineMs) {
        ac.timelineStartMs += holdMs;
      }
    }
  }
  syncFramingToDuration(next);
  return next;
}

export function detachClipAudio(edl: TimelineProject, clipId: string): TimelineProject {
  const { spans } = buildClipSpans(edl);
  const idx = edl.tracks.video.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) {
    throw new Error(`Clip '${clipId}' not found.`);
  }
  const { tStart, clip: orig } = spans[idx];
  if (orig.audioDetached) {
    return cloneEdl(edl);
  }
  const next = cloneEdl(edl);
  next.tracks.video.clips[idx].audioDetached = true;
  const detached: AudioClipItem = {
    id: nextEdlId("aud"),
    kind: "detached",
    sourceId: orig.sourceId ?? edl.sourceId,
    label: `${orig.label || "Scene"} Audio`,
    sourceStartMs: orig.sourceStartMs,
    sourceEndMs: orig.sourceEndMs,
    timelineStartMs: tStart,
    speed: orig.speed ?? 1,
    gainDb: orig.gainDb ?? 0,
    muted: orig.muted ?? false,
    fadeInMs: orig.fadeInMs ?? 0,
    fadeOutMs: orig.fadeOutMs ?? 0,
  };
  next.tracks.audio.clips = [...(next.tracks.audio.clips ?? []), detached];
  return next;
}

export function addBRollClip(
  edl: TimelineProject,
  opts: {
    sourceId: string;
    sourceStartMs?: number;
    sourceEndMs?: number;
    timelineStartMs?: number;
    label?: string;
    box?: NormalizedBox;
  },
): TimelineProject {
  const next = cloneEdl(edl);
  const s0 = Math.max(0, Math.round(opts.sourceStartMs ?? 0));
  const e0 = Math.max(s0 + MIN_SLICE_MS, Math.round(opts.sourceEndMs ?? s0 + 4000));
  const item: BRollClip = {
    id: nextEdlId("br"),
    sourceId: opts.sourceId,
    label: opts.label ?? "B-Roll",
    sourceStartMs: s0,
    sourceEndMs: e0,
    timelineStartMs: Math.max(0, Math.round(opts.timelineStartMs ?? 0)),
    speed: 1,
    opacity: 1,
    box: opts.box ?? { x: 0.56, y: 0.06, w: 0.38, h: 0.28 },
    gainDb: -60,
    muted: true,
  };
  next.tracks.video.broll = [...(next.tracks.video.broll ?? []), item];
  return next;
}

export function addAudioClipItem(
  edl: TimelineProject,
  opts: {
    kind?: "detached" | "sfx" | "audio";
    assetId?: string | null;
    sourceId?: string | null;
    label?: string;
    sourceStartMs?: number;
    sourceEndMs?: number;
    timelineStartMs?: number;
    gainDb?: number;
  },
): TimelineProject {
  const next = cloneEdl(edl);
  const s0 = Math.max(0, Math.round(opts.sourceStartMs ?? 0));
  const e0 = Math.max(s0 + MIN_WORD_MS, Math.round(opts.sourceEndMs ?? s0 + 900));
  const item: AudioClipItem = {
    id: nextEdlId("ac"),
    kind: opts.kind ?? "sfx",
    assetId: opts.assetId ?? null,
    sourceId: opts.sourceId ?? null,
    label: opts.label ?? "SFX",
    sourceStartMs: s0,
    sourceEndMs: e0,
    timelineStartMs: Math.max(0, Math.round(opts.timelineStartMs ?? 0)),
    speed: 1,
    gainDb: opts.gainDb ?? -4,
    muted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
  next.tracks.audio.clips = [...(next.tracks.audio.clips ?? []), item];
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
    id: nextEdlId("w"),
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
        id: nextEdlId(seg.id),
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
