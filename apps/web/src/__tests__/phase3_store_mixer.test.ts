import { describe, expect, it } from "vitest";
import {
  dbToLinearGain,
  formatDbLabel,
} from "../utils/audioMath";
import { getTotalDurationMs, TimelineProjectSchema, type TimelineProject } from "../edl";
import { useTimelineStore } from "../state/timelineStore";

function createTestEdl(): TimelineProject {
  return TimelineProjectSchema.parse({
    schemaVersion: 1,
    projectId: "clip_phase3_store",
    sourceId: "src_main",
    title: "Phase 3 Store & Mixer Test",
    sourceDurationMs: 12_000,
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
            sourceId: "src_main",
            label: "Intro",
          },
        ],
        broll: [],
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
        gainDb: 0,
        normalizeLufs: -14,
        clips: [],
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
      overlays: [
        {
          id: "ov_hook",
          kind: "seam_card_white",
          text: "Headline Hook",
          startMs: 0,
          endMs: 3000,
          yAnchor: "split_seam",
          yOffsetRatio: 0,
          xOffsetRatio: 0.5,
          opacity: 1,
          scale: 1,
        },
      ],
    },
  });
}

describe("Phase 3 WebAudio Gain Math & Labels", () => {
  it("maps <= -59.5 dB to true zero linear gain (-infinity silence) and supports +12 dB boost", () => {
    expect(dbToLinearGain(-60)).toBe(0);
    expect(dbToLinearGain(-59.5)).toBe(0);
    expect(dbToLinearGain(0)).toBeCloseTo(1, 5);
    expect(dbToLinearGain(-6)).toBeCloseTo(0.501187, 4);
    expect(dbToLinearGain(12)).toBeCloseTo(3.98107, 4);

    expect(formatDbLabel(-60)).toBe("-∞ dB");
    expect(formatDbLabel(0)).toBe("+0.0 dB");
    expect(formatDbLabel(-18.5)).toBe("-18.5 dB");
    expect(formatDbLabel(6)).toBe("+6.0 dB");
  });
});

describe("Phase 3 Timeline Store NLE Actions", () => {
  it("splits at playhead, supports ripple vs free-gap delete, freeze frame, detach audio, and undo", () => {
    const store = useTimelineStore.getState();
    store.loadProject(createTestEdl(), 0);

    // Split at 2000ms and 4000ms -> 3 clips
    useTimelineStore.getState().setPlayheadMs(2000);
    useTimelineStore.getState().splitClipAtPlayhead();
    useTimelineStore.getState().setPlayheadMs(4000);
    useTimelineStore.getState().splitClipAtPlayhead();
    expect(useTimelineStore.getState().edl?.tracks.video.clips).toHaveLength(3);

    // Switch to Free Gap mode (rippleMode = false) and delete middle clip
    if (useTimelineStore.getState().rippleMode) {
      useTimelineStore.getState().toggleRippleMode();
    }
    const midClipId = useTimelineStore.getState().edl!.tracks.video.clips[1].id;
    useTimelineStore.getState().selectClip(midClipId);
    expect(useTimelineStore.getState().deleteActiveSelection()).toBe(true);
    expect(useTimelineStore.getState().edl?.tracks.video.clips).toHaveLength(2);
    expect(getTotalDurationMs(useTimelineStore.getState().edl!)).toBe(6000);

    // Undo restores 3 clips
    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().edl?.tracks.video.clips).toHaveLength(3);

    // Detach audio from clip 0 -> populates tracks.audio.clips and marks clip audioDetached
    const firstClipId = useTimelineStore.getState().edl!.tracks.video.clips[0].id;
    useTimelineStore.getState().detachAudioFromClip(firstClipId);
    const afterDetach = useTimelineStore.getState().edl!;
    expect(afterDetach.tracks.video.clips[0].audioDetached).toBe(true);
    expect(afterDetach.tracks.audio.clips).toHaveLength(1);

    // Insert 1s freeze frame at 1000ms -> extends total duration from 6000ms to 7000ms
    useTimelineStore.getState().insertFreezeFrame(1000, 1000);
    expect(getTotalDurationMs(useTimelineStore.getState().edl!)).toBe(7000);
  });

  it("duplicates/scales overlays, manages V2 B-Roll & A3 SFX, and opens AI Co-Editor on selection", () => {
    useTimelineStore.getState().loadProject(createTestEdl(), 0);

    useTimelineStore.getState().updateOverlay("ov_hook", { scale: 1.45, xOffsetRatio: 0.62 });
    expect(useTimelineStore.getState().edl?.tracks.overlays[0].scale).toBeCloseTo(1.45, 3);

    useTimelineStore.getState().duplicateOverlay("ov_hook");
    expect(useTimelineStore.getState().edl?.tracks.overlays).toHaveLength(2);

    useTimelineStore.getState().addBroll({ sourceId: "src_main", timelineStartMs: 500 });
    expect(useTimelineStore.getState().edl?.tracks.video.broll).toHaveLength(1);

    useTimelineStore.getState().addAudioClip({
      kind: "sfx",
      assetId: "whoosh_flash",
      timelineStartMs: 1200,
    });
    expect(useTimelineStore.getState().edl?.tracks.audio.clips).toHaveLength(1);

    useTimelineStore.getState().selectOverlay("ov_hook");
    useTimelineStore.getState().askAiOnSelection('Overlay "Headline Hook"');
    expect(useTimelineStore.getState().rightDockTab).toBe("coeditor");
    expect(useTimelineStore.getState().aiSelectionPromptLabel).toBe('Overlay "Headline Hook"');
  });
});
