import { useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  FilmSlate,
  GameController,
  MusicNotes,
  PencilSimple,
  Plus,
  PushPin,
  Trash,
} from "@phosphor-icons/react";
import {
  SegmentedControl,
  StudioSelect,
  StudioToggle,
} from "../components/ui/StudioControls";
import type { BgmAssetItem, CreatorProfile, StudioTransport } from "../transport";

interface CreatorsPageProps {
  transport: StudioTransport;
  profiles: CreatorProfile[];
  bgmAssets: BgmAssetItem[];
  onCreated: () => Promise<void>;
}

export function CreatorsPage({
  transport,
  profiles,
  bgmAssets,
  onCreated,
}: CreatorsPageProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [brief, setBrief] = useState("");
  const [contentMode, setContentMode] = useState<"stream" | "cinema">("stream");
  const [defaultRatio, setDefaultRatio] = useState<"9:16" | "4:5" | "1:1" | "16:9">("9:16");
  const [layoutMode, setLayoutMode] = useState("auto_reframe");
  const [captionStyle, setCaptionStyle] = useState("viral_punch_glow");
  const [revealMode, setRevealMode] = useState("progressive");
  const [borderStyle, setBorderStyle] = useState("none");
  const [cinemaGrade, setCinemaGrade] = useState<"off" | "crisp_hd">("crisp_hd");
  const [titleCardStyle, setTitleCardStyle] = useState("seam_card_white");
  const [watermarkText, setWatermarkText] = useState("");
  const [transitionStyle, setTransitionStyle] = useState("flash_white");
  const [bgmMode, setBgmMode] = useState("auto_mood");
  const [bgmMood, setBgmMood] = useState("any");
  const [bgmAssetId, setBgmAssetId] = useState("");
  const [dialogueEnhance, setDialogueEnhance] = useState(true);
  const [autoTightenSilence, setAutoTightenSilence] = useState(false);
  const [autoExport, setAutoExport] = useState(false);
  const [channelsRaw, setChannelsRaw] = useState("");

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyContentPreset(mode: "stream" | "cinema") {
    setContentMode(mode);
    if (mode === "cinema") {
      setDefaultRatio("1:1");
      setLayoutMode("auto_reframe");
      setCaptionStyle("cinema_neon_glow");
      setRevealMode("group");
      setBorderStyle("thin_rounded");
      setCinemaGrade("crisp_hd");
      setTitleCardStyle("pov_top_bar");
      setTransitionStyle("dip_black");
      setBgmMode("auto_mood");
      setBgmMood("dark_cinema");
      setDialogueEnhance(true);
      setAutoTightenSilence(false);
    } else {
      setDefaultRatio("9:16");
      setLayoutMode("auto_reframe");
      setCaptionStyle("viral_punch_glow");
      setRevealMode("progressive");
      setBorderStyle("none");
      setCinemaGrade("crisp_hd");
      setTitleCardStyle("seam_card_white");
      setTransitionStyle("flash_white");
      setBgmMode("auto_mood");
      setBgmMood("upbeat_gaming");
      setDialogueEnhance(true);
      setAutoTightenSilence(true);
    }
  }

  function openCreate() {
    setEditingId(null);
    setName("");
    setCreatorName("");
    setBrief("");
    applyContentPreset("cinema");
    setWatermarkText("");
    setBgmAssetId("");
    setAutoExport(false);
    setChannelsRaw("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(p: CreatorProfile) {
    setEditingId(p.id);
    setName(p.name);
    setCreatorName(p.creator_name);
    setBrief(p.brief);
    setContentMode(p.content_mode === "cinema" ? "cinema" : "stream");
    setDefaultRatio(
      (p.default_ratio as "9:16" | "4:5" | "1:1" | "16:9") ?? "9:16",
    );
    setLayoutMode(p.layout_mode);
    setCaptionStyle(p.caption_style);
    setRevealMode(p.reveal_mode);
    setBorderStyle(p.border_style ?? "none");
    setCinemaGrade(p.cinema_grade === "crisp_hd" ? "crisp_hd" : "off");
    setTitleCardStyle(p.title_card_style);
    setWatermarkText(p.watermark_text ?? "");
    setTransitionStyle(p.transition_style ?? "none");
    setBgmMode(p.bgm_mode ?? "off");
    setBgmMood(p.bgm_mood ?? "any");
    setBgmAssetId(p.bgm_asset_id ?? "");
    setDialogueEnhance(Boolean(p.dialogue_enhance));
    setAutoTightenSilence(Boolean(p.auto_tighten_silence));
    setAutoExport(p.auto_export);
    setChannelsRaw((p.channel_urls ?? []).join("\n"));
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const channels = channelsRaw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        name: name.trim(),
        creator_name: creatorName.trim(),
        brief: brief.trim(),
        content_mode: contentMode,
        default_ratio: defaultRatio,
        layout_mode: layoutMode,
        caption_style: captionStyle,
        reveal_mode: revealMode,
        border_style: borderStyle,
        cinema_grade: cinemaGrade,
        title_card_style: titleCardStyle,
        cold_open_enabled: contentMode !== "cinema",
        watermark_text: watermarkText.trim(),
        transition_style: transitionStyle,
        transition_sfx:
          transitionStyle === "flash_white"
            ? "whoosh_flash"
            : transitionStyle === "dip_black"
              ? "cinema_hit"
              : "none",
        bgm_mode: bgmMode,
        bgm_mood: bgmMood,
        bgm_asset_id: bgmAssetId,
        dialogue_enhance: dialogueEnhance,
        auto_tighten_silence: autoTightenSilence,
        margin_v_ratio:
          captionStyle === "cinema_neon_glow" || captionStyle === "viral_punch_glow"
            ? 0.4
            : 0.22,
        auto_export: autoExport,
        channel_urls: channels,
      };

      if (editingId) {
        await transport.updateProfile(editingId, payload);
      } else {
        await transport.createProfile(payload);
      }
      setShowForm(false);
      setEditingId(null);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleQuickToggleAutoExport(p: CreatorProfile) {
    setError(null);
    try {
      await transport.updateProfile(p.id, { auto_export: !p.auto_export });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(profileId: string) {
    setError(null);
    try {
      await transport.deleteProfile(profileId);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center justify-between border-b border-[#222228] pb-3.5">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-[#F4F4F5]">
              Zero-Touch Creator Profiles &amp; Watch Folders
            </h1>
            <p className="mt-0.5 text-xs text-[#A1A1AA]">
              Configure automatic aspect ratio, neon glow captions, inner borders, BGM ducking, and
              local NTFS hardlink watch folders per style.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#F59E0B] px-3 py-1.5 text-xs font-semibold text-[#09090B] transition-colors hover:bg-[#FBBF24]"
          >
            <Plus weight="bold" className="h-3.5 w-3.5" />
            New Profile
          </button>
        </div>

        {error && !showForm && (
          <div className="rounded-md border border-[#EF4444]/40 bg-[#EF4444]/10 px-3 py-2 text-xs text-[#FECACA]">
            {error}
          </div>
        )}

        {showForm && (
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="space-y-4 rounded-lg border border-[#32323B] bg-[#111114] p-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222228] pb-2.5">
              <span className="font-semibold text-[#F4F4F5]">
                {editingId ? "Edit Studio Profile" : "New Zero-Touch Studio Profile"}
              </span>
              <div className="w-64">
                <SegmentedControl
                  size="xs"
                  value={contentMode}
                  onChange={applyContentPreset}
                  options={[
                    { value: "cinema", label: "Cinema & TV Mode" },
                    { value: "stream", label: "Stream & Gaming" },
                  ]}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] text-[#A1A1AA]">Profile Name</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Cinema Dark Edits (1:1)"
                  className="w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#A1A1AA]">
                  Watermark / Handle (optional)
                </label>
                <input
                  value={watermarkText}
                  onChange={(e) => setWatermarkText(e.target.value)}
                  placeholder="e.g. JJ_EDIT or @channel"
                  className="w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#A1A1AA]">Editorial Brief</label>
              <textarea
                rows={2}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Describe what moments to extract (e.g. dramatic monologues, cold realizations, or high-stakes gaming wins)..."
                className="w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Aspect Ratio</span>
                <SegmentedControl
                  size="xs"
                  value={defaultRatio}
                  onChange={setDefaultRatio}
                  options={[
                    { value: "9:16", label: "9:16" },
                    { value: "4:5", label: "4:5" },
                    { value: "1:1", label: "1:1" },
                    { value: "16:9", label: "16:9" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Framing Engine</span>
                <StudioSelect
                  value={layoutMode}
                  onChange={setLayoutMode}
                  options={[
                    { value: "auto_reframe", label: "Auto Face Reframe" },
                    { value: "auto_split", label: "Auto Split Facecam" },
                    { value: "split", label: "Always Split Screen" },
                    { value: "fit", label: "Fit Frame" },
                    { value: "crop", label: "Center Pan & Crop" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Caption Preset</span>
                <StudioSelect
                  value={captionStyle}
                  onChange={setCaptionStyle}
                  options={[
                    { value: "cinema_neon_glow", label: "Cinema Neon Glow" },
                    { value: "viral_punch_glow", label: "Viral Punch Glow" },
                    { value: "bold_pop", label: "Bold Pop" },
                    { value: "karaoke_fill", label: "Karaoke Sweep" },
                    { value: "clean_lower", label: "Clean Lower" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Title Hook Style</span>
                <StudioSelect
                  value={titleCardStyle}
                  onChange={setTitleCardStyle}
                  options={[
                    { value: "pov_top_bar", label: "White Top POV Bar" },
                    { value: "seam_card_white", label: "Seam Headline Card" },
                    { value: "hook_banner_dark", label: "Dark Hook Pill" },
                    { value: "off", label: "None" },
                  ]}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Inner Border</span>
                <StudioSelect
                  value={borderStyle}
                  onChange={setBorderStyle}
                  options={[
                    { value: "none", label: "None" },
                    { value: "thin_rounded", label: "Thin Rounded" },
                    { value: "double_cinema", label: "Double Frame" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">Cut Transition</span>
                <StudioSelect
                  value={transitionStyle}
                  onChange={setTransitionStyle}
                  options={[
                    { value: "flash_white", label: "White Flash + Whoosh" },
                    { value: "dip_black", label: "Dip Black + Sub Hit" },
                    { value: "none", label: "Clean Hard Cut" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">BGM Mode</span>
                <StudioSelect
                  value={bgmMode}
                  onChange={setBgmMode}
                  options={[
                    { value: "auto_mood", label: "Auto Mood Match" },
                    { value: "pinned_asset", label: "Pinned Track" },
                    { value: "off", label: "No BGM" },
                  ]}
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-[#A1A1AA]">
                  {bgmMode === "pinned_asset" ? "Pinned Track" : "BGM Mood"}
                </span>
                {bgmMode === "pinned_asset" ? (
                  <StudioSelect
                    value={bgmAssetId || (bgmAssets[0]?.id ?? "dark_cinema_pulse")}
                    onChange={setBgmAssetId}
                    options={
                      bgmAssets.length > 0
                        ? bgmAssets.map((a) => ({ value: a.id, label: a.name }))
                        : [{ value: "dark_cinema_pulse", label: "Dark Cinema Synth Pulse" }]
                    }
                  />
                ) : (
                  <StudioSelect
                    value={bgmMood}
                    onChange={setBgmMood}
                    options={[
                      { value: "dark_cinema", label: "Dark Cinema Synth" },
                      { value: "upbeat_gaming", label: "Upbeat Challenge" },
                      { value: "suspense", label: "Suspense" },
                      { value: "any", label: "Auto Detect" },
                    ]}
                  />
                )}
              </div>
            </div>

            <div className="grid gap-3 rounded-md border border-[#222228] bg-[#09090B]/60 p-3 sm:grid-cols-3">
              <StudioToggle
                label="5.1 / Vocal Clarity EQ"
                checked={dialogueEnhance}
                onChange={setDialogueEnhance}
              />
              <StudioToggle
                label="Auto Jump-Cut Dead Air"
                checked={autoTightenSilence}
                onChange={setAutoTightenSilence}
              />
              <StudioToggle
                label="Hands-Free Auto-Export MP4"
                checked={autoExport}
                onChange={setAutoExport}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#A1A1AA]">
                Followed Channel URLs (one per line, optional)
              </label>
              <textarea
                rows={2}
                value={channelsRaw}
                onChange={(e) => setChannelsRaw(e.target.value)}
                placeholder="https://www.twitch.tv/creator or https://www.youtube.com/@creator/videos"
                className="w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
            </div>

            {error && <p className="text-[#FCA5A5]">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
                className="rounded border border-[#222228] px-3 py-1.5 text-[#A1A1AA] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-[#F59E0B] px-3.5 py-1.5 font-semibold text-[#09090B] hover:bg-[#FBBF24]"
              >
                {editingId ? "Save Profile" : "Create Profile"}
              </button>
            </div>
          </form>
        )}

        <div className="grid gap-3.5 sm:grid-cols-2">
          {profiles.map((p) => {
            const isCinema = p.content_mode === "cinema";
            const hasPinnedCam = Boolean(p.cam_box);
            return (
              <div
                key={p.id}
                className="flex flex-col justify-between rounded-lg border border-[#222228] bg-[#111114] p-4 transition-colors hover:border-[#32323B]"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[#282830] bg-[#18181C] text-[#F59E0B]">
                        {isCinema ? (
                          <FilmSlate className="h-4 w-4" />
                        ) : (
                          <GameController className="h-4 w-4" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold text-[#F4F4F5]">{p.name}</h2>
                        <div className="tabular-tc flex flex-wrap items-center gap-1.5 text-[10px] text-[#A1A1AA]">
                          <span>{(p.default_ratio ?? "9:16").toUpperCase()}</span>
                          <span>·</span>
                          <span>{p.caption_style}</span>
                          {p.bgm_mode && p.bgm_mode !== "off" && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-0.5 text-[#FBBF24]">
                                <MusicNotes className="h-2.5 w-2.5" />
                                BGM
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(p)}
                        title="Edit profile"
                        className="rounded p-1 text-[#A1A1AA] hover:bg-[#1C1C22] hover:text-white"
                      >
                        <PencilSimple className="h-3.5 w-3.5" />
                      </button>
                      {profiles.length > 1 && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(p.id)}
                          title="Delete profile"
                          className="rounded p-1 text-[#A1A1AA] hover:bg-[#EF4444]/15 hover:text-[#EF4444]"
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="mt-2 line-clamp-2 text-xs text-[#A1A1AA]">
                    {p.brief || "No editorial brief configured."}
                  </p>

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {hasPinnedCam && (
                      <span className="inline-flex items-center gap-1 rounded border border-[#22C55E]/35 bg-[#22C55E]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#4ADE80]">
                        <PushPin className="h-2.5 w-2.5" />
                        Facecam Pinned
                      </span>
                    )}
                    {p.border_style && p.border_style !== "none" && (
                      <span className="tabular-tc rounded border border-[#282830] bg-[#18181C] px-1.5 py-0.5 text-[10px] text-[#D4D4D8]">
                        {p.border_style}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-3.5 space-y-2 border-t border-[#1E1E24] pt-2.5">
                  <StudioToggle
                    label="Hands-Free MP4 Render on Ingest"
                    checked={p.auto_export}
                    onChange={() => void handleQuickToggleAutoExport(p)}
                  />

                  <div className="flex items-center justify-between gap-2 rounded border border-[#1E1E24] bg-[#09090B] px-2.5 py-1.5">
                    <span className="tabular-tc truncate text-[10px] text-[#71717A]">
                      {p.inbox_path}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(p.inbox_path);
                        setCopiedId(p.id);
                        setTimeout(() => setCopiedId(null), 1500);
                      }}
                      className="shrink-0 text-[#A1A1AA] hover:text-white"
                      title="Copy watch-folder path"
                    >
                      {copiedId === p.id ? (
                        <Check className="h-3.5 w-3.5 text-[#22C55E]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
