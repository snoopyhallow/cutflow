import { describe, expect, it } from "vitest";
import sampleEdlFixture from "@edl-schema/fixtures/sample_streamer_clip.edl.json";
import {
  applyBladeCut,
  deleteWord,
  formatTimecodeMs,
  getTotalDurationMs,
  insertWord,
  snapToNearestOnsetMs,
  sourceToTimeline,
  TimelineProjectSchema,
  timelineToSource,
  updateWordTiming,
} from "../edl";
import { useTimelineStore } from "../state/timelineStore";
import { DemoTransport } from "../transport/demoTransport";

describe("Canonical EDL v1 Zod contract", () => {
  it("validates the shared cross-language fixture cleanly", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    expect(edl.schemaVersion).toBe(1);
    expect(edl.tracks.subtitles.style.revealMode).toBe("progressive");
    expect(edl.tracks.overlays[0]?.kind).toBe("seam_card_white");
    expect(getTotalDurationMs(edl)).toBe(21_500);
  });

  it("rejects unknown extra fields and inverted time intervals", () => {
    const withExtra = { ...sampleEdlFixture, rogueField: true };
    expect(() => TimelineProjectSchema.parse(withExtra)).toThrow();

    const badWord = structuredClone(sampleEdlFixture);
    badWord.tracks.subtitles.words[0].endMs = 1000;
    badWord.tracks.subtitles.words[0].startMs = 2000;
    expect(() => TimelineProjectSchema.parse(badWord)).toThrow();
  });
});

describe("TimelineMapper & non-destructive EDL operations", () => {
  it("maps timelineMs <-> sourceMs across cold-open and main body", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    expect(timelineToSource(edl, 500)).toEqual({
      isColdOpen: true,
      sourceMs: 24_500,
    });
    expect(timelineToSource(edl, 1500)).toEqual({
      isColdOpen: false,
      sourceMs: 10_000,
    });
    expect(timelineToSource(edl, 6500)).toEqual({
      isColdOpen: false,
      sourceMs: 15_000,
    });
    expect(sourceToTimeline(edl, 15_000)).toBe(6500);
    expect(sourceToTimeline(edl, 99_000)).toBeNull();
  });

  it("applies a blade cut and ripples framing, subtitles, and overlays", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    const cut = applyBladeCut(edl, 4000, 9000);

    expect(cut.tracks.video.clips).toHaveLength(2);
    expect(getTotalDurationMs(cut)).toBe(16_500);
    expect(cut.tracks.video.framing[0].timelineEndMs).toBe(16_500);
    expect(cut.tracks.overlays[0].endMs).toBe(16_500);

    // Words after 9000ms shift earlier by 5000ms
    const lookWord = cut.tracks.subtitles.words.find((w) => w.id === "w7");
    expect(lookWord?.startMs).toBe(4500);
    expect(lookWord?.endMs).toBe(4820);

    // Source timestamps inside the deleted region no longer map to timeline
    expect(sourceToTimeline(cut, 14_000)).toBeNull();
  });

  it("performs Premiere-style rolling edit on adjacent words", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    // w1 is 1700..1980, w2 is 1980..2320; drag w2 start earlier to 1880
    const rolled = updateWordTiming(edl, "w2", 1880, 2320, true);
    const w1 = rolled.tracks.subtitles.words.find((w) => w.id === "w1")!;
    const w2 = rolled.tracks.subtitles.words.find((w) => w.id === "w2")!;
    expect(w1.endMs).toBe(1880);
    expect(w2.startMs).toBe(1880);

    // Without rolling, w2 clamps at w1.endMs
    const clamped = updateWordTiming(edl, "w2", 1880, 2320, false);
    expect(clamped.tracks.subtitles.words.find((w) => w.id === "w2")?.startMs).toBe(
      1980,
    );
  });

  it("inserts and deletes words cleanly without creating overlaps", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    const added = insertWord(edl, "SIU!", 5000, 900);
    const siu = added.tracks.subtitles.words.find((w) => w.text === "SIU!");
    expect(siu).toBeDefined();
    expect(siu?.startMs).toBe(5000);
    expect(siu?.endMs).toBe(5900);

    const removed = deleteWord(added, siu!.id);
    expect(removed.tracks.subtitles.words).toHaveLength(
      edl.tracks.subtitles.words.length,
    );
  });

  it("formats tabular timecodes accurately", () => {
    expect(formatTimecodeMs(21_540)).toBe("00:21.54");
    expect(formatTimecodeMs(65_010)).toBe("01:05.01");
  });
});

