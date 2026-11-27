import { describe, expect, it } from "vitest";
import {
  addAudioClipItem,
  addBRollClip,
  deleteClip,
  detachClipAudio,
  duplicateClip,
  freezeFrameAt,
  getTotalDurationMs,
  resolveTimelinePoint,
  setClipSpeed,
  splitClipAt,
  TimelineProjectSchema,
  timelineToSource,
  trimClipEdges,
  type TimelineProject,
} from "./index";

function makeBaseProject(): TimelineProject {
  return TimelineProjectSchema.parse({
    schemaVersion: 1,
    projectId: "clip_vitest_p1",
    sourceId: "src_1",
    title: "MultiTrack Parity",
    sourceDurationMs: 10_000,
    sourceWidth: 1920,
    sourceHeight: 1080,
    output: {
      ratio: "9:16",
      quality: "1080p",
      speedPreset: "final",
      fps: 60,
      loudnessLufs: -14,
    },
    tracks: {
      video: {
        coldOpen: null,
        clips: [
          {
            id: "s1",
            sourceStartMs: 0,
            sourceEndMs: 6000,
            sourceId: "src_1",
            label: "Opening",
          },
        ],
        framing: [
          {
            id: "f1",
            timelineStartMs: 0,
            timelineEndMs: 6000,
            mode: "fit",
            splitRatio: 0.35,
            camBox: null,
            gameBox: null,
          },
        ],
      },
      audio: {
        gainDb: -60,
        normalizeLufs: -14,
      },
      subtitles: {
        enabled: true,
        style: {
          preset: "bold_pop",
          revealMode: "progressive",
          font: "Montserrat-ExtraBold",
          fontSizeScale: 1,
          primaryColor: "#FFFFFF",
          accentColor: "#FFE500",
          outlineColor: "#000000",
        },
        censorProfanity: false,
        marginVRatio: 0.22,
        muteRanges: [],
        words: [],
      },
      overlays: [],
    },
  });
}

describe("Phase 1 Multi-Track EDL & NLE Ops", () => {
  it("splits clips, adjusts speed, detaches audio, and validates with Zod", () => {
    let edl = makeBaseProject();
    edl = splitClipAt(edl, 2000);
    expect(edl.tracks.video.clips).toHaveLength(2);
    expect(getTotalDurationMs(edl)).toBe(6000);

    const secondId = edl.tracks.video.clips[1].id;
    edl = setClipSpeed(edl, secondId, 2.0);
    // 2000ms + (4000ms / 2.0) = 4000ms
    expect(getTotalDurationMs(edl)).toBe(4000);
    expect(timelineToSource(edl, 3000).sourceMs).toBe(4000);

    edl = detachClipAudio(edl, edl.tracks.video.clips[0].id);
    expect(edl.tracks.video.clips[0].audioDetached).toBe(true);
    expect(edl.tracks.audio.clips).toHaveLength(1);

    edl = addBRollClip(edl, { sourceId: "src_1", timelineStartMs: 500 });
    edl = addAudioClipItem(edl, { kind: "sfx", assetId: "whoosh_flash", timelineStartMs: 1800 });

    expect(() => TimelineProjectSchema.parse(edl)).not.toThrow();
  });

  it("supports non-ripple gap deletion, freeze frames, duplicate, and trim", () => {
    let edl = makeBaseProject();
    edl = splitClipAt(edl, 2000);
    edl = splitClipAt(edl, 4000);
    const midId = edl.tracks.video.clips[1].id;

    // Non-ripple delete preserves 6000ms total duration with a [2000, 4000] gap
    const gapped = deleteClip(edl, midId, false);
    expect(getTotalDurationMs(gapped)).toBe(6000);
    expect(resolveTimelinePoint(gapped, 3000).isGap).toBe(true);

    const frozen = freezeFrameAt(gapped, 1000, 1500);
    expect(getTotalDurationMs(frozen)).toBe(7500);

    const dup = duplicateClip(gapped, gapped.tracks.video.clips[0].id);
    const trimmed = trimClipEdges(dup, dup.tracks.video.clips[0].id, {
      sourceStartMs: 500,
      sourceEndMs: 1500,
    });
    expect(trimmed.tracks.video.clips[0].sourceStartMs).toBe(500);
    expect(() => TimelineProjectSchema.parse(trimmed)).not.toThrow();
  });
});
