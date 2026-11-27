import { useRef, useState } from "react";
import {
  CircleNotch,
  Copy,
  Export,
  FrameCorners,
  MusicNotes,
  MusicNotesPlus,
  PictureInPicture,
  Plus,
  PushPin,
  Snowflake,
  SpeakerHigh,
  SplitVertical,
  Stack,
  Subtitles,
  Trash,
} from "@phosphor-icons/react";
import {
  getActiveFramingAt,
  type NormalizedBox,
  type OutputSettings,
  type OverlayItem,
  type SubtitleStyle,
  type VideoSlice,
} from "../../edl";
import {
  useTimelineStore,
  type InspectorContext,
} from "../../state/timelineStore";
import type { BgmAssetItem, StudioTransport } from "../../transport";
import { formatDbLabel } from "../../utils/audioMath";
import {
  ScrubNumber,
  ScrubSlider,
  SegmentedControl,
  StudioSelect,
  StudioToggle,
} from "../ui/StudioControls";

interface ContextInspectorProps {
  transport: StudioTransport;
  bgmAssets: BgmAssetItem[];
  onRefreshBgm: () => Promise<void>;
  canExport: boolean;
  exportingNow: boolean;
  onExportNow: () => Promise<void>;
  onError: (msg: string) => void;
  onPinWebcam?: (camBox: NormalizedBox, splitRatio: number) => Promise<void>;
}

const INSPECTOR_TABS: {
  id: InspectorContext;
  label: string;
  icon: typeof FrameCorners;
}[] = [
  { id: "framing", label: "Frame", icon: FrameCorners },
  { id: "audio", label: "Audio", icon: SpeakerHigh },
  { id: "subtitle", label: "Captions", icon: Subtitles },
  { id: "overlay", label: "Overlays", icon: Stack },
  { id: "export", label: "Render", icon: Export },
];

const PUNCH_GLOW_SWATCHES = [
  { label: "None", hex: "" },
  { label: "Blue", hex: "#4F7CFF" },
  { label: "Green", hex: "#4ADE80" },
  { label: "Gold", hex: "#FBBF24" },
  { label: "Coral", hex: "#F87171" },
  { label: "Rose", hex: "#F472B6" },
];

const SPEED_PRESETS = [0.5, 1, 1.25, 1.5, 2];

