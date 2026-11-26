import { produce } from "immer";
import { create } from "zustand";
import {
  applyBladeCut,
  autoTightenSilence,
  cloneEdl,
  deleteWord,
  getActiveFramingAt,
  getTotalDurationMs,
  insertWord,
  splitFramingSegment,
  updateWordTiming,
  type AudioTrack,
  type BgmTrack,
  type FramingSegment,
  type OverlayItem,
  type TimelineProject,
  type VideoSlice,
} from "../edl";

export interface HistoryEntry {
  label: string;
  edl: TimelineProject;
}

export interface AiPatchBanner {
  summary: string[];
  previousEdl: TimelineProject;
}

export type InspectorContext = "framing" | "audio" | "subtitle" | "overlay" | "export";

export interface TimelineStoreState {
  edl: TimelineProject | null;
  sliceOriginMs: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  playheadMs: number;
  isPlaying: boolean;
  playbackRate: number;
  snapToWaveform: boolean;
  inPointMs: number | null;
  outPointMs: number | null;
  selectedWordId: string | null;
  selectedOverlayId: string | null;
  selectedClipId: string | null;
  inspectorContext: InspectorContext;
  zoomPxPerSec: number;
  dirty: boolean;
  lastActionLabel: string | null;
  lastAiPatch: AiPatchBanner | null;

  loadProject: (edl: TimelineProject, sliceOriginMs?: number) => void;
  setPlayheadMs: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
  togglePlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  toggleSnapToWaveform: () => void;
  setInPointMs: (ms: number | null) => void;
  setOutPointMs: (ms: number | null) => void;
  clearInOut: () => void;
  selectWord: (wordId: string | null) => void;
  selectOverlay: (overlayId: string | null) => void;
  selectClip: (clipId: string | null) => void;
  setInspectorContext: (ctx: InspectorContext) => void;
  setZoomPxPerSec: (pxPerSec: number) => void;
  markSaved: () => void;

  /** Run an Immer recipe or pure EDL transform as an undoable Command. */
  commitEdl: (label: string, nextEdl: TimelineProject) => void;
  mutateEdl: (label: string, recipe: (draft: TimelineProject) => void) => void;

  /** High-level NLE commands. */
  bladeCut: (cutStartMs: number, cutEndMs: number) => void;
  setWordTiming: (
    wordId: string,
    startMs: number,
    endMs: number,
    rollingAdjacent?: boolean,
  ) => void;
  setWordText: (wordId: string, text: string, glowColor?: string | null) => void;
  addWord: (text: string, startMs: number, durationMs?: number) => void;
  removeWord: (wordId: string) => void;
  updateOverlay: (
    overlayId: string,
    patch: Partial<
      Pick<
        OverlayItem,
        | "text"
        | "startMs"
        | "endMs"
        | "yAnchor"
        | "yOffsetRatio"
        | "xOffsetRatio"
        | "opacity"
        | "kind"
      >
    >,
  ) => void;
  addOverlay: (
    kind: OverlayItem["kind"],
    text: string,
    startMs?: number,
    endMs?: number,
  ) => void;
  removeOverlay: (overlayId: string) => void;
  updateFraming: (
    patch: Partial<
      Pick<
        FramingSegment,
        | "mode"
        | "splitRatio"
        | "camBox"
        | "gameBox"
        | "fitBackdrop"
        | "panX"
        | "panY"
        | "zoom"
        | "sourceCropBox"
      >
    >,
  ) => void;
  updateAudio: (
    patch: Partial<Pick<AudioTrack, "gainDb" | "dialogueEnhance" | "muteOriginal" | "normalizeLufs">>,
  ) => void;
  updateBgm: (patch: Partial<BgmTrack> | null) => void;
  updateSliceTransition: (
    clipId: string,
    patch: Partial<Pick<VideoSlice, "transitionIn" | "transitionDurationMs" | "transitionSfx" | "label">>,
  ) => void;
  splitFramingAtPlayhead: (rightMode?: FramingSegment["mode"]) => void;
  tightenSilence: (
    rms100hz?: number[],
    rateHz?: number,
    minGapMs?: number,
  ) => { cutsApplied: number; savedMs: number };

  /** Optimistic AI Co-Editor apply with 1-click Revert support. */
  applyAiPatchResult: (nextEdl: TimelineProject, summary: string[]) => void;
  revertLastAiPatch: () => void;
  dismissAiPatchBanner: () => void;

  undo: () => void;
  redo: () => void;
}

const MAX_HISTORY = 100;

