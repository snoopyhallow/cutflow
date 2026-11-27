import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  FilmSlate,
  FolderOpen,
  Lightning,
  MagicWand,
  MagnifyingGlass,
  MusicNotes,
  MusicNotesPlus,
  PictureInPicture,
  Play,
  Plus,
  Sliders,
  SpeakerHigh,
  Stack,
  Subtitles,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import {
  formatTimecodeMs,
  getActiveFramingAt,
  nextEdlId,
  syncFramingToDuration,
  type OverlayItem,
  type SubtitleStyle,
  type VideoSlice,
} from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import {
  getDesktopBridge,
  type BgmAssetItem,
  type ClipProjectSummary,
  type ClipStatus,
  type SfxAssetItem,
  type SourceSummary,
  type StudioTransport,
} from "../../transport";

export type ResourceDrawerTab =
  | "media"
  | "audio"
  | "text"
  | "overlays"
  | "transitions"
  | "effects";

interface ResourceDrawerProps {
  transport: StudioTransport;
  sources: SourceSummary[];
  projects: ClipProjectSummary[];
  bgmAssets: BgmAssetItem[];
  activeProjectId: string | null;
  transcribing: boolean;
  onAutoCaptions: (language?: string) => Promise<void>;
  onSelectProject: (projectId: string) => void;
  onUpdateProjectStatus: (projectId: string, status: ClipStatus) => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
  onRefreshBgm: () => Promise<void>;
  onError: (msg: string) => void;
}

const DRAWER_TABS: {
  id: ResourceDrawerTab;
  label: string;
  icon: typeof FilmSlate;
}[] = [
  { id: "media", label: "Media", icon: FilmSlate },
  { id: "audio", label: "Audio", icon: MusicNotes },
  { id: "text", label: "Text", icon: Subtitles },
  { id: "overlays", label: "Overlays", icon: Stack },
  { id: "transitions", label: "Trans.", icon: Lightning },
  { id: "effects", label: "Effects", icon: Sliders },
];

const OVERLAY_PRESETS: {
  kind: OverlayItem["kind"];
  label: string;
  defaultText: string;
  badge: string;
}[] = [
  {
    kind: "seam_card_white",
    label: "Headline Hook (White)",
    defaultText: "Headline Hook",
    badge: "HOOK",
  },
  {
    kind: "hook_banner_dark",
    label: "Dark Hook Banner",
    defaultText: "WAIT FOR THIS...",
    badge: "DARK",
  },
  {
    kind: "pov_top_bar",
    label: "POV Top Bar",
    defaultText: "POV: WHEN IT HAPPENS",
    badge: "TOP",
  },
  {
    kind: "cta_pill",
    label: "CTA Pill Badge",
    defaultText: "Follow for Part 2",
    badge: "CTA",
  },
  {
    kind: "watermark_tag",
    label: "Creator Watermark",
    defaultText: "@CREATOR",
    badge: "TAG",
  },
  {
    kind: "cinema_credit",
    label: "Cinema Film Credit",
    defaultText: "Directed by CutFlow (2026)",
    badge: "FILM",
  },
];

const TRANSITION_PRESETS: {
  id: string;
  label: string;
  hint: string;
  transitionIn: NonNullable<VideoSlice["transitionIn"]>;
  transitionSfx: NonNullable<VideoSlice["transitionSfx"]>;
  durationMs: number;
}[] = [
  {
    id: "hard_cut",
    label: "Hard Cut",
    hint: "Instant zero-latency cut",
    transitionIn: "none",
    transitionSfx: "none",
    durationMs: 180,
  },
  {
    id: "flash_whoosh",
    label: "White Flash + Whoosh",
    hint: "High-energy creator whip flash",
    transitionIn: "flash_white",
    transitionSfx: "whoosh_flash",
    durationMs: 220,
  },
  {
    id: "flash_silent",
    label: "Clean White Flash",
    hint: "Optical exposure pop without SFX",
    transitionIn: "flash_white",
    transitionSfx: "none",
    durationMs: 200,
  },
  {
    id: "dip_sub_hit",
    label: "Dip to Black + Sub Hit",
    hint: "Dramatic cinema bass transition",
    transitionIn: "dip_black",
    transitionSfx: "cinema_hit",
    durationMs: 360,
  },
  {
    id: "dip_silent",
    label: "Cinema Dip to Black",
    hint: "Smooth fade through matte black",
    transitionIn: "dip_black",
    transitionSfx: "none",
    durationMs: 320,
  },
];