export function ContextInspector({
  transport,
  bgmAssets,
  onRefreshBgm,
  canExport,
  exportingNow,
  onExportNow,
  onError,
  onPinWebcam,
}: ContextInspectorProps) {
  const {
    edl,
    playheadMs,
    inspectorContext,
    selectedWordId,
    selectedOverlayId,
    selectedClipId,
    selectedBrollId,
    selectedAudioClipId,
    lastActionLabel,
    setInspectorContext,
    selectOverlay,
    selectClip,
    selectBroll,
    selectAudioClip,
    mutateEdl,
    updateFraming,
    updateAudio,
    updateBgm,
    updateClipProps,
    insertFreezeFrame,
    detachAudioFromClip,
    updateBroll,
    removeBroll,
    updateAudioClip,
    removeAudioClip,
    updateSliceTransition,
    splitFramingAtPlayhead,
    setWordTiming,
    setWordText,
    removeWord,
    updateOverlay,
    addOverlay,
    duplicateOverlay,
    removeOverlay,
  } = useTimelineStore();

  const bgmFileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingBgm, setUploadingBgm] = useState(false);

  if (!edl) return null;

  const framing = getActiveFramingAt(edl, playheadMs);
  const selectedWord =
    edl.tracks.subtitles.words.find((w) => w.id === selectedWordId) ?? null;
  const selectedOverlay =
    edl.tracks.overlays.find((o) => o.id === selectedOverlayId) ??
    edl.tracks.overlays[0] ??
    null;
  const activeClip =
    edl.tracks.video.clips.find((c) => c.id === selectedClipId) ??
    edl.tracks.video.clips[0] ??
    null;
  const brollList = edl.tracks.video.broll ?? [];
  const activeBroll =
    brollList.find((b) => b.id === selectedBrollId) ?? brollList[0] ?? null;
  const audioClips = edl.tracks.audio.clips ?? [];
  const activeAudioClip =
    audioClips.find((a) => a.id === selectedAudioClipId) ?? audioClips[0] ?? null;
  const bgm = edl.tracks.audio.bgm ?? null;

  async function handleBgmUpload(file: File) {
    setUploadingBgm(true);
    try {
      const moodHint =
        edl?.output.ratio === "1:1" ? "dark_cinema" : "upbeat_gaming";
      const uploaded = await transport.uploadBgm(file, "", moodHint);
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

  return (
    <section className="flex h-full flex-col bg-[#111114]">
      {/* 5-Tab Studio Strip */}
      <div className="grid grid-cols-5 border-b border-[#222228] bg-[#0C0C0F]">
        {INSPECTOR_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = inspectorContext === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setInspectorContext(tab.id)}
              className={`flex flex-col items-center justify-center gap-0.5 border-b-2 py-2 text-[10px] font-medium transition-colors ${
                active
                  ? "border-[#F59E0B] bg-[#111114] text-[#F4F4F5]"
                  : "border-transparent text-[#71717A] hover:text-[#D4D4D8]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Inspector Controls Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {/* 1. FRAME & CLIP TAB */}
        {inspectorContext === "framing" && framing && (
          <>
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium text-[#A1A1AA]">
                Framing Mode
              </span>
              <SegmentedControl
                value={framing.mode === "centre" ? "crop" : framing.mode}
                onChange={(m) =>
                  updateFraming({
                    mode: m,
                    camBox:
                      m === "split" && !framing.camBox
                        ? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 }
                        : framing.camBox,
                  })
                }
                options={[
                  { value: "split", label: "Split Cam" },
                  { value: "fit", label: "Fit Frame" },
                  { value: "crop", label: "Pan & Zoom" },
                ]}
              />
            </div>

            {framing.mode === "split" && (
              <ScrubSlider
                label="Split Seam Ratio"
                min={20}
                max={65}
                step={1}
                value={Math.round(framing.splitRatio * 100)}
                displayValue={`${Math.round(framing.splitRatio * 100)}%`}
                onChange={(v) => updateFraming({ splitRatio: v / 100 })}
              />
            )}

            {framing.mode === "fit" && (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-medium text-[#A1A1AA]">
                  Letterbox Backdrop
                </span>
                <SegmentedControl
                  value={framing.fitBackdrop ?? "blur"}
                  onChange={(fb) => updateFraming({ fitBackdrop: fb })}
                  options={[
                    { value: "blur", label: "Soft Blur" },
                    { value: "black", label: "Cinema Matte Black" },
                  ]}
                />
              </div>
            )}

            {(framing.mode === "crop" || framing.mode === "centre") && (
              <div className="space-y-3 rounded-md border border-[#222228] bg-[#09090B]/60 p-2.5">
                <ScrubSlider
                  label="Optical Zoom"
                  min={1.0}
                  max={2.2}
                  step={0.02}
                  value={framing.zoom ?? 1.0}
                  displayValue={`${(framing.zoom ?? 1.0).toFixed(2)}×`}
                  onChange={(z) => updateFraming({ zoom: z })}
                />
                <ScrubSlider
                  label="Focus Pan X"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round((framing.panX ?? 0.5) * 100)}
                  displayValue={`${Math.round((framing.panX ?? 0.5) * 100)}%`}
                  onChange={(px) => updateFraming({ panX: px / 100 })}
                />
                <ScrubSlider
                  label="Focus Pan Y"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round((framing.panY ?? 0.5) * 100)}
                  displayValue={`${Math.round((framing.panY ?? 0.5) * 100)}%`}
                  onChange={(py) => updateFraming({ panY: py / 100 })}
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => {
                  try {
                    splitFramingAtPlayhead();
                  } catch {
                    onError("Move playhead inside a framing segment to insert a keyframe.");
                  }
                }}
                className="flex items-center justify-center gap-1.5 rounded-md border border-[#282830] bg-[#18181C] px-2.5 py-1.5 text-[11px] font-medium text-[#D4D4D8] hover:border-[#F59E0B]/60 hover:text-white"
              >
                <SplitVertical className="h-3.5 w-3.5 text-[#F59E0B]" />
                Add Shot Keyframe ({edl.tracks.video.framing.length})
              </button>

              {framing.mode === "split" && framing.camBox && onPinWebcam && (
                <button
                  type="button"
                  onClick={() => void onPinWebcam(framing.camBox!, framing.splitRatio)}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-[#22C55E]/35 bg-[#22C55E]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#86EFAC] hover:bg-[#22C55E]/18"
                >
                  <PushPin className="h-3.5 w-3.5" />
                  Pin Facecam to Profile
                </button>
              )}
            </div>

            {/* Selected V1 Clip Speed, Reverse, Freeze & Transition Controls */}
            {activeClip && (
              <div className="space-y-3 border-t border-[#222228] pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                    Selected Clip · Track V1
                  </span>
                  <span className="tabular-tc text-[10px] text-[#71717A]">
                    {edl.tracks.video.clips.length}{" "}
                    {edl.tracks.video.clips.length === 1 ? "clip" : "clips"}
                  </span>
                </div>

                {edl.tracks.video.clips.length > 1 && (
                  <StudioSelect
                    ariaLabel="Selected Video Clip"
                    value={activeClip.id}
                    onChange={(cid) => selectClip(cid)}
                    options={edl.tracks.video.clips.map((c, idx) => ({
                      value: c.id,
                      label: c.label || `Scene ${idx + 1}`,
                      hint: `${((c.sourceEndMs - c.sourceStartMs) / 1000 / (c.speed ?? 1)).toFixed(1)}s`,
                    }))}
                  />
                )}

                <div className="space-y-2.5 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                  <ScrubSlider
                    label="Clip Speed"
                    min={0.25}
                    max={4.0}
                    step={0.05}
                    value={activeClip.speed ?? 1}
                    displayValue={`${(activeClip.speed ?? 1).toFixed(2)}×`}
                    onChange={(spd) => updateClipProps(activeClip.id, { speed: spd })}
                  />

                  <div className="flex items-center gap-1">
                    {SPEED_PRESETS.map((spd) => (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => updateClipProps(activeClip.id, { speed: spd })}
                        className={`tabular-tc flex-1 rounded border py-0.5 text-[10px] font-semibold ${
                          Math.abs((activeClip.speed ?? 1) - spd) < 0.03
                            ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                            : "border-[#22222A] bg-[#141418] text-[#A1A1AA] hover:text-white"
                        }`}
                      >
                        {spd}×
                      </button>
                    ))}
                  </div>

                  <StudioToggle
                    label="Reverse Playback"
                    checked={Boolean(activeClip.reverse)}
                    onChange={(rev) => updateClipProps(activeClip.id, { reverse: rev })}
                  />

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => insertFreezeFrame(playheadMs, 1500)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-[#2C2C36] bg-[#16161D] px-2 py-1 text-[10px] font-medium text-[#E4E4E7] hover:border-[#38BDF8]/60"
                    >
                      <Snowflake className="h-3 w-3 text-[#38BDF8]" />
                      Freeze 1.5s
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(activeClip.audioDetached)}
                      onClick={() => detachAudioFromClip(activeClip.id)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-[#2C2C36] bg-[#16161D] px-2 py-1 text-[10px] font-medium text-[#E4E4E7] hover:border-[#F59E0B]/60 disabled:opacity-40"
                    >
                      <MusicNotes className="h-3 w-3 text-[#F59E0B]" />
                      {activeClip.audioDetached ? "Detached" : "Detach Audio"}
                    </button>
                  </div>

                  {edl.tracks.video.clips[0]?.id !== activeClip.id && (
                    <div className="space-y-2 border-t border-[#1E1E24] pt-2">
                      <span className="block text-[10px] text-[#A1A1AA]">
                        Incoming Cut Transition
                      </span>
                      <SegmentedControl
                        size="xs"
                        value={activeClip.transitionIn ?? "none"}
                        onChange={(t) =>
                          updateSliceTransition(activeClip.id, {
                            transitionIn: t as VideoSlice["transitionIn"],
                          })
                        }
                        options={[
                          { value: "none", label: "Hard Cut" },
                          { value: "flash_white", label: "White Flash" },
                          { value: "dip_black", label: "Dip Black" },
                        ]}
                      />

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="mb-1 block text-[10px] text-[#A1A1AA]">SFX Hit</span>
                          <StudioSelect
                            value={activeClip.transitionSfx ?? "none"}
                            onChange={(sfx) =>
                              updateSliceTransition(activeClip.id, {
                                transitionSfx: sfx as VideoSlice["transitionSfx"],
                              })
                            }
                            options={[
                              { value: "none", label: "Silent" },
                              { value: "whoosh_flash", label: "Whoosh" },
                              { value: "cinema_hit", label: "Sub Hit" },
                            ]}
                          />
                        </div>
                        <ScrubNumber
                          label="Duration"
                          unit="ms"
                          min={80}
                          max={800}
                          step={20}
                          value={activeClip.transitionDurationMs ?? 240}
                          onChange={(ms) =>
                            updateSliceTransition(activeClip.id, {
                              transitionDurationMs: ms,
                            })
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* V2 B-Roll Picture-in-Picture Inspector */}
            {activeBroll && (
              <div className="space-y-2.5 border-t border-[#222228] pt-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#38BDF8]">
                    <PictureInPicture className="h-3.5 w-3.5" />
                    B-Roll PiP · Track V2
                  </span>
                  <button
                    type="button"
                    onClick={() => removeBroll(activeBroll.id)}
                    className="text-[#A1A1AA] hover:text-[#EF4444]"
                    title="Delete B-Roll clip"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>

                {brollList.length > 1 && (
                  <StudioSelect
                    ariaLabel="Selected B-Roll"
                    value={activeBroll.id}
                    onChange={(bid) => selectBroll(bid)}
                    options={brollList.map((b, i) => ({
                      value: b.id,
                      label: b.label || `B-Roll ${i + 1}`,
                    }))}
                  />
                )}

                <div className="space-y-2.5 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                  <ScrubSlider
                    label="PiP Opacity"
                    min={10}
                    max={100}
                    step={5}
                    value={Math.round((activeBroll.opacity ?? 1) * 100)}
                    displayValue={`${Math.round((activeBroll.opacity ?? 1) * 100)}%`}
                    onChange={(op) => updateBroll(activeBroll.id, { opacity: op / 100 })}
                  />
                  <ScrubSlider
                    label="PiP Width"
                    min={15}
                    max={100}
                    step={1}
                    value={Math.round((activeBroll.box?.w ?? 0.4) * 100)}
                    displayValue={`${Math.round((activeBroll.box?.w ?? 0.4) * 100)}%`}
                    onChange={(w) => {
                      const prev = activeBroll.box ?? { x: 0.56, y: 0.06, w: 0.38, h: 0.28 };
                      updateBroll(activeBroll.id, {
                        box: { ...prev, w: w / 100, h: Math.min(1, (w / 100) * 0.75) },
                      });
                    }}
                  />
                  <ScrubSlider
                    label="B-Roll Gain"
                    min={-60}
                    max={12}
                    step={0.5}
                    value={activeBroll.gainDb ?? -60}
                    displayValue={formatDbLabel(activeBroll.gainDb ?? -60)}
                    onChange={(db) =>
                      updateBroll(activeBroll.id, { gainDb: db, muted: db <= -59.5 })
                    }
                  />
                </div>
              </div>
            )}

            {/* Cold-Open Hook */}
            <div className="space-y-2.5 border-t border-[#222228] pt-3">
              <StudioToggle
                label="Cold-Open Flash-Forward"
                hint="Tease climax at 0:00 before Scene 1"
                checked={Boolean(edl.tracks.video.coldOpen?.enabled)}
                onChange={(enabled) => {
                  mutateEdl(enabled ? "Enable cold open" : "Disable cold open", (draft) => {
                    if (!enabled) {
                      draft.tracks.video.coldOpen = null;
                    } else {
                      const clip = draft.tracks.video.clips[0];
                      const srcMid = Math.round(
                        clip.sourceStartMs + (clip.sourceEndMs - clip.sourceStartMs) * 0.6,
                      );
                      draft.tracks.video.coldOpen = {
                        enabled: true,
                        sourceStartMs: Math.max(0, srcMid),
                        durationMs: 1500,
                        fadeOutMs: 120,
                      };
                    }
                  });
                }}
              />

              {edl.tracks.video.coldOpen?.enabled && (
                <ScrubSlider
                  label="Hook Duration"
                  min={500}
                  max={3500}
                  step={100}
                  value={edl.tracks.video.coldOpen.durationMs}
                  displayValue={`${(edl.tracks.video.coldOpen.durationMs / 1000).toFixed(2)}s`}
                  onChange={(ms) => {
                    mutateEdl("Adjust cold-open duration", (draft) => {
                      if (draft.tracks.video.coldOpen) {
                        draft.tracks.video.coldOpen.durationMs = ms;
                      }
                    });
                  }}
                />
              )}
            </div>
          </>
        )}

        {/* 2. AUDIO, CLIP GAIN & BGM TAB */}
        {inspectorContext === "audio" && (
          <>
            <div className="space-y-3">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                Dialogue &amp; Source Stem (Track V1/A1)
              </span>

              <ScrubSlider
                label="Dialogue Gain"
                min={-60}
                max={12}
                step={0.5}
                value={edl.tracks.audio.gainDb}
                displayValue={formatDbLabel(edl.tracks.audio.gainDb)}
                onChange={(v) => updateAudio({ gainDb: v })}
              />

              <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    [-60, "Mute -∞"],
                    [-12, "-12 dB"],
                    [0, "0 dB"],
                    [6, "+6 dB"],
                  ] as const
                ).map(([db, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => updateAudio({ gainDb: db })}
                    className={`tabular-tc rounded border py-0.5 text-[10px] font-semibold ${
                      Math.abs(edl.tracks.audio.gainDb - db) < 0.3
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#22222A] bg-[#09090B] text-[#A1A1AA] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <StudioToggle
                label="Vocal Clarity & 5.1 Isolation"
                hint="85Hz high-pass + 2.8kHz presence boost"
                checked={Boolean(edl.tracks.audio.dialogueEnhance)}
                onChange={(v) => updateAudio({ dialogueEnhance: v })}
              />

              <StudioToggle
                label="Mute Original Source Audio"
                hint="Music-only montage mode"
                checked={Boolean(edl.tracks.audio.muteOriginal)}
                onChange={(v) => updateAudio({ muteOriginal: v })}
              />
            </div>

            {/* Per-Clip V1 Audio Controls */}
            {activeClip && (
              <div className="space-y-2.5 border-t border-[#222228] pt-3">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                  Selected Clip Volume ({activeClip.label || "Scene"})
                </span>

                <div className="space-y-2.5 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                  <ScrubSlider
                    label="Clip Gain Trim"
                    min={-60}
                    max={12}
                    step={0.5}
                    value={activeClip.gainDb ?? 0}
                    displayValue={formatDbLabel(activeClip.gainDb ?? 0)}
                    onChange={(db) => updateClipProps(activeClip.id, { gainDb: db })}
                  />
                  <StudioToggle
                    label="Mute Selected Clip"
                    checked={Boolean(activeClip.muted)}
                    onChange={(m) => updateClipProps(activeClip.id, { muted: m })}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <ScrubNumber
                      label="Fade In"
                      unit="ms"
                      min={0}
                      max={4000}
                      step={50}
                      value={activeClip.fadeInMs ?? 0}
                      onChange={(ms) => updateClipProps(activeClip.id, { fadeInMs: ms })}
                    />
                    <ScrubNumber
                      label="Fade Out"
                      unit="ms"
                      min={0}
                      max={4000}
                      step={50}
                      value={activeClip.fadeOutMs ?? 0}
                      onChange={(ms) => updateClipProps(activeClip.id, { fadeOutMs: ms })}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Selected Detached / SFX Audio Clip (A1 / A3) */}
            {activeAudioClip && (
              <div className="space-y-2.5 border-t border-[#222228] pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#4ADE80]">
                    Audio / SFX Clip ({(activeAudioClip.kind ?? "audio").toUpperCase()})
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAudioClip(activeAudioClip.id)}
                    className="text-[#A1A1AA] hover:text-[#EF4444]"
                    title="Delete audio clip"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>

                {audioClips.length > 1 && (
                  <StudioSelect
                    ariaLabel="Selected Audio Clip"
                    value={activeAudioClip.id}
                    onChange={(aid) => selectAudioClip(aid)}
                    options={audioClips.map((ac, i) => ({
                      value: ac.id,
                      label: ac.label || `${ac.kind ?? "audio"} ${i + 1}`,
                    }))}
                  />
                )}

                <div className="space-y-2.5 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                  <ScrubSlider
                    label="Clip Gain"
                    min={-60}
                    max={12}
                    step={0.5}
                    value={activeAudioClip.gainDb ?? 0}
                    displayValue={formatDbLabel(activeAudioClip.gainDb ?? 0)}
                    onChange={(db) => updateAudioClip(activeAudioClip.id, { gainDb: db })}
                  />
                  <StudioToggle
                    label="Mute Audio Clip"
                    checked={Boolean(activeAudioClip.muted)}
                    onChange={(m) => updateAudioClip(activeAudioClip.id, { muted: m })}
                  />
                </div>
              </div>
            )}

            <div className="space-y-3 border-t border-[#222228] pt-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                  Background Music (BGM · Track A2)
                </span>
                <input
                  ref={bgmFileInputRef}
                  type="file"
                  accept=".mp3,.wav,.m4a,.aac,.ogg,.flac"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) void handleBgmUpload(picked);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={uploadingBgm}
                  onClick={() => bgmFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2 py-0.5 text-[10px] font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60 disabled:opacity-45"
                >
                  {uploadingBgm ? (
                    <CircleNotch className="h-3 w-3 animate-spin" />
                  ) : (
                    <MusicNotesPlus className="h-3 w-3 text-[#F59E0B]" />
                  )}
                  Upload Track
                </button>
              </div>

              <StudioToggle
                label="Enable Background Music"
                hint="Mixed & EBU R128 loudness-normalized"
                checked={Boolean(bgm)}
                onChange={(on) => {
                  if (!on) {
                    updateBgm(null);
                  } else {
                    const firstId = bgmAssets[0]?.id ?? "dark_cinema_pulse";
                    updateBgm({
                      assetId: firstId,
                      gainDb: -15.5,
                      duckingEnabled: true,
                    });
                  }
                }}
              />

              {bgm && (
                <div className="space-y-3 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                  <div>
                    <span className="mb-1 block text-[10px] text-[#A1A1AA]">Active BGM Track</span>
                    <StudioSelect
                      ariaLabel="BGM Asset"
                      value={bgm.assetId || "dark_cinema_pulse"}
                      onChange={(aid) => {
                        const meta = bgmAssets.find((a) => a.id === aid);
                        updateBgm({
                          assetId: aid,
                          startOffsetMs: meta?.dropOffsetMs ?? 0,
                        });
                      }}
                      options={
                        bgmAssets.length > 0
                          ? bgmAssets.map((a) => ({
                              value: a.id,
                              label: a.name,
                              hint: `${a.mood} · ${(a.durationMs / 1000).toFixed(0)}s${a.builtin ? " · Built-in" : ""}`,
                            }))
                          : [
                              {
                                value: bgm.assetId || "dark_cinema_pulse",
                                label: bgm.assetId || "dark_cinema_pulse",
                              },
                            ]
                      }
                    />
                  </div>

                  <ScrubSlider
                    label="BGM Bed Level"
                    min={-60}
                    max={6}
                    step={0.5}
                    value={bgm.gainDb}
                    displayValue={formatDbLabel(bgm.gainDb)}
                    onChange={(db) => updateBgm({ gainDb: db })}
                  />

                  <StudioToggle
                    label="Auto-Duck Under Dialogue"
                    hint="Sidechain compresses BGM during speech & swells in pauses"
                    checked={bgm.duckingEnabled}
                    onChange={(d) => updateBgm({ duckingEnabled: d })}
                  />

                  <div className="grid grid-cols-3 gap-1.5">
                    <ScrubNumber
                      label="Drop Offset"
                      unit="ms"
                      min={0}
                      max={300000}
                      step={250}
                      value={bgm.startOffsetMs ?? 0}
                      onChange={(ms) => updateBgm({ startOffsetMs: ms })}
                    />
                    <ScrubNumber
                      label="Fade In"
                      unit="ms"
                      min={0}
                      max={4000}
                      step={100}
                      value={bgm.fadeInMs ?? 500}
                      onChange={(ms) => updateBgm({ fadeInMs: ms })}
                    />
                    <ScrubNumber
                      label="Fade Out"
                      unit="ms"
                      min={0}
                      max={5000}
                      step={100}
                      value={bgm.fadeOutMs ?? 1000}
                      onChange={(ms) => updateBgm({ fadeOutMs: ms })}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* 3. CAPTIONS TAB */}
        {inspectorContext === "subtitle" && (
          <>
            {selectedWord && (
              <div className="space-y-2.5 rounded-md border border-[#F59E0B]/40 bg-[#16161B] p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#FBBF24]">
                    Selected Word Time-Stop
                  </span>
                  <button
                    type="button"
                    onClick={() => removeWord(selectedWord.id)}
                    className="text-[#A1A1AA] hover:text-[#EF4444]"
                    title="Delete word (Del)"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>

                <input
                  type="text"
                  value={selectedWord.text}
                  onChange={(e) => setWordText(selectedWord.id, e.target.value)}
                  className="w-full rounded border border-[#2C2C35] bg-[#09090B] px-2 py-1 text-xs font-semibold text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                />

                <div className="grid grid-cols-2 gap-2">
                  <ScrubNumber
                    label="Start"
                    unit="ms"
                    min={0}
                    step={20}
                    value={selectedWord.startMs}
                    onChange={(ms) =>
                      setWordTiming(selectedWord.id, ms, selectedWord.endMs, true)
                    }
                  />
                  <ScrubNumber
                    label="End"
                    unit="ms"
                    min={selectedWord.startMs + 60}
                    step={20}
                    value={selectedWord.endMs}
                    onChange={(ms) =>
                      setWordTiming(selectedWord.id, selectedWord.startMs, ms, true)
                    }
                  />
                </div>

                <div>
                  <span className="mb-1 block text-[10px] text-[#A1A1AA]">
                    Word Neon Glow Override
                  </span>
                  <div className="flex items-center gap-1.5">
                    {PUNCH_GLOW_SWATCHES.map((sw) => {
                      const active = (selectedWord.glowColor ?? "") === sw.hex;
                      return (
                        <button
                          key={sw.label}
                          type="button"
                          title={sw.label}
                          onClick={() =>
                            setWordText(
                              selectedWord.id,
                              selectedWord.text,
                              sw.hex ? sw.hex : null,
                            )
                          }
                          className={`h-5 w-5 rounded-full border ${
                            active
                              ? "scale-110 border-white ring-1 ring-[#F59E0B]"
                              : "border-[#32323B]"
                          }`}
                          style={{
                            backgroundColor: sw.hex || "#18181C",
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <StudioToggle
              label="Burn Subtitles"
              checked={edl.tracks.subtitles.enabled}
              onChange={(v) =>
                mutateEdl("Toggle subtitles", (d) => {
                  d.tracks.subtitles.enabled = v;
                })
              }
            />

            <StudioToggle
              label="Profanity Mask"
              checked={edl.tracks.subtitles.censorProfanity}
              onChange={(v) =>
                mutateEdl("Toggle profanity filter", (d) => {
                  d.tracks.subtitles.censorProfanity = v;
                })
              }
            />

            <div>
              <span className="mb-1 block text-[11px] text-[#A1A1AA]">Style Preset</span>
              <StudioSelect
                ariaLabel="Caption Style Preset"
                value={edl.tracks.subtitles.style.preset}
                onChange={(p) => {
                  const preset = p as SubtitleStyle["preset"];
                  mutateEdl(`Preset → ${preset}`, (d) => {
                    d.tracks.subtitles.style.preset = preset;
                    if (preset === "cinema_neon_glow" && !d.tracks.subtitles.style.letterSpacing) {
                      d.tracks.subtitles.style.letterSpacing = 3.5;
                    }
                  });
                }}
                options={[
                  {
                    value: "cinema_neon_glow",
                    label: "Cinema Neon Glow",
                    hint: "Dual-layer outer aura · Rotating phrase neon",
                  },
                  {
                    value: "viral_punch_glow",
                    label: "Viral Punch Glow",
                    hint: "Clean white + semantic neon bloom",
                  },
                  { value: "bold_pop", label: "Bold Pop", hint: "High-impact streamer caps" },
                  { value: "karaoke_fill", label: "Karaoke Sweep", hint: "Syllable fill sweep" },
                  { value: "clean_lower", label: "Clean Lower", hint: "Broadcast subtitle" },
                  { value: "boxed", label: "Dark Boxed", hint: "Translucent backing plate" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1 block text-[11px] text-[#A1A1AA]">Reveal Cadence</span>
              <SegmentedControl
                size="xs"
                value={edl.tracks.subtitles.style.revealMode}
                onChange={(mode) => {
                  mutateEdl(`Reveal → ${mode}`, (d) => {
                    d.tracks.subtitles.style.revealMode = mode;
                  });
                }}
                options={[
                  { value: "progressive", label: "Progressive" },
                  { value: "group", label: "Phrase" },
                  { value: "single_word", label: "Single" },
                ]}
              />
            </div>

            <ScrubSlider
              label="Font Size Scale"
              min={60}
              max={180}
              step={5}
              value={Math.round(edl.tracks.subtitles.style.fontSizeScale * 100)}
              displayValue={`${edl.tracks.subtitles.style.fontSizeScale.toFixed(2)}×`}
              onChange={(v) => {
                mutateEdl("Resize captions", (d) => {
                  d.tracks.subtitles.style.fontSizeScale = v / 100;
                });
              }}
            />

            <ScrubSlider
              label="Vertical Height"
              min={8}
              max={78}
              step={1}
              value={Math.round(edl.tracks.subtitles.marginVRatio * 100)}
              displayValue={`${Math.round(edl.tracks.subtitles.marginVRatio * 100)}%`}
              onChange={(v) => {
                mutateEdl("Adjust caption height", (d) => {
                  d.tracks.subtitles.marginVRatio = v / 100;
                });
              }}
            />

            <ScrubSlider
              label="Letter Tracking"
              min={0}
              max={8}
              step={0.5}
              value={edl.tracks.subtitles.style.letterSpacing ?? 0.5}
              displayValue={`${(edl.tracks.subtitles.style.letterSpacing ?? 0.5).toFixed(1)} px`}
              onChange={(ls) => {
                mutateEdl("Adjust letter spacing", (d) => {
                  d.tracks.subtitles.style.letterSpacing = ls;
                });
              }}
            />

            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["primaryColor", "Core"],
                  ["accentColor", "Glow / Active"],
                  ["outlineColor", "Shadow"],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="block text-[10px] text-[#A1A1AA]">
                  {label}
                  <input
                    type="color"
                    value={edl.tracks.subtitles.style[field]}
                    onChange={(e) => {
                      const hex = e.target.value.toUpperCase();
                      mutateEdl(`Caption ${label} color`, (d) => {
                        d.tracks.subtitles.style[field] = hex;
                      });
                    }}
                    className="mt-1 h-6 w-full cursor-pointer rounded border border-[#222228] bg-[#09090B]"
                  />
                </label>
              ))}
            </div>
          </>
        )}

        {/* 4. OVERLAYS TAB */}
        {inspectorContext === "overlay" && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ["seam_card_white", "Headline Hook", "Headline Hook"],
                  ["hook_banner_dark", "Dark Banner", "WAIT FOR THIS..."],
                  ["pov_top_bar", "POV Top Bar", "POV: WHEN IT HAPPENS"],
                  ["cta_pill", "CTA Pill", "Follow for Part 2"],
                  ["watermark_tag", "Watermark", "CUTFLOW"],
                  ["cinema_credit", "Film Credit", "Cinema Title (2026)"],
                ] as const
              ).map(([kind, label, defaultTxt]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addOverlay(kind, defaultTxt)}
                  className="inline-flex items-center gap-1 rounded border border-[#282830] bg-[#18181C] px-2 py-1 text-[11px] font-medium text-[#D4D4D8] hover:border-[#F59E0B]/50 hover:text-white"
                >
                  <Plus className="h-3 w-3 text-[#F59E0B]" />
                  {label}
                </button>
              ))}
            </div>

            {edl.tracks.overlays.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {edl.tracks.overlays.map((ov) => (
                  <button
                    key={ov.id}
                    type="button"
                    onClick={() => selectOverlay(ov.id)}
                    className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                      selectedOverlay?.id === ov.id
                        ? "border-[#F59E0B] bg-[#F59E0B]/15 text-[#F4F4F5]"
                        : "border-[#222228] bg-[#09090B] text-[#A1A1AA]"
                    }`}
                  >
                    {ov.text.slice(0, 14) || ov.kind.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            )}

            {selectedOverlay ? (
              <div className="space-y-3 rounded-md border border-[#222228] bg-[#09090B]/70 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="tabular-tc text-[10px] font-semibold uppercase text-[#F59E0B]">
                    {selectedOverlay.kind.replace(/_/g, " ")}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => duplicateOverlay(selectedOverlay.id)}
                      className="text-[#A1A1AA] hover:text-[#F4F4F5]"
                      title="Duplicate overlay"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeOverlay(selectedOverlay.id)}
                      className="text-[#A1A1AA] hover:text-[#EF4444]"
                      title="Delete overlay"
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div>
                  <span className="mb-1 block text-[10px] text-[#A1A1AA]">Text</span>
                  <textarea
                    rows={2}
                    value={selectedOverlay.text}
                    onChange={(e) =>
                      updateOverlay(selectedOverlay.id, { text: e.target.value })
                    }
                    className="w-full rounded border border-[#222228] bg-[#111114] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                  />
                </div>

                <ScrubSlider
                  label="Overlay Scale"
                  min={50}
                  max={220}
                  step={5}
                  value={Math.round((selectedOverlay.scale ?? 1) * 100)}
                  displayValue={`${Math.round((selectedOverlay.scale ?? 1) * 100)}%`}
                  onChange={(sc) =>
                    updateOverlay(selectedOverlay.id, { scale: sc / 100 })
                  }
                />

                {selectedOverlay.kind !== "pov_top_bar" && (
                  <>
                    <div>
                      <span className="mb-1 block text-[10px] text-[#A1A1AA]">Anchor Zone</span>
                      <StudioSelect
                        value={selectedOverlay.yAnchor}
                        onChange={(ya) =>
                          updateOverlay(selectedOverlay.id, {
                            yAnchor: ya as OverlayItem["yAnchor"],
                          })
                        }
                        options={[
                          { value: "top", label: "Top Safe Zone" },
                          { value: "split_seam", label: "Split Seam" },
                          { value: "bottom", label: "Bottom Safe Zone" },
                        ]}
                      />
                    </div>

                    <ScrubSlider
                      label="Horizontal Offset (X)"
                      min={-45}
                      max={45}
                      step={1}
                      value={Math.round((selectedOverlay.xOffsetRatio ?? 0) * 100)}
                      displayValue={`${Math.round((selectedOverlay.xOffsetRatio ?? 0) * 100)}%`}
                      onChange={(x) =>
                        updateOverlay(selectedOverlay.id, { xOffsetRatio: x / 100 })
                      }
                    />
                  </>
                )}

                <ScrubSlider
                  label="Vertical Offset (Y)"
                  min={-45}
                  max={45}
                  step={1}
                  value={Math.round(selectedOverlay.yOffsetRatio * 100)}
                  displayValue={`${Math.round(selectedOverlay.yOffsetRatio * 100)}%`}
                  onChange={(y) =>
                    updateOverlay(selectedOverlay.id, { yOffsetRatio: y / 100 })
                  }
                />

                <ScrubSlider
                  label="Opacity"
                  min={15}
                  max={100}
                  step={5}
                  value={Math.round((selectedOverlay.opacity ?? 1) * 100)}
                  displayValue={`${Math.round((selectedOverlay.opacity ?? 1) * 100)}%`}
                  onChange={(op) =>
                    updateOverlay(selectedOverlay.id, { opacity: op / 100 })
                  }
                />

                <div className="grid grid-cols-2 gap-2">
                  <ScrubNumber
                    label="Start"
                    unit="ms"
                    min={0}
                    step={100}
                    value={selectedOverlay.startMs}
                    onChange={(ms) => updateOverlay(selectedOverlay.id, { startMs: ms })}
                  />
                  <ScrubNumber
                    label="End"
                    unit="ms"
                    min={selectedOverlay.startMs + 250}
                    step={100}
                    value={selectedOverlay.endMs}
                    onChange={(ms) => updateOverlay(selectedOverlay.id, { endMs: ms })}
                  />
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-[#71717A]">
                No graphic overlays on this timeline. Add a Hook, POV Bar, or Watermark above.
              </p>
            )}
          </>
        )}

        {/* 5. RENDER TAB */}
        {inspectorContext === "export" && (
          <>
            <div>
              <span className="mb-1.5 block text-[11px] text-[#A1A1AA]">Canvas Aspect Ratio</span>
              <SegmentedControl
                value={edl.output.ratio}
                onChange={(r) =>
                  mutateEdl(`Ratio → ${r}`, (d) => {
                    d.output.ratio = r;
                  })
                }
                options={[
                  { value: "9:16", label: "9:16" },
                  { value: "4:5", label: "4:5" },
                  { value: "1:1", label: "1:1" },
                  { value: "16:9", label: "16:9" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] text-[#A1A1AA]">
                Inner Cinema Border
              </span>
              <SegmentedControl
                size="xs"
                value={edl.output.borderStyle ?? "none"}
                onChange={(bs) =>
                  mutateEdl(`Border → ${bs}`, (d) => {
                    d.output.borderStyle = bs;
                  })
                }
                options={[
                  { value: "none", label: "None" },
                  { value: "thin_rounded", label: "Thin Rounded" },
                  { value: "double_cinema", label: "Double Frame" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] text-[#A1A1AA]">Color &amp; Detail Grade</span>
              <SegmentedControl
                size="xs"
                value={edl.output.cinemaGrade ?? "off"}
                onChange={(cg) =>
                  mutateEdl(`Grade → ${cg}`, (d) => {
                    d.output.cinemaGrade = cg;
                  })
                }
                options={[
                  { value: "off", label: "Source Natural" },
                  { value: "crisp_hd", label: "Crisp HD + Contrast" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] text-[#A1A1AA]">Resolution</span>
              <SegmentedControl
                size="xs"
                value={edl.output.quality}
                onChange={(q) =>
                  mutateEdl(`Quality → ${q}`, (d) => {
                    d.output.quality = q as OutputSettings["quality"];
                  })
                }
                options={[
                  { value: "720p", label: "720p" },
                  { value: "1080p", label: "1080p" },
                  { value: "1440p", label: "1440p" },
                  { value: "4k", label: "4K" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] text-[#A1A1AA]">Encoder Pass</span>
              <SegmentedControl
                value={edl.output.speedPreset}
                onChange={(preset) =>
                  mutateEdl(`Preset → ${preset}`, (d) => {
                    d.output.speedPreset = preset;
                  })
                }
                options={[
                  { value: "draft", label: "Draft Fast" },
                  { value: "final", label: "Final Master" },
                ]}
              />
            </div>

            <button
              type="button"
              disabled={exportingNow || !canExport}
              onClick={() => void onExportNow()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F59E0B] px-3 py-2 text-xs font-semibold text-[#09090B] transition-colors hover:bg-[#FBBF24] disabled:opacity-40"
            >
              {exportingNow ? (
                <CircleNotch className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Export weight="bold" className="h-3.5 w-3.5" />
              )}
              {exportingNow
                ? "Encoding Master MP4..."
                : `Render ${edl.output.ratio} · ${edl.output.quality}`}
            </button>
          </>
        )}

        {lastActionLabel && (
          <div className="tabular-tc border-t border-[#1E1E24] pt-2 text-[10px] text-[#71717A]">
            LAST: {lastActionLabel}
          </div>
        )}
      </div>
    </section>
  );
}
