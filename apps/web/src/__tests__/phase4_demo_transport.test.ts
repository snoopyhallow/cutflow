import { describe, expect, it } from "vitest";
import { DemoTransport, getDesktopBridge } from "../transport";

describe("Phase 4 Home Hub, Auto-Captions & AI Co-Editor Transport", () => {
  it("creates blank projects, duplicates, renames, deletes, and transcribes in DemoTransport", async () => {
    const demo = new DemoTransport();
    const initial = await demo.listProjects();
    const blank = await demo.createBlankProject({
      title: "CapCut Blank 9x16",
      ratio: "9:16",
    });

    expect(blank.edl.output.ratio).toBe("9:16");
    expect((await demo.listProjects()).length).toBe(initial.length + 1);

    const renamed = await demo.renameProject(blank.id, { title: "Renamed NLE Cut" });
    expect(renamed.title).toBe("Renamed NLE Cut");

    const dup = await demo.duplicateProject(blank.id);
    expect(dup.id).not.toBe(blank.id);

    const transcribed = await demo.transcribeProject(blank.id, "en");
    expect(transcribed.wordCount).toBeGreaterThan(0);
    expect(transcribed.edl.tracks.subtitles.words.length).toBe(transcribed.wordCount);

    await demo.deleteProject(dup.id);
    expect((await demo.listProjects()).some((p) => p.id === dup.id)).toBe(false);
  });

  it("exposes live AI models list and removes Headline Hook via Co-Editor", async () => {
    const demo = new DemoTransport();
    const models = await demo.listAiModels();
    expect(models.modelsByProvider.gemini).toContain("gemini-3.5-flash-lite");

    const blank = await demo.createBlankProject({ title: "Hook Test", ratio: "9:16" });
    // Seed a Headline Hook overlay
    blank.edl.tracks.overlays.push({
      id: "ov_hook_1",
      kind: "seam_card_white",
      text: "Headline Hook",
      startMs: 0,
      endMs: 3000,
      yAnchor: "split_seam",
      yOffsetRatio: 0,
      xOffsetRatio: 0,
      opacity: 1,
      scale: 1,
      maxLines: 2,
    });
    await demo.saveTimeline(blank.id, blank.edl);

    const coRes = await demo.runCoEditor(blank.id, {
      instruction: "Remove the hook I don't like it",
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
    });
    expect(coRes.edl.tracks.overlays).toHaveLength(0);
    expect(coRes.applied.length).toBeGreaterThan(0);

    expect(getDesktopBridge()).toBeNull();
  });
});