describe("Zustand Command-Pattern Timeline Store & DemoTransport", () => {
  it("supports undo/redo and 1-click AI patch revert", () => {
    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    const store = useTimelineStore.getState();
    store.loadProject(edl);

    useTimelineStore.getState().bladeCut(4000, 9000);
    expect(getTotalDurationMs(useTimelineStore.getState().edl!)).toBe(16_500);
    expect(useTimelineStore.getState().undoStack).toHaveLength(1);

    useTimelineStore.getState().undo();
    expect(getTotalDurationMs(useTimelineStore.getState().edl!)).toBe(21_500);
    expect(useTimelineStore.getState().redoStack).toHaveLength(1);

    useTimelineStore.getState().redo();
    expect(getTotalDurationMs(useTimelineStore.getState().edl!)).toBe(16_500);

    // Optimistic AI patch + 1-click revert
    const aiEdited = insertWord(useTimelineStore.getState().edl!, "BANGER!", 6000, 700);
    useTimelineStore.getState().applyAiPatchResult(aiEdited, ["Inserted 'BANGER!'"]);
    expect(
      useTimelineStore
        .getState()
        .edl!.tracks.subtitles.words.some((w) => w.text === "BANGER!"),
    ).toBe(true);
    expect(useTimelineStore.getState().lastAiPatch).not.toBeNull();

    useTimelineStore.getState().revertLastAiPatch();
    expect(
      useTimelineStore
        .getState()
        .edl!.tracks.subtitles.words.some((w) => w.text === "BANGER!"),
    ).toBe(false);
    expect(useTimelineStore.getState().lastAiPatch).toBeNull();
  });

  it("persists edits and demo ingests in memory through DemoTransport", async () => {
    const demo = new DemoTransport();
    const initial = await demo.getTimeline("clip_demo_001");
    const updated = insertWord(initial.edl, "GOAT", 7000, 600);
    const saved = await demo.saveTimeline("clip_demo_001", updated);
    expect(saved.edl.tracks.subtitles.words.some((w) => w.text === "GOAT")).toBe(
      true,
    );

    const urlRes = await demo.ingestUrl("https://www.youtube.com/watch?v=demo123");
    expect(urlRes.source.sourceType).toBe("url");
    expect(urlRes.job?.status).toBe("done");
    const projects = await demo.listProjects();
    expect(projects.length).toBeGreaterThanOrEqual(2);

    const profile = await demo.createProfile({ name: "Speed IRL" });
    expect(profile.id).toBe("speed-irl");

    const exp = await demo.exportProject("clip_demo_001", {
      quality: "720p",
      speedPreset: "draft",
    });
    expect(exp.quality).toBe("720p");
    expect((await demo.listExports()).length).toBe(1);
    await demo.deleteExport(exp.id);
    expect((await demo.listExports()).length).toBe(0);

    const peaks = await demo.getProjectPeaks("clip_demo_001");
    expect(peaks.rateHz).toBe(100);
    expect(peaks.peaks.length).toBeGreaterThan(1000);

    // Co-Editor optimistic apply, Approval status, and Post Copy in DemoTransport
    const coRes = await demo.runCoEditor("clip_demo_001", {
      instruction: "Cut 4s to 8s and change title to 'DEMO BANGER'",
      boundaries: "Keep captions on.",
      saveBoundaries: true,
    });
    expect(coRes.applied.length).toBeGreaterThanOrEqual(2);
    expect(getTotalDurationMs(coRes.edl)).toBe(17_500);
    expect(getTotalDurationMs(coRes.previousEdl)).toBe(21_500);
    expect(coRes.edl.tracks.overlays[0].text).toBe("DEMO BANGER");

    const approved = await demo.updateProjectStatus("clip_demo_001", "approved");
    expect(approved.status).toBe("approved");

    const postCopy = await demo.generatePostCopy("clip_demo_001", "tiktok");
    expect(postCopy.hashtags.length).toBeGreaterThanOrEqual(4);
    expect(postCopy.fullCopy).toContain(postCopy.title);
  });

  it("magnetically snaps word handles to waveform onsets and supports NLE store commands", () => {
    // 100Hz peaks with a sharp rising onset at index 150 (1500ms)
    const peaks = new Array<number>(300).fill(0.05);
    for (let i = 150; i < 220; i += 1) peaks[i] = 0.85;
    expect(snapToNearestOnsetMs(1440, peaks, 100, 120)).toBe(1500);
    expect(snapToNearestOnsetMs(900, peaks, 100, 120)).toBe(900);

    const edl = TimelineProjectSchema.parse(sampleEdlFixture);
    useTimelineStore.getState().loadProject(edl, 2000);
    expect(useTimelineStore.getState().sliceOriginMs).toBe(2000);

    // Framing update + Overlay add/trim/remove + Undo
    useTimelineStore.getState().updateFraming({ splitRatio: 0.42 });
    expect(useTimelineStore.getState().edl!.tracks.video.framing[0].splitRatio).toBe(0.42);

    useTimelineStore.getState().addOverlay("cta_pill", "Follow for Part 2", 18_000, 21_500);
    const ctaId = useTimelineStore.getState().selectedOverlayId!;
    expect(ctaId).toBeTruthy();
    useTimelineStore.getState().updateOverlay(ctaId, { startMs: 17_000, yOffsetRatio: -0.05 });
    const cta = useTimelineStore
      .getState()
      .edl!.tracks.overlays.find((o) => o.id === ctaId)!;
    expect(cta.startMs).toBe(17_000);
    expect(cta.yOffsetRatio).toBe(-0.05);

    useTimelineStore.getState().removeOverlay(ctaId);
    expect(useTimelineStore.getState().edl!.tracks.overlays.some((o) => o.id === ctaId)).toBe(
      false,
    );
    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().edl!.tracks.overlays.some((o) => o.id === ctaId)).toBe(
      true,
    );
  });
});