export const useTimelineStore = create<TimelineStoreState>((set, get) => ({
  edl: null,
  sliceOriginMs: 0,
  undoStack: [],
  redoStack: [],
  playheadMs: 0,
  isPlaying: false,
  playbackRate: 1,
  snapToWaveform: true,
  inPointMs: null,
  outPointMs: null,
  selectedWordId: null,
  selectedOverlayId: null,
  selectedClipId: null,
  inspectorContext: "framing",
  zoomPxPerSec: 130,
  dirty: false,
  lastActionLabel: null,
  lastAiPatch: null,

  loadProject(edl, sliceOriginMs = 0) {
    set({
      edl: cloneEdl(edl),
      sliceOriginMs,
      undoStack: [],
      redoStack: [],
      playheadMs: 0,
      isPlaying: false,
      playbackRate: 1,
      inPointMs: null,
      outPointMs: null,
      selectedWordId: null,
      selectedOverlayId: null,
      selectedClipId: edl.tracks.video.clips[0]?.id ?? null,
      inspectorContext: "framing",
      dirty: false,
      lastActionLabel: null,
      lastAiPatch: null,
    });
  },

  setPlayheadMs(ms) {
    const edl = get().edl;
    const maxMs = edl ? getTotalDurationMs(edl) : Number.MAX_SAFE_INTEGER;
    set({ playheadMs: Math.max(0, Math.min(maxMs, Math.round(ms))) });
  },

  setIsPlaying(playing) {
    set({ isPlaying: playing });
  },

  togglePlayback() {
    const { isPlaying, edl, playheadMs } = get();
    if (!isPlaying && edl && playheadMs >= getTotalDurationMs(edl) - 40) {
      set({ playheadMs: 0, isPlaying: true, playbackRate: 1 });
      return;
    }
    set({ isPlaying: !isPlaying, playbackRate: 1 });
  },

  setPlaybackRate(rate) {
    set({ playbackRate: Math.max(-2, Math.min(4, rate)) });
  },

  toggleSnapToWaveform() {
    set((s) => ({ snapToWaveform: !s.snapToWaveform }));
  },

  setInPointMs(ms) {
    set({ inPointMs: ms === null ? null : Math.max(0, Math.round(ms)) });
  },

  setOutPointMs(ms) {
    set({ outPointMs: ms === null ? null : Math.max(0, Math.round(ms)) });
  },

  clearInOut() {
    set({ inPointMs: null, outPointMs: null });
  },

  selectWord(wordId) {
    set({
      selectedWordId: wordId,
      selectedOverlayId: wordId ? null : get().selectedOverlayId,
      inspectorContext: wordId ? "subtitle" : get().inspectorContext,
    });
  },

  selectOverlay(overlayId) {
    set({
      selectedOverlayId: overlayId,
      selectedWordId: overlayId ? null : get().selectedWordId,
      inspectorContext: overlayId ? "overlay" : get().inspectorContext,
    });
  },

  selectClip(clipId) {
    set({
      selectedClipId: clipId,
      inspectorContext: clipId ? "framing" : get().inspectorContext,
    });
  },

  setInspectorContext(ctx) {
    set({ inspectorContext: ctx });
  },

  setZoomPxPerSec(pxPerSec) {
    set({ zoomPxPerSec: Math.max(20, Math.min(280, Math.round(pxPerSec))) });
  },

  markSaved() {
    set({ dirty: false });
  },

  commitEdl(label, nextEdl) {
    const current = get().edl;
    if (!current) return;
    const nextUndo = [
      ...get().undoStack.slice(-(MAX_HISTORY - 1)),
      { label, edl: cloneEdl(current) },
    ];
    const newTotal = getTotalDurationMs(nextEdl);
    set({
      edl: cloneEdl(nextEdl),
      undoStack: nextUndo,
      redoStack: [],
      playheadMs: Math.min(get().playheadMs, newTotal),
      dirty: true,
      lastActionLabel: label,
    });
  },

  mutateEdl(label, recipe) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = produce(current, recipe);
    get().commitEdl(label, nextEdl);
  },

  bladeCut(cutStartMs, cutEndMs) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = applyBladeCut(current, cutStartMs, cutEndMs);
    get().commitEdl(
      `Blade cut ${(cutStartMs / 1000).toFixed(1)}–${(cutEndMs / 1000).toFixed(1)}s`,
      nextEdl,
    );
    set({ inPointMs: null, outPointMs: null });
  },

  setWordTiming(wordId, startMs, endMs, rollingAdjacent = true) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = updateWordTiming(current, wordId, startMs, endMs, rollingAdjacent);
    get().commitEdl(`Align word ${wordId}`, nextEdl);
  },

  setWordText(wordId, text, glowColor) {
    const cleaned = text.trim();
    if (!cleaned) return;
    get().mutateEdl(`Edit word '${cleaned}'`, (draft) => {
      const target = draft.tracks.subtitles.words.find((w) => w.id === wordId);
      if (!target) return;
      target.text = cleaned;
      if (glowColor !== undefined) {
        target.glowColor = glowColor;
      }
    });
  },

  addWord(text, startMs, durationMs = 800) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = insertWord(current, text, startMs, durationMs);
    get().commitEdl(`Insert '${text.trim()}'`, nextEdl);
  },

  removeWord(wordId) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = deleteWord(current, wordId);
    get().commitEdl(`Delete word ${wordId}`, nextEdl);
    if (get().selectedWordId === wordId) {
      set({ selectedWordId: null });
    }
  },

  updateOverlay(overlayId, patch) {
    const current = get().edl;
    if (!current) return;
    const total = getTotalDurationMs(current);
    get().mutateEdl(`Edit overlay ${overlayId}`, (draft) => {
      const target = draft.tracks.overlays.find((o) => o.id === overlayId);
      if (!target) return;
      if (patch.text !== undefined) target.text = patch.text;
      if (patch.kind !== undefined) target.kind = patch.kind;
      if (patch.yAnchor !== undefined) target.yAnchor = patch.yAnchor;
      if (patch.yOffsetRatio !== undefined) {
        target.yOffsetRatio = Math.max(-0.5, Math.min(0.5, Number(patch.yOffsetRatio.toFixed(3))));
      }
      if (patch.xOffsetRatio !== undefined) {
        target.xOffsetRatio = Math.max(-0.5, Math.min(0.5, Number(patch.xOffsetRatio.toFixed(3))));
      }
      if (patch.opacity !== undefined) {
        target.opacity = Math.max(0.1, Math.min(1.0, Number(patch.opacity.toFixed(2))));
      }
      if (patch.startMs !== undefined || patch.endMs !== undefined) {
        const nextS = Math.max(
          0,
          Math.min(total - 200, Math.round(patch.startMs ?? target.startMs)),
        );
        const nextE = Math.max(
          nextS + 200,
          Math.min(total, Math.round(patch.endMs ?? target.endMs)),
        );
        target.startMs = nextS;
        target.endMs = nextE;
      }
    });
  },

  addOverlay(kind, text, startMs, endMs) {
    const current = get().edl;
    if (!current) return;
    const total = getTotalDurationMs(current);
    const id = `ov_${Date.now().toString(36)}`;
    const defaultEnd =
      kind === "pov_top_bar"
        ? Math.min(total, 3600)
        : kind === "cinema_credit"
          ? Math.min(total, 5000)
          : total;
    const s = Math.max(0, Math.min(total - 500, Math.round(startMs ?? 0)));
    const e = Math.max(s + 500, Math.min(total, Math.round(endMs ?? defaultEnd)));
    get().mutateEdl(`Add ${kind}`, (draft) => {
      draft.tracks.overlays.push({
        id,
        kind,
        text,
        startMs: s,
        endMs: e,
        yAnchor:
          kind === "seam_card_white"
            ? "split_seam"
            : kind === "cta_pill" || kind === "watermark_tag" || kind === "cinema_credit"
              ? "bottom"
              : "top",
        yOffsetRatio:
          kind === "watermark_tag"
            ? 0.06
            : kind === "cinema_credit"
              ? -0.04
              : 0,
        xOffsetRatio: 0,
        opacity: kind === "watermark_tag" ? 0.78 : 1.0,
        maxLines: kind === "cta_pill" || kind === "watermark_tag" || kind === "cinema_credit" ? 1 : 2,
      });
    });
    set({ selectedOverlayId: id, selectedWordId: null, inspectorContext: "overlay" });
  },

  removeOverlay(overlayId) {
    get().mutateEdl(`Remove overlay ${overlayId}`, (draft) => {
      draft.tracks.overlays = draft.tracks.overlays.filter((o) => o.id !== overlayId);
    });
    if (get().selectedOverlayId === overlayId) {
      set({ selectedOverlayId: null });
    }
  },

  updateFraming(patch) {
    const playhead = get().playheadMs;
    get().mutateEdl("Update framing", (draft) => {
      const active = getActiveFramingAt(draft, playhead);
      const seg =
        draft.tracks.video.framing.find((f) => f.id === active.id) ??
        draft.tracks.video.framing[0];
      if (!seg) return;
      if (patch.mode !== undefined) seg.mode = patch.mode;
      if (patch.splitRatio !== undefined) {
        seg.splitRatio = Number(Math.max(0.2, Math.min(0.65, patch.splitRatio)).toFixed(3));
      }
      if (patch.camBox !== undefined) seg.camBox = patch.camBox;
      if (patch.gameBox !== undefined) seg.gameBox = patch.gameBox;
      if (patch.fitBackdrop !== undefined) seg.fitBackdrop = patch.fitBackdrop;
      if (patch.panX !== undefined) {
        seg.panX = Number(Math.max(0, Math.min(1, patch.panX)).toFixed(3));
      }
      if (patch.panY !== undefined) {
        seg.panY = Number(Math.max(0, Math.min(1, patch.panY)).toFixed(3));
      }
      if (patch.zoom !== undefined) {
        seg.zoom = Number(Math.max(1.0, Math.min(2.5, patch.zoom)).toFixed(3));
      }
      if (patch.sourceCropBox !== undefined) seg.sourceCropBox = patch.sourceCropBox;
    });
  },

  updateAudio(patch) {
    get().mutateEdl("Update dialogue audio", (draft) => {
      const aud = draft.tracks.audio;
      if (patch.gainDb !== undefined) aud.gainDb = patch.gainDb;
      if (patch.dialogueEnhance !== undefined) aud.dialogueEnhance = patch.dialogueEnhance;
      if (patch.muteOriginal !== undefined) aud.muteOriginal = patch.muteOriginal;
      if (patch.normalizeLufs !== undefined) aud.normalizeLufs = patch.normalizeLufs;
    });
  },

  updateBgm(patch) {
    get().mutateEdl(patch ? "Update BGM track" : "Remove BGM track", (draft) => {
      if (patch === null) {
        draft.tracks.audio.bgm = null;
        return;
      }
      const prev = draft.tracks.audio.bgm;
      draft.tracks.audio.bgm = {
        assetId: patch.assetId ?? prev?.assetId ?? "dark_cinema_pulse",
        gainDb: patch.gainDb ?? prev?.gainDb ?? -15.5,
        duckingEnabled: patch.duckingEnabled ?? prev?.duckingEnabled ?? true,
        startOffsetMs: patch.startOffsetMs ?? prev?.startOffsetMs ?? 0,
        fadeInMs: patch.fadeInMs ?? prev?.fadeInMs ?? 500,
        fadeOutMs: patch.fadeOutMs ?? prev?.fadeOutMs ?? 1000,
      };
    });
  },

  updateSliceTransition(clipId, patch) {
    get().mutateEdl(`Update slice ${clipId}`, (draft) => {
      const target = draft.tracks.video.clips.find((c) => c.id === clipId);
      if (!target) return;
      if (patch.label !== undefined) target.label = patch.label;
      if (patch.transitionIn !== undefined) target.transitionIn = patch.transitionIn;
      if (patch.transitionDurationMs !== undefined) {
        target.transitionDurationMs = Math.max(80, Math.min(1000, patch.transitionDurationMs));
      }
      if (patch.transitionSfx !== undefined) target.transitionSfx = patch.transitionSfx;
    });
  },

  splitFramingAtPlayhead(rightMode) {
    const current = get().edl;
    if (!current) return;
    const nextEdl = splitFramingSegment(current, get().playheadMs, rightMode);
    get().commitEdl(
      `Split layout at ${(get().playheadMs / 1000).toFixed(1)}s`,
      nextEdl,
    );
  },

  tightenSilence(rms100hz, rateHz = 100, minGapMs = 1100) {
    const current = get().edl;
    if (!current) return { cutsApplied: 0, savedMs: 0 };
    const res = autoTightenSilence(current, {
      rms100hz,
      rateHz,
      minGapMs,
    });
    if (res.cutsApplied > 0) {
      get().commitEdl(
        `Tighten ${res.cutsApplied} pause(s) (-${(res.savedMs / 1000).toFixed(1)}s)`,
        res.edl,
      );
    }
    return { cutsApplied: res.cutsApplied, savedMs: res.savedMs };
  },

  applyAiPatchResult(nextEdl, summary) {
    const current = get().edl;
    if (!current) return;
    const previousSnapshot = cloneEdl(current);
    const label = summary.length > 0 ? `AI: ${summary[0]}` : "AI Edit";
    get().commitEdl(label, nextEdl);
    set({
      lastAiPatch: {
        summary,
        previousEdl: previousSnapshot,
      },
    });
  },

  revertLastAiPatch() {
    const patch = get().lastAiPatch;
    const current = get().edl;
    if (!patch || !current) return;
    get().commitEdl("Revert AI edit", patch.previousEdl);
    set({ lastAiPatch: null });
  },

  dismissAiPatchBanner() {
    set({ lastAiPatch: null });
  },

  undo() {
    const { undoStack, redoStack, edl } = get();
    if (!edl || undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    set({
      edl: cloneEdl(previous.edl),
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, { label: previous.label, edl: cloneEdl(edl) }],
      dirty: true,
      lastActionLabel: `Undo: ${previous.label}`,
    });
  },

  redo() {
    const { undoStack, redoStack, edl } = get();
    if (!edl || redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1];
    set({
      edl: cloneEdl(restored.edl),
      undoStack: [...undoStack, { label: restored.label, edl: cloneEdl(edl) }],
      redoStack: redoStack.slice(0, -1),
      dirty: true,
      lastActionLabel: `Redo: ${restored.label}`,
    });
  },
}));
