import { produce } from "immer";
import { create } from "zustand";
import {
  applyBladeCut,
  cloneEdl,
  deleteWord,
  getTotalDurationMs,
  insertWord,
  updateWordTiming,
  type FramingSegment,
  type OverlayItem,
  type TimelineProject,
} from "../edl";

export interface HistoryEntry {
  label: string;
  edl: TimelineProject;
}

export interface AiPatchBanner {
  summary: string[];
  previousEdl: TimelineProject;
}

export type InspectorContext = "framing" | "subtitle" | "overlay" | "export";

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
  setWordText: (wordId: string, text: string) => void;
  addWord: (text: string, startMs: number, durationMs?: number) => void;
  removeWord: (wordId: string) => void;
  updateOverlay: (
    overlayId: string,
    patch: Partial<Pick<OverlayItem, "text" | "startMs" | "endMs" | "yAnchor" | "yOffsetRatio" | "kind">>,
  ) => void;
  addOverlay: (kind: OverlayItem["kind"], text: string, startMs?: number, endMs?: number) => void;
  removeOverlay: (overlayId: string) => void;
  updateFraming: (
    patch: Partial<Pick<FramingSegment, "mode" | "splitRatio" | "camBox" | "gameBox">>,
  ) => void;

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
  inspectorContext: "framing",
  zoomPxPerSec: 90,
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

  setWordText(wordId, text) {
    const cleaned = text.trim();
    if (!cleaned) return;
    get().mutateEdl(`Edit word '${cleaned}'`, (draft) => {
      const target = draft.tracks.subtitles.words.find((w) => w.id === wordId);
      if (target) target.text = cleaned;
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
      if (patch.startMs !== undefined || patch.endMs !== undefined) {
        const nextS = Math.max(0, Math.min(total - 200, Math.round(patch.startMs ?? target.startMs)));
        const nextE = Math.max(nextS + 200, Math.min(total, Math.round(patch.endMs ?? target.endMs)));
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
    const s = Math.max(0, Math.min(total - 500, Math.round(startMs ?? 0)));
    const e = Math.max(s + 500, Math.min(total, Math.round(endMs ?? total)));
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
            : kind === "cta_pill"
              ? "bottom"
              : "top",
        yOffsetRatio: 0,
        maxLines: kind === "cta_pill" ? 1 : 2,
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
    get().mutateEdl("Update framing", (draft) => {
      const seg = draft.tracks.video.framing[0];
      if (!seg) return;
      if (patch.mode !== undefined) seg.mode = patch.mode;
      if (patch.splitRatio !== undefined) {
        seg.splitRatio = Number(Math.max(0.2, Math.min(0.65, patch.splitRatio)).toFixed(3));
      }
      if (patch.camBox !== undefined) seg.camBox = patch.camBox;
      if (patch.gameBox !== undefined) seg.gameBox = patch.gameBox;
    });
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