const DEFAULT_SFX_FALLBACK: SfxAssetItem[] = [
  { id: "whoosh_flash", name: "Whoosh Whip Flash", durationMs: 650, sizeBytes: 0 },
  { id: "cinema_hit", name: "Cinema Sub Impact", durationMs: 1200, sizeBytes: 0 },
];

export function ResourceDrawer({
  transport,
  sources,
  projects,
  bgmAssets,
  activeProjectId,
  transcribing,
  onAutoCaptions,
  onSelectProject,
  onUpdateProjectStatus,
  onRefreshWorkspace,
  onRefreshBgm,
  onError,
}: ResourceDrawerProps) {
  const {
    edl,
    playheadMs,
    selectedWordId,
    selectedOverlayId,
    selectedClipId,
    setPlayheadMs,
    selectWord,
    selectOverlay,
    selectClip,
    addWord,
    removeWord,
    addOverlay,
    removeOverlay,
    addBroll,
    addAudioClip,
    updateBgm,
    updateFraming,
    updateSliceTransition,
    mutateEdl,
  } = useTimelineStore();

  const [tab, setTab] = useState<ResourceDrawerTab>("media");
  const [importingMedia, setImportingMedia] = useState(false);
  const [uploadingBgm, setUploadingBgm] = useState(false);
  const [sfxList, setSfxList] = useState<SfxAssetItem[]>(DEFAULT_SFX_FALLBACK);
  const [captionLang, setCaptionLang] = useState<string>("");
  const [newWordText, setNewWordText] = useState("WAIT!");
  const [wordSearch, setWordSearch] = useState("");

  const mediaFileInputRef = useRef<HTMLInputElement | null>(null);
  const bgmFileInputRef = useRef<HTMLInputElement | null>(null);
  const desktopBridge = getDesktopBridge();

  useEffect(() => {
    let active = true;
    transport
      .listSfx()
      .then((items) => {
        if (active && items.length > 0) setSfxList(items);
      })
      .catch(() => {
        /* keep fallback SFX */
      });
    return () => {
      active = false;
    };
  }, [transport]);

  const filteredWords = useMemo(() => {
    const words = edl?.tracks.subtitles.words ?? [];
    const q = wordSearch.trim().toLowerCase();
    if (!q) return words;
    return words.filter((w) => w.text.toLowerCase().includes(q));
  }, [edl?.tracks.subtitles.words, wordSearch]);

  if (!edl) return null;

  const activeFraming = getActiveFramingAt(edl, playheadMs);

  async function handleImportMediaClick() {
    if (desktopBridge?.openMediaDialog) {
      setImportingMedia(true);
      try {
        const paths = await desktopBridge.openMediaDialog({ multiple: true });
        for (const p of paths) {
          await transport.importLocalPath(p, { autoClip: false });
        }
        if (paths.length > 0) {
          await onRefreshWorkspace();
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setImportingMedia(false);
      }
      return;
    }
    mediaFileInputRef.current?.click();
  }

  async function handleBrowserMediaPicked(file: File) {
    setImportingMedia(true);
    try {
      await transport.uploadVideo(file);
      await onRefreshWorkspace();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingMedia(false);
    }
  }

  function handleAppendSourceToV1(src: SourceSummary) {
    const clipEndMs = Math.max(1000, src.durationMs || 10_000);
    mutateEdl(`Add "${src.title}" to V1`, (draft) => {
      const isPlaceholderBlank =
        !draft.sourceId &&
        draft.tracks.video.clips.length === 1 &&
        !draft.tracks.video.clips[0].sourceId &&
        draft.tracks.subtitles.words.length === 0;

      const nextSlice: VideoSlice = {
        id: nextEdlId("slice"),
        sourceId: src.id,
        sourceStartMs: 0,
        sourceEndMs: clipEndMs,
        label: src.title.slice(0, 36),
        transitionIn: "none",
        transitionDurationMs: 200,
        transitionSfx: "none",
      };

      if (!draft.sourceId) {
        draft.sourceId = src.id;
        draft.sourceDurationMs = clipEndMs;
        if (src.width) draft.sourceWidth = src.width;
        if (src.height) draft.sourceHeight = src.height;
      }

      if (isPlaceholderBlank) {
        draft.tracks.video.clips = [nextSlice];
      } else {
        draft.tracks.video.clips.push(nextSlice);
      }
      syncFramingToDuration(draft);
    });
  }

  function handleAddSourceAsBroll(src: SourceSummary) {
    const dur = Math.min(5000, Math.max(1500, src.durationMs || 4000));
    addBroll({
      sourceId: src.id,
      sourceStartMs: 0,
      sourceEndMs: dur,
      timelineStartMs: playheadMs,
      label: src.title.slice(0, 28),
      box: { x: 0.58, y: 0.06, w: 0.36, h: 0.28 },
    });
  }

  function handlePreviewSfx(sfxId: string) {
    const url = transport.sfxMediaUrl(sfxId);
    if (!url) return;
    try {
      const audio = new Audio(url);
      audio.volume = 0.7;
      void audio.play();
    } catch {
      /* ignore autoplay errors */
    }
  }

  async function handleUploadBgmFile(file: File) {
    setUploadingBgm(true);
    try {
      const uploaded = await transport.uploadBgm(file, "", "upbeat_gaming");
      await onRefreshBgm();
      updateBgm({
        assetId: uploaded.id,
        startOffsetMs: uploaded.dropOffsetMs,
        duckingEnabled: true,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingBgm(false);
    }
  }

  function applyTransitionToTarget(
    preset: (typeof TRANSITION_PRESETS)[number],
    applyAll: boolean,
  ) {
    if (applyAll) {
      mutateEdl(`Apply ${preset.label} to all cuts`, (draft) => {
        draft.tracks.video.clips.forEach((c, idx) => {
          if (idx === 0) return;
          c.transitionIn = preset.transitionIn;
          c.transitionSfx = preset.transitionSfx;
          c.transitionDurationMs = preset.durationMs;
        });
      });
      return;
    }

    const targetClip =
      edl?.tracks.video.clips.find((c) => c.id === selectedClipId) ??
      edl?.tracks.video.clips[1] ??
      edl?.tracks.video.clips[0];
    if (!targetClip) return;
    selectClip(targetClip.id);
    updateSliceTransition(targetClip.id, {
      transitionIn: preset.transitionIn,
      transitionSfx: preset.transitionSfx,
      transitionDurationMs: preset.durationMs,
    });
  }

  return (
    <section className="flex h-full flex-col border-r border-[#222228] bg-[#111114]">
      <input
        ref={mediaFileInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleBrowserMediaPicked(f);
          e.target.value = "";
        }}
      />
      <input
        ref={bgmFileInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.aac,.ogg,.flac"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadBgmFile(f);
          e.target.value = "";
        }}
      />

      {/* 6-Tab CapCut Resource Strip */}
      <div className="grid grid-cols-6 border-b border-[#222228] bg-[#0C0C0F]">
        {DRAWER_TABS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex flex-col items-center justify-center gap-0.5 border-b-2 py-2 text-[10px] font-medium transition-colors ${
                active
                  ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                  : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Drawer Content Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 text-xs">
        {/* 1. MEDIA BIN & PROJECT CLIPS */}
        {tab === "media" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                  Local Media Bin ({sources.length})
                </span>
                <button
                  type="button"
                  disabled={importingMedia}
                  onClick={() => void handleImportMediaClick()}
                  className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-2.5 py-1 text-[11px] font-semibold text-[#09090B] hover:bg-[#FBBF24] disabled:opacity-45"
                >
                  {importingMedia ? (
                    <CircleNotch className="h-3 w-3 animate-spin" />
                  ) : desktopBridge ? (
                    <FolderOpen weight="bold" className="h-3 w-3" />
                  ) : (
                    <UploadSimple weight="bold" className="h-3 w-3" />
                  )}
                  Import
                </button>
              </div>

              {sources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#272730] bg-[#09090B]/70 p-3 text-center text-[11px] text-[#71717A]">
                  Import an MP4, MKV, MOV, or WebM file to place clips onto V1 or V2 B-Roll.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {sources.map((src) => (
                    <div
                      key={src.id}
                      className="rounded-md border border-[#22222A] bg-[#09090B]/80 p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-[#F4F4F5]">
                          {src.title}
                        </span>
                        <span className="tabular-tc shrink-0 text-[10px] text-[#71717A]">
                          {formatTimecodeMs(src.durationMs)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleAppendSourceToV1(src)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-[#2D2D37] bg-[#16161C] px-2 py-1 text-[10px] font-medium text-[#E4E4E7] hover:border-[#F59E0B]/60 hover:text-white"
                        >
                          <Plus className="h-2.5 w-2.5 text-[#F59E0B]" />
                          Track V1
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAddSourceAsBroll(src)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-[#2D2D37] bg-[#16161C] px-2 py-1 text-[10px] font-medium text-[#E4E4E7] hover:border-[#38BDF8]/60 hover:text-white"
                        >
                          <PictureInPicture className="h-3 w-3 text-[#38BDF8]" />
                          PiP V2
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5 border-t border-[#222228] pt-3">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Workspace Timelines ({projects.length})
              </span>
              {projects.map((p) => {
                const active = p.id === activeProjectId;
                return (
                  <div
                    key={p.id}
                    onClick={() => onSelectProject(p.id)}
                    className={`cursor-pointer rounded-md border p-2 transition-colors ${
                      active
                        ? "border-[#F59E0B] bg-[#18181E] text-[#F4F4F5]"
                        : "border-[#222228] bg-[#09090B]/70 text-[#D4D4D8] hover:border-[#32323C]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate font-medium">{p.title}</span>
                      <span className="tabular-tc shrink-0 text-[10px] text-[#71717A]">
                        {formatTimecodeMs(p.totalDurationMs)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="tabular-tc text-[10px] uppercase text-[#71717A]">
                        {p.status} · {p.wordCount}w
                      </span>
                      {p.status !== "approved" && p.status !== "posted" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onUpdateProjectStatus(p.id, "approved");
                          }}
                          className="inline-flex items-center gap-1 rounded border border-[#22C55E]/35 bg-[#22C55E]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[#4ADE80] hover:bg-[#22C55E]/20"
                        >
                          <CheckCircle className="h-2.5 w-2.5" />
                          Approve
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. AUDIO & SFX BIN */}
        {tab === "audio" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Sound Effects · Track A3
              </span>
              <div className="space-y-1.5">
                {sfxList.map((sfx) => (
                  <div
                    key={sfx.id}
                    className="flex items-center justify-between rounded-md border border-[#22222A] bg-[#09090B] p-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[#F4F4F5]">
                        {sfx.name}
                      </div>
                      <div className="tabular-tc text-[10px] text-[#71717A]">
                        {(sfx.durationMs / 1000).toFixed(2)}s · Drop at{" "}
                        {formatTimecodeMs(playheadMs)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handlePreviewSfx(sfx.id)}
                        title="Preview SFX"
                        className="rounded border border-[#2C2C36] bg-[#16161C] p-1.5 text-[#A1A1AA] hover:text-white"
                      >
                        <Play weight="fill" className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          addAudioClip({
                            kind: "sfx",
                            assetId: sfx.id,
                            label: sfx.name,
                            timelineStartMs: playheadMs,
                            sourceStartMs: 0,
                            sourceEndMs: sfx.durationMs || 800,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded bg-[#F59E0B] px-2 py-1 text-[10px] font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                      >
                        <Plus weight="bold" className="h-3 w-3" />
                        A3
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 border-t border-[#222228] pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                  BGM Library · Track A2
                </span>
                <button
                  type="button"
                  disabled={uploadingBgm}
                  onClick={() => bgmFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded border border-[#2C2C36] bg-[#18181E] px-2 py-0.5 text-[10px] font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60"
                >
                  {uploadingBgm ? (
                    <CircleNotch className="h-3 w-3 animate-spin" />
                  ) : (
                    <MusicNotesPlus className="h-3 w-3 text-[#F59E0B]" />
                  )}
                  Upload BGM
                </button>
              </div>

              <div className="space-y-1.5">
                {bgmAssets.map((asset) => {
                  const isActive = edl.tracks.audio.bgm?.assetId === asset.id;
                  return (
                    <div
                      key={asset.id}
                      className={`flex items-center justify-between rounded-md border p-2 ${
                        isActive
                          ? "border-[#F59E0B] bg-[#F59E0B]/10"
                          : "border-[#22222A] bg-[#09090B]"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[#F4F4F5]">
                          {asset.name}
                        </div>
                        <div className="tabular-tc text-[10px] text-[#71717A]">
                          {asset.mood} · {(asset.durationMs / 1000).toFixed(0)}s
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          updateBgm(
                            isActive
                              ? null
                              : {
                                  assetId: asset.id,
                                  startOffsetMs: asset.dropOffsetMs,
                                  gainDb: -16,
                                  duckingEnabled: true,
                                },
                          )
                        }
                        className={`rounded px-2 py-1 text-[10px] font-semibold ${
                          isActive
                            ? "border border-[#3F3F46] bg-[#18181C] text-[#F4F4F5]"
                            : "bg-[#22222C] text-[#E4E4E7] hover:bg-[#F59E0B] hover:text-[#09090B]"
                        }`}
                      >
                        {isActive ? "Active" : "Use BGM"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* 3. TEXT & AUTO-CAPTIONS */}
        {tab === "text" && (
          <div className="space-y-3">
            {/* Auto-Captions Hero Action */}
            <div className="space-y-2 rounded-lg border border-[#F59E0B]/35 bg-[#17140E] p-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#FBBF24]">
                  <MagicWand weight="fill" className="h-3.5 w-3.5" />
                  AI Auto-Captions
                </span>
                <span className="tabular-tc text-[10px] text-[#A1A1AA]">
                  {edl.tracks.subtitles.words.length} words
                </span>
              </div>
              <p className="text-[10px] leading-relaxed text-[#A1A1AA]">
                Runs local offline Whisper (`int8` GPU/CPU) with Gemini Audio fallback to
                sync word-by-word subtitles.
              </p>
              <div className="flex items-center gap-1.5">
                <select
                  aria-label="Transcription Language"
                  value={captionLang}
                  onChange={(e) => setCaptionLang(e.target.value)}
                  className="rounded border border-[#2C2C36] bg-[#09090B] px-2 py-1 text-[11px] text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                >
                  <option value="">Auto-Detect</option>
                  <option value="en">English (en)</option>
                  <option value="tl">Tagalog / Filipino (tl)</option>
                  <option value="es">Spanish (es)</option>
                  <option value="ja">Japanese (ja)</option>
                  <option value="ko">Korean (ko)</option>
                </select>
                <button
                  type="button"
                  disabled={transcribing}
                  onClick={() => void onAutoCaptions(captionLang || undefined)}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-[#F59E0B] px-2.5 py-1 text-[11px] font-bold text-[#09090B] hover:bg-[#FBBF24] disabled:opacity-45"
                >
                  {transcribing ? (
                    <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Subtitles weight="bold" className="h-3.5 w-3.5" />
                  )}
                  {transcribing ? "Transcribing..." : "Generate Captions"}
                </button>
              </div>
            </div>

            {/* Quick Caption Style Presets */}
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ["cinema_neon_glow", "Cinema Neon"],
                  ["viral_punch_glow", "Viral Punch"],
                  ["bold_pop", "Bold Pop"],
                  ["karaoke_fill", "Karaoke Fill"],
                ] as const
              ).map(([presetId, label]) => {
                const active = edl.tracks.subtitles.style.preset === presetId;
                return (
                  <button
                    key={presetId}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Caption preset → ${label}`, (d) => {
                        d.tracks.subtitles.enabled = true;
                        d.tracks.subtitles.style.preset =
                          presetId as SubtitleStyle["preset"];
                      })
                    }
                    className={`rounded border px-2 py-1.5 text-left text-[10px] font-semibold transition-colors ${
                      active
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Insert Word + Filter */}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newWordText}
                onChange={(e) => setNewWordText(e.target.value)}
                placeholder="Word at playhead..."
                className="min-w-0 flex-1 rounded border border-[#222228] bg-[#09090B] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newWordText.trim()) return;
                  addWord(newWordText.trim(), playheadMs, 650);
                  setNewWordText("");
                }}
                className="inline-flex items-center gap-1 rounded border border-[#2E2E38] bg-[#18181E] px-2 py-1 text-[11px] font-semibold text-[#F4F4F5] hover:border-[#F59E0B]"
              >
                <Plus className="h-3 w-3 text-[#F59E0B]" />
                Word
              </button>
            </div>

            {edl.tracks.subtitles.words.length > 6 && (
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#71717A]" />
                <input
                  type="text"
                  value={wordSearch}
                  onChange={(e) => setWordSearch(e.target.value)}
                  placeholder="Filter transcript words..."
                  className="w-full rounded border border-[#222228] bg-[#09090B] py-1 pl-6 pr-2 text-[11px] text-[#F4F4F5] placeholder-[#71717A] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>
            )}

            <div className="space-y-1">
              {filteredWords.map((w) => {
                const isSelected = selectedWordId === w.id;
                const isPlaying = playheadMs >= w.startMs && playheadMs <= w.endMs;
                return (
                  <div
                    key={w.id}
                    onClick={() => {
                      selectWord(w.id);
                      setPlayheadMs(w.startMs);
                    }}
                    className={`flex cursor-pointer items-center justify-between rounded border px-2 py-1 text-xs transition-colors ${
                      isSelected
                        ? "border-[#F59E0B] bg-[#F59E0B]/12 text-[#F4F4F5]"
                        : isPlaying
                          ? "border-[#3F3F46] bg-[#1C1C22] text-[#F4F4F5]"
                          : "border-[#1E1E24] bg-[#09090B]/70 text-[#D4D4D8] hover:border-[#2E2E38]"
                    }`}
                  >
                    <span className="truncate font-medium">{w.text}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="tabular-tc text-[10px] text-[#71717A]">
                        {formatTimecodeMs(w.startMs)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeWord(w.id);
                        }}
                        className="text-[#71717A] hover:text-[#EF4444]"
                      >
                        <Trash className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 4. OVERLAYS & GRAPHICS */}
        {tab === "overlays" && (
          <div className="space-y-3">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
              Graphic Stickers &amp; Hooks · Track G1
            </span>
            <div className="grid grid-cols-1 gap-1.5">
              {OVERLAY_PRESETS.map((ov) => (
                <button
                  key={ov.kind}
                  type="button"
                  onClick={() => addOverlay(ov.kind, ov.defaultText)}
                  className="flex items-center justify-between rounded-md border border-[#24242E] bg-[#09090B] px-2.5 py-2 text-left transition-colors hover:border-[#F59E0B]/60 hover:bg-[#14141A]"
                >
                  <div>
                    <div className="text-xs font-semibold text-[#F4F4F5]">
                      {ov.label}
                    </div>
                    <div className="text-[10px] text-[#71717A]">
                      &ldquo;{ov.defaultText}&rdquo;
                    </div>
                  </div>
                  <span className="tabular-tc rounded border border-[#2E2E3A] bg-[#16161D] px-1.5 py-0.5 text-[9px] font-bold text-[#F59E0B]">
                    + {ov.badge}
                  </span>
                </button>
              ))}
            </div>

            {edl.tracks.overlays.length > 0 && (
              <div className="space-y-1.5 border-t border-[#222228] pt-3">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#71717A]">
                  Active Overlays ({edl.tracks.overlays.length})
                </span>
                {edl.tracks.overlays.map((ov) => (
                  <div
                    key={ov.id}
                    onClick={() => selectOverlay(ov.id)}
                    className={`flex cursor-pointer items-center justify-between rounded border px-2 py-1.5 ${
                      selectedOverlayId === ov.id
                        ? "border-[#F59E0B] bg-[#F59E0B]/12 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#D4D4D8]"
                    }`}
                  >
                    <span className="truncate font-medium">{ov.text}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeOverlay(ov.id);
                      }}
                      className="text-[#71717A] hover:text-[#EF4444]"
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 5. SCENE TRANSITIONS */}
        {tab === "transitions" && (
          <div className="space-y-3">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
              Scene Cut Transitions
            </span>
            <p className="text-[10px] text-[#71717A]">
              Split a clip (`Ctrl+B` or Razor `B`) then apply optical flashes, dips, and SFX hits.
            </p>
            <div className="space-y-2">
              {TRANSITION_PRESETS.map((tr) => (
                <div
                  key={tr.id}
                  className="space-y-1.5 rounded-md border border-[#24242E] bg-[#09090B] p-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#F4F4F5]">{tr.label}</span>
                    <span className="tabular-tc text-[10px] text-[#71717A]">
                      {tr.durationMs}ms
                    </span>
                  </div>
                  <p className="text-[10px] text-[#71717A]">{tr.hint}</p>
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => applyTransitionToTarget(tr, false)}
                      className="flex-1 rounded border border-[#2E2E38] bg-[#16161D] px-2 py-1 text-[10px] font-semibold text-[#E4E4E7] hover:border-[#F59E0B]"
                    >
                      Apply to Clip
                    </button>
                    <button
                      type="button"
                      onClick={() => applyTransitionToTarget(tr, true)}
                      className="rounded border border-[#2E2E38] bg-[#16161D] px-2 py-1 text-[10px] font-semibold text-[#A1A1AA] hover:border-[#F59E0B] hover:text-white"
                    >
                      All Cuts
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 6. CANVAS EFFECTS & GRADING */}
        {tab === "effects" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Canvas Aspect Ratio
              </span>
              <div className="grid grid-cols-4 gap-1">
                {(["9:16", "4:5", "1:1", "16:9"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Ratio → ${r}`, (d) => {
                        d.output.ratio = r;
                      })
                    }
                    className={`tabular-tc rounded border py-1.5 text-[11px] font-semibold ${
                      edl.output.ratio === r
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {activeFraming && (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                  Shot Layout Preset
                </span>
                <div className="grid grid-cols-3 gap-1">
                  {(
                    [
                      ["split", "Split Cam"],
                      ["fit", "Fit Blur"],
                      ["crop", "Pan/Zoom"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => updateFraming({ mode })}
                      className={`rounded border py-1.5 text-[10px] font-semibold ${
                        activeFraming.mode === mode
                          ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                          : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Cinema Color Grade
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    ["off", "Natural Rec.709"],
                    ["crisp_hd", "Crisp HD Contrast"],
                  ] as const
                ).map(([grade, label]) => (
                  <button
                    key={grade}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Grade → ${label}`, (d) => {
                        d.output.cinemaGrade = grade;
                      })
                    }
                    className={`rounded border px-2 py-2 text-left text-[10px] font-semibold ${
                      (edl.output.cinemaGrade ?? "off") === grade
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Cinema Matte Frame
              </span>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ["none", "Borderless"],
                    ["thin_rounded", "Rounded"],
                    ["double_cinema", "Double"],
                  ] as const
                ).map(([bs, label]) => (
                  <button
                    key={bs}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Frame → ${label}`, (d) => {
                        d.output.borderStyle = bs;
                      })
                    }
                    className={`rounded border py-1.5 text-[10px] font-semibold ${
                      (edl.output.borderStyle ?? "none") === bs
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-[#22222A] bg-[#09090B] p-2.5">
              <div className="flex items-center gap-2 text-[11px] text-[#D4D4D8]">
                <SpeakerHigh className="h-4 w-4 text-[#F59E0B]" />
                <span>Audio Mastering: -14 LUFS EBU R128</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
