import {
  Frame,
  Layers,
  Loader2,
  Pin,
  Plus,
  Rocket,
  SplitSquareVertical,
  Subtitles,
  Trash2,
} from "lucide-react";
import {
  getActiveFramingAt,
  type NormalizedBox,
  type OutputSettings,
  type OverlayItem,
  type SubtitleStyle,
} from "../../edl";
import {
  useTimelineStore,
  type InspectorContext,
} from "../../state/timelineStore";

interface ContextInspectorProps {
  canExport: boolean;
  exportingNow: boolean;
  onExportNow: () => Promise<void>;
  onPinWebcam?: (camBox: NormalizedBox, splitRatio: number) => Promise<void>;
}

const INSPECTOR_TABS: {
  id: InspectorContext;
  label: string;
  icon: typeof Frame;
}[] = [
  { id: "framing", label: "Framing", icon: Frame },
  { id: "subtitle", label: "Subs", icon: Subtitles },
  { id: "overlay", label: "Cards", icon: Layers },
  { id: "export", label: "Export", icon: Rocket },
];

export function ContextInspector({
  canExport,
  exportingNow,
  onExportNow,
  onPinWebcam,
}: ContextInspectorProps) {
  const {
    edl,
    playheadMs,
    inspectorContext,
    selectedWordId,
    selectedOverlayId,
    lastActionLabel,
    setInspectorContext,
    selectOverlay,
    mutateEdl,
    updateFraming,
    splitFramingAtPlayhead,
    setWordTiming,
    setWordText,
    removeWord,
    updateOverlay,
    addOverlay,
    removeOverlay,
  } = useTimelineStore();

  if (!edl) return null;

  const framing = getActiveFramingAt(edl, playheadMs);
  const selectedWord =
    edl.tracks.subtitles.words.find((w) => w.id === selectedWordId) ?? null;
  const selectedOverlay =
    edl.tracks.overlays.find((o) => o.id === selectedOverlayId) ??
    edl.tracks.overlays[0] ??
    null;

  return (
    <section className="flex h-full flex-col border-l border-[#222836] bg-[#131720]">
      {/* Context Tab Strip */}
      <div className="grid grid-cols-4 border-b border-[#222836] bg-[#0F131B]">
        {INSPECTOR_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = inspectorContext === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setInspectorContext(tab.id)}
              className={`flex items-center justify-center gap-1 border-b-2 py-2 text-[11px] font-medium transition-colors ${
                active
                  ? "border-[#6366F1] bg-[#131720] text-white"
                  : "border-transparent text-[#94A3B8] hover:text-white"
              }`}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Inspector Panel Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {inspectorContext === "framing" && framing && (
          <>
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-[#94A3B8]">
                Layout Mode
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(["split", "fit", "centre", "crop"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      updateFraming({
                        mode: m,
                        camBox:
                          m === "split" && !framing.camBox
                            ? { x: 0.02, y: 0.28, w: 0.24, h: 0.26 }
                            : framing.camBox,
                      })
                    }
                    className={`rounded border px-2 py-1.5 text-xs font-medium capitalize ${
                      framing.mode === m
                        ? "border-[#6366F1] bg-[#6366F1]/20 text-white"
                        : "border-[#222836] bg-[#0B0D12] text-[#94A3B8]"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {framing.mode === "split" && (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-[#94A3B8]">
                  <span>Split Seam Ratio</span>
                  <span className="tabular-tc text-white">
                    {Math.round(framing.splitRatio * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={65}
                  step={1}
                  value={Math.round(framing.splitRatio * 100)}
                  onChange={(e) =>
                    updateFraming({ splitRatio: Number(e.target.value) / 100 })
                  }
                  className="w-full accent-[#6366F1]"
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  try {
                    splitFramingAtPlayhead();
                  } catch {
                    // playhead near boundary
                  }
                }}
                className="flex items-center justify-center gap-1.5 rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-[11px] font-medium text-[#CBD5E1] hover:border-[#6366F1] hover:text-white"
              >
                <SplitSquareVertical className="h-3.5 w-3.5 text-[#6366F1]" />
                Split Layout at Playhead ({edl.tracks.video.framing.length} seg)
              </button>

              {framing.mode === "split" && framing.camBox && onPinWebcam && (
                <button
                  type="button"
                  onClick={() =>
                    void onPinWebcam(framing.camBox!, framing.splitRatio)
                  }
                  className="flex items-center justify-center gap-1.5 rounded border border-[#10B981]/40 bg-[#10B981]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#A7F3D0] hover:bg-[#10B981]/20"
                >
                  <Pin className="h-3.5 w-3.5" />
                  Pin Webcam to Creator Profile
                </button>
              )}
            </div>

            <div className="space-y-2 border-t border-[#222836] pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[#94A3B8]">
                  Cold-Open Flash-Forward
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(edl.tracks.video.coldOpen?.enabled)}
                  onChange={(e) => {
                    const enabled = e.target.checked;
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
                  className="accent-[#EC4899]"
                />
              </div>

              {edl.tracks.video.coldOpen?.enabled && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-[#94A3B8]">
                    <span>Hook Duration</span>
                    <span className="tabular-tc text-white">
                      {(edl.tracks.video.coldOpen.durationMs / 1000).toFixed(2)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={500}
                    max={3500}
                    step={100}
                    value={edl.tracks.video.coldOpen.durationMs}
                    onChange={(e) => {
                      const ms = Number(e.target.value);
                      mutateEdl("Adjust cold-open duration", (draft) => {
                        if (draft.tracks.video.coldOpen) {
                          draft.tracks.video.coldOpen.durationMs = ms;
                        }
                      });
                    }}
                    className="w-full accent-[#EC4899]"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-[#222836] pt-3">
              <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                <span>Audio Gain</span>
                <span className="tabular-tc text-white">
                  {edl.tracks.audio.gainDb >= 0 ? "+" : ""}
                  {edl.tracks.audio.gainDb.toFixed(1)} dB
                </span>
              </div>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={edl.tracks.audio.gainDb}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  mutateEdl("Adjust audio gain", (draft) => {
                    draft.tracks.audio.gainDb = val;
                  });
                }}
                className="w-full accent-[#10B981]"
              />
            </div>
          </>
        )}

        {inspectorContext === "subtitle" && (
          <>
            {/* Selected Word Time-Stop Card */}
            {selectedWord && (
              <div className="space-y-2 rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#FDE68A]">
                    Selected Word Time-Stop
                  </span>
                  <button
                    type="button"
                    onClick={() => removeWord(selectedWord.id)}
                    className="text-[#FDA4AF] hover:text-[#F43F5E]"
                    title="Delete word (Del)"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <input
                  type="text"
                  value={selectedWord.text}
                  onChange={(e) => setWordText(selectedWord.id, e.target.value)}
                  className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs font-semibold text-white"
                />

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-[#94A3B8]">Start (ms)</label>
                    <input
                      type="number"
                      step={20}
                      value={selectedWord.startMs}
                      onChange={(e) =>
                        setWordTiming(
                          selectedWord.id,
                          Number(e.target.value),
                          selectedWord.endMs,
                          true,
                        )
                      }
                      className="tabular-tc w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#94A3B8]">End (ms)</label>
                    <input
                      type="number"
                      step={20}
                      value={selectedWord.endMs}
                      onChange={(e) =>
                        setWordTiming(
                          selectedWord.id,
                          selectedWord.startMs,
                          Number(e.target.value),
                          true,
                        )
                      }
                      className="tabular-tc w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs text-white"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#94A3B8]">Burn Subtitles</span>
              <input
                type="checkbox"
                checked={edl.tracks.subtitles.enabled}
                onChange={(e) =>
                  mutateEdl("Toggle subtitles", (d) => {
                    d.tracks.subtitles.enabled = e.target.checked;
                  })
                }
                className="accent-[#F59E0B]"
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#94A3B8]">Censor Profanity</span>
              <input
                type="checkbox"
                checked={edl.tracks.subtitles.censorProfanity}
                onChange={(e) =>
                  mutateEdl("Toggle profanity filter", (d) => {
                    d.tracks.subtitles.censorProfanity = e.target.checked;
                  })
                }
                className="accent-[#F59E0B]"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Reveal Mode</label>
              <select
                value={edl.tracks.subtitles.style.revealMode}
                onChange={(e) => {
                  const mode = e.target.value as SubtitleStyle["revealMode"];
                  mutateEdl(`Reveal → ${mode}`, (d) => {
                    d.tracks.subtitles.style.revealMode = mode;
                  });
                }}
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1.5 text-xs text-white"
              >
                <option value="progressive">Progressive (word-by-word)</option>
                <option value="group">Group (2–3 words)</option>
                <option value="single_word">Single Word Pop</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Style Preset</label>
              <select
                value={edl.tracks.subtitles.style.preset}
                onChange={(e) => {
                  const preset = e.target.value as SubtitleStyle["preset"];
                  mutateEdl(`Preset → ${preset}`, (d) => {
                    d.tracks.subtitles.style.preset = preset;
                  });
                }}
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1.5 text-xs text-white"
              >
                <option value="bold_pop">Bold Pop</option>
                <option value="karaoke_fill">Karaoke Fill</option>
                <option value="clean_lower">Clean Lower</option>
                <option value="boxed">Boxed</option>
              </select>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-[#94A3B8]">
                <span>Size Scale</span>
                <span className="tabular-tc text-white">
                  {edl.tracks.subtitles.style.fontSizeScale.toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={60}
                max={180}
                step={5}
                value={Math.round(edl.tracks.subtitles.style.fontSizeScale * 100)}
                onChange={(e) => {
                  const scale = Number(e.target.value) / 100;
                  mutateEdl("Resize captions", (d) => {
                    d.tracks.subtitles.style.fontSizeScale = scale;
                  });
                }}
                className="w-full accent-[#F59E0B]"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["primaryColor", "Text"],
                  ["accentColor", "Accent"],
                  ["outlineColor", "Stroke"],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="block text-[10px] text-[#94A3B8]">
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
                    className="mt-1 h-7 w-full cursor-pointer rounded border border-[#222836] bg-[#0B0D12]"
                  />
                </label>
              ))}
            </div>
          </>
        )}

        {inspectorContext === "overlay" && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["seam_card_white", "+ Seam Card"],
                  ["hook_banner_dark", "+ Dark Hook"],
                  ["cta_pill", "+ CTA Pill"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() =>
                    addOverlay(
                      kind,
                      kind === "cta_pill" ? "Follow for Part 2" : "New Title Card",
                    )
                  }
                  className="inline-flex items-center gap-1 rounded border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-2 py-1 text-[11px] font-medium text-[#E0F2FE] hover:bg-[#38BDF8]/20"
                >
                  <Plus className="h-3 w-3" />
                  {label.replace("+ ", "")}
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
                    className={`rounded border px-2 py-0.5 text-[10px] ${
                      selectedOverlay?.id === ov.id
                        ? "border-[#38BDF8] bg-[#38BDF8]/20 text-white"
                        : "border-[#222836] text-[#94A3B8]"
                    }`}
                  >
                    {ov.kind}
                  </button>
                ))}
              </div>
            )}

            {selectedOverlay ? (
              <div className="space-y-3 rounded-lg border border-[#222836] bg-[#0B0D12]/60 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#38BDF8]">
                    {selectedOverlay.kind}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeOverlay(selectedOverlay.id)}
                    className="text-[#94A3B8] hover:text-[#F43F5E]"
                    title="Delete overlay"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-[10px] text-[#94A3B8]">Card Text</label>
                  <textarea
                    rows={2}
                    value={selectedOverlay.text}
                    onChange={(e) =>
                      updateOverlay(selectedOverlay.id, { text: e.target.value })
                    }
                    className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs text-white"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[10px] text-[#94A3B8]">Anchor</label>
                  <select
                    value={selectedOverlay.yAnchor}
                    onChange={(e) =>
                      updateOverlay(selectedOverlay.id, {
                        yAnchor: e.target.value as OverlayItem["yAnchor"],
                      })
                    }
                    className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2 py-1 text-xs text-white"
                  >
                    <option value="split_seam">Split Seam</option>
                    <option value="top">Top Safe Area</option>
                    <option value="bottom">Bottom Safe Area</option>
                  </select>
                </div>

                <div>
                  <div className="mb-1 flex justify-between text-[10px] text-[#94A3B8]">
                    <span>Vertical Fine Offset</span>
                    <span className="tabular-tc text-white">
                      {Math.round(selectedOverlay.yOffsetRatio * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-40}
                    max={40}
                    step={1}
                    value={Math.round(selectedOverlay.yOffsetRatio * 100)}
                    onChange={(e) =>
                      updateOverlay(selectedOverlay.id, {
                        yOffsetRatio: Number(e.target.value) / 100,
                      })
                    }
                    className="w-full accent-[#38BDF8]"
                  />
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-[#64748B]">
                No overlays on this clip yet. Add a Seam Card or Hook Banner above.
              </p>
            )}
          </>
        )}

        {inspectorContext === "export" && (
          <>
            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Aspect Ratio</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(["9:16", "1:1", "16:9"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Ratio → ${r}`, (d) => {
                        d.output.ratio = r;
                      })
                    }
                    className={`rounded border px-2 py-1.5 text-xs font-medium ${
                      edl.output.ratio === r
                        ? "border-[#6366F1] bg-[#6366F1]/20 text-white"
                        : "border-[#222836] bg-[#0B0D12] text-[#94A3B8]"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Resolution</label>
              <div className="grid grid-cols-4 gap-1">
                {(["720p", "1080p", "1440p", "4k"] as const).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Quality → ${q}`, (d) => {
                        d.output.quality = q as OutputSettings["quality"];
                      })
                    }
                    className={`rounded border px-1.5 py-1 text-[11px] font-medium ${
                      edl.output.quality === q
                        ? "border-[#6366F1] bg-[#6366F1]/20 text-white"
                        : "border-[#222836] bg-[#0B0D12] text-[#94A3B8]"
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Encoder Speed Preset</label>
              <div className="grid grid-cols-2 gap-1.5">
                {(["draft", "final"] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() =>
                      mutateEdl(`Preset → ${preset}`, (d) => {
                        d.output.speedPreset = preset;
                      })
                    }
                    className={`rounded border px-2 py-1.5 text-xs font-medium capitalize ${
                      edl.output.speedPreset === preset
                        ? "border-[#6366F1] bg-[#6366F1]/20 text-white"
                        : "border-[#222836] bg-[#0B0D12] text-[#94A3B8]"
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={exportingNow || !canExport}
              onClick={() => void onExportNow()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-2 text-xs font-semibold text-white hover:bg-[#5558E6] disabled:opacity-45"
            >
              {exportingNow ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5" />
              )}
              {exportingNow
                ? "Rendering MP4..."
                : `Render ${edl.output.quality} (${edl.output.speedPreset})`}
            </button>
          </>
        )}

        {lastActionLabel && (
          <div className="border-t border-[#222836] pt-2 text-[10px] text-[#64748B]">
            Last command: {lastActionLabel}
          </div>
        )}
      </div>
    </section>
  );
}
