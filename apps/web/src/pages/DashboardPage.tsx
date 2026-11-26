import { useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Archive,
  ArrowsClockwise,
  Broadcast,
  CheckSquare,
  CircleNotch,
  FilmStrip,
  FolderOpen,
  HardDrives,
  Intersect,
  MagnifyingGlass,
  Scissors,
  Square,
  Subtitles,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  KickIcon,
  PlatformMark,
  TikTokIcon,
  TwitchIcon,
  XBrandIcon,
  YouTubeIcon,
  detectPlatformFromUrl,
} from "../components/ui/BrandIcons";
import { SegmentedControl, StudioSelect } from "../components/ui/StudioControls";
import { formatTimecodeMs } from "../edl";
import type {
  ClipProjectSummary,
  CreatorProfile,
  FeedItem,
  HypeCurvePoint,
  JobSummary,
  SourceSummary,
  StorageSummary,
  StudioTransport,
  UrlProbeResponse,
} from "../transport";

interface DashboardPageProps {
  transport: StudioTransport;
  profiles: CreatorProfile[];
  selectedProfileId: string;
  onSelectProfileId: (id: string) => void;
  sources: SourceSummary[];
  jobs: JobSummary[];
  projects: ClipProjectSummary[];
  feedItems: FeedItem[];
  storage: StorageSummary | null;
  onRefreshAll: () => Promise<void>;
  onJobStarted: (job: JobSummary) => void;
  onOpenProject: (projectId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDurationSec(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function parseClockToSec(raw: string): number | undefined {
  const cleaned = raw.trim();
  if (!cleaned) return undefined;
  const parts = cleaned.split(":").map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return undefined;
}

function HypeSparkline({ points }: { points: HypeCurvePoint[] }) {
  if (points.length < 2) return null;
  const width = 164;
  const height = 26;
  const pathData = points
    .map((pt, idx) => {
      const x = (idx / Math.max(1, points.length - 1)) * width;
      const y = height - Math.max(0.06, Math.min(1, pt.score)) * (height - 4) - 2;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible rounded border border-[#222228] bg-[#09090B] px-1"
      aria-label="Energy Curve"
    >
      <path
        d={pathData}
        fill="none"
        stroke="#F59E0B"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DashboardPage({
  transport,
  profiles,
  selectedProfileId,
  onSelectProfileId,
  sources,
  jobs,
  projects,
  feedItems,
  storage,
  onRefreshAll,
  onJobStarted,
  onOpenProject,
}: DashboardPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const srtInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [sidecarSubFile, setSidecarSubFile] = useState<File | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeInfo, setProbeInfo] = useState<UrlProbeResponse | null>(null);
  const [vodMode, setVodMode] = useState<"full" | "window">("full");
  const [windowStartStr, setWindowStartStr] = useState("00:00");
  const [windowEndStr, setWindowEndStr] = useState("15:00");

  // Multi-clip Theme Mashup state
  const [selectedMashupIds, setSelectedMashupIds] = useState<string[]>([]);
  const [showMashupBar, setShowMashupBar] = useState(false);
  const [mashupTitle, setMashupTitle] = useState("Cinema Dark Realizations");
  const [mashupHook, setMashupHook] = useState("POV: WHEN REALITY HITS");
  const [mashupTransition, setMashupTransition] = useState<"flash_white" | "dip_black">(
    "flash_white",
  );

  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

  async function handleFileUpload(file: File) {
    setErrorBanner(null);
    setNoticeBanner(null);
    setBusyMessage(`Ingesting ${file.name}...`);
    try {
      const res = await transport.uploadVideo(
        file,
        selectedProfileId || undefined,
        sidecarSubFile,
      );
      setSidecarSubFile(null);
      setNoticeBanner(`Queued "${res.source.title}" for zero-touch clipping.`);
      if (res.job) onJobStarted(res.job);
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    const sub = files.find((f) => /\.(srt|vtt|ass)$/i.test(f.name));
    const vid = files.find((f) => /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(f.name)) ?? files[0];
    if (sub) setSidecarSubFile(sub);
    if (vid && !/\.(srt|vtt|ass)$/i.test(vid.name)) {
      void handleFileUpload(vid);
    }
  }

  async function handleProbeUrl(rawUrl?: string) {
    const cleaned = (rawUrl ?? urlInput).trim();
    if (!cleaned) return;
    setErrorBanner(null);
    setProbing(true);
    try {
      const meta = await transport.probeUrl(cleaned);
      setProbeInfo(meta);
      if (meta.durationS >= 3600) {
        setWindowStartStr("00:00");
        setWindowEndStr("20:00");
      }
    } catch (err) {
      setProbeInfo(null);
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  async function handleUrlSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = urlInput.trim();
    if (!cleaned) return;
    setErrorBanner(null);
    setNoticeBanner(null);

    const startSec = vodMode === "window" ? parseClockToSec(windowStartStr) : undefined;
    const endSec = vodMode === "window" ? parseClockToSec(windowEndStr) : undefined;
    if (vodMode === "window" && (startSec === undefined || endSec === undefined || endSec <= startSec)) {
      setErrorBanner("Enter a valid Start and End time window (e.g. 12:00 to 28:00).");
      return;
    }

    setBusyMessage(
      vodMode === "window"
        ? `Clipping VOD window (${windowStartStr}–${windowEndStr})...`
        : "Starting 8× parallel VOD ingest...",
    );
    try {
      const res = await transport.ingestUrl(cleaned, selectedProfileId || undefined, {
        title: probeInfo?.title,
        startSec,
        endSec,
      });
      setUrlInput("");
      setProbeInfo(null);
      setNoticeBanner(`Queued "${res.source.title}" in pipeline.`);
      if (res.job) onJobStarted(res.job);
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleCompileMashup() {
    if (selectedMashupIds.length < 2) {
      setErrorBanner("Select at least 2 clips below to compile a Theme Mashup.");
      return;
    }
    setErrorBanner(null);
    setBusyMessage(`Compiling ${selectedMashupIds.length}-clip Theme Mashup...`);
    try {
      const created = await transport.createMashup({
        projectIds: selectedMashupIds,
        title: mashupTitle,
        povHook: mashupHook,
        profileId: selectedProfileId || undefined,
        transitionStyle: mashupTransition,
        transitionSfx: mashupTransition === "flash_white" ? "whoosh_flash" : "cinema_hit",
      });
      setSelectedMashupIds([]);
      setShowMashupBar(false);
      await onRefreshAll();
      onOpenProject(created.id);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  function toggleMashupSelect(id: string) {
    setSelectedMashupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleScanInbox() {
    setErrorBanner(null);
    setBusyMessage("Scanning watch folders...");
    try {
      const res = await transport.scanInbox(selectedProfileId || undefined);
      setNoticeBanner(
        res.count > 0
          ? `Ingested ${res.count} media file(s) from watch folders.`
          : "Watch folders are up to date.",
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handlePollFeed() {
    setErrorBanner(null);
    setBusyMessage("Polling followed creator channels...");
    try {
      const res = await transport.pollFeed();
      setNoticeBanner(
        res.count > 0
          ? `Discovered ${res.count} new broadcast(s).`
          : "Channel feed is up to date.",
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage(null);
    }
  }

  async function handleArchiveSource(sourceId: string) {
    setErrorBanner(null);
    try {
      const res = await transport.archiveSource(sourceId);
      setNoticeBanner(
        `Archived raw source (${formatBytes(res.reclaimedBytes)} freed). Lossless clip slices remain editable.`,
      );
      await onRefreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  }

  const activeFeed = feedItems.filter((f) => f.status === "new");
  const unarchivedSources = sources.filter((s) => !s.archived && s.durationMs > 0);
  const typedPlatform = detectPlatformFromUrl(urlInput);
  const activeProfile = profiles.find((p) => p.id === selectedProfileId);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Studio Header & Active Profile Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222228] pb-3.5">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-[#F4F4F5]">
              Media &amp; Ingest Pipeline
            </h1>
            <p className="mt-0.5 text-xs text-[#A1A1AA]">
              Drop local <span className="tabular-tc text-[#D4D4D8]">.mkv / .mp4</span> files or
              ingest Twitch, YouTube &amp; Kick VODs into non-destructive zero-touch timelines.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StudioSelect
              ariaLabel="Active Creator Profile"
              value={selectedProfileId}
              onChange={onSelectProfileId}
              className="min-w-[285px]"
              options={profiles.map((p) => ({
                value: p.id,
                label: p.name,
                hint: `${(p.default_ratio ?? "9:16").toUpperCase()} · ${p.caption_style}`,
              }))}
            />

            <button
              type="button"
              onClick={() => void handleScanInbox()}
              disabled={Boolean(busyMessage)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222228] bg-[#111114] px-2.5 py-1.5 text-xs font-medium text-[#D4D4D8] transition-colors hover:border-[#32323B] hover:text-white disabled:opacity-45"
            >
              <FolderOpen className="h-3.5 w-3.5 text-[#A1A1AA]" />
              Watch Folders
            </button>

            <button
              type="button"
              onClick={() => void handlePollFeed()}
              disabled={Boolean(busyMessage)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222228] bg-[#111114] px-2.5 py-1.5 text-xs font-medium text-[#D4D4D8] transition-colors hover:border-[#32323B] hover:text-white disabled:opacity-45"
            >
              <Broadcast className="h-3.5 w-3.5 text-[#A1A1AA]" />
              Poll Channels
            </button>

            {storage && (
              <div className="tabular-tc inline-flex items-center gap-1.5 rounded-md border border-[#222228] bg-[#111114] px-2.5 py-1.5 text-[11px] text-[#A1A1AA]">
                <HardDrives className="h-3.5 w-3.5 text-[#71717A]" />
                {formatBytes(storage.mediaBytes + storage.workBytes)} ·{" "}
                {formatBytes(storage.diskFreeBytes)} free
              </div>
            )}
          </div>
        </div>

        {/* Status & Error Banners */}
        {busyMessage && (
          <div className="flex items-center gap-2 rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-2 text-xs text-[#FDE68A]">
            <CircleNotch className="h-3.5 w-3.5 animate-spin text-[#F59E0B]" />
            <span>{busyMessage}</span>
          </div>
        )}
        {errorBanner && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#EF4444]/40 bg-[#EF4444]/10 px-3 py-2 text-xs text-[#FECACA]">
            <div className="flex items-center gap-2">
              <WarningCircle className="h-4 w-4 shrink-0 text-[#EF4444]" />
              <span>{errorBanner}</span>
            </div>
            <div className="flex items-center gap-2">
              {errorBanner.toLowerCase().includes(".mkv") && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded border border-[#FECACA]/40 bg-[#09090B] px-2 py-0.5 text-[11px] font-medium text-[#F4F4F5] hover:border-white"
                >
                  Browse Local .MKV / .MP4
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => setErrorBanner(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        {noticeBanner && (
          <div className="flex items-center justify-between rounded-md border border-[#22C55E]/35 bg-[#22C55E]/10 px-3 py-2 text-xs text-[#DCFCE7]">
            <span>{noticeBanner}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => setNoticeBanner(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Unified Command Ingest Console */}
        <div className="grid gap-3 lg:grid-cols-12">
          {/* Left: Local File & Cinema MKV + SRT Drop Bay (5 cols) */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col justify-between rounded-lg border p-4 transition-colors lg:col-span-5 ${
              isDragging
                ? "border-[#F59E0B] bg-[#F59E0B]/8"
                : "border-[#222228] bg-[#111114] hover:border-[#32323B]"
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F4F4F5]">
                  <UploadSimple className="h-4 w-4 text-[#F59E0B]" />
                  Local Media &amp; Cinema MKV Ingest
                </span>
                <span className="tabular-tc text-[10px] text-[#71717A]">
                  5.1 FC · EMBEDDED SRT
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[#A1A1AA]">
                Drop a movie <span className="tabular-tc text-[#D4D4D8]">.mkv</span>, stream
                recording, or <span className="tabular-tc text-[#D4D4D8]">.mp4</span>. Embedded
                subtitles extract in &lt;0.5s and 5.1 surround isolates center-channel dialogue.
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.m4v,.avi"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void handleFileUpload(picked);
                e.target.value = "";
              }}
            />
            <input
              ref={srtInputRef}
              type="file"
              accept=".srt,.vtt,.ass"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setSidecarSubFile(picked);
                e.target.value = "";
              }}
            />

            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={Boolean(busyMessage)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[#32323B] bg-[#18181C] px-3 py-1.5 text-xs font-medium text-[#F4F4F5] transition-colors hover:border-[#F59E0B]/60 hover:bg-[#202026] disabled:opacity-45"
              >
                <FilmStrip className="h-3.5 w-3.5 text-[#F59E0B]" />
                Select Video (.MP4 / .MKV)
              </button>

              <button
                type="button"
                onClick={() => srtInputRef.current?.click()}
                title="Optional sidecar .srt/.vtt/.ass subtitle file"
                className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                  sidecarSubFile
                    ? "border-[#F59E0B]/60 bg-[#F59E0B]/12 text-[#FDE68A]"
                    : "border-[#222228] bg-[#09090B] text-[#A1A1AA] hover:border-[#32323B] hover:text-[#F4F4F5]"
                }`}
              >
                <Subtitles className="h-3.5 w-3.5" />
                {sidecarSubFile ? sidecarSubFile.name.slice(0, 16) : "+ Sidecar .SRT"}
              </button>
            </div>
          </div>

          {/* Right: Multi-Platform & Twitch Long-VOD Command Bar (7 cols) */}
          <form
            onSubmit={(e) => void handleUrlSubmit(e)}
            className="flex flex-col justify-between rounded-lg border border-[#222228] bg-[#111114] p-4 lg:col-span-7"
          >
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#F4F4F5]">
                  Twitch VOD &amp; Multi-Platform Stream Ingest
                </span>
                <div className="flex items-center gap-2.5 text-[#71717A]">
                  <TwitchIcon className="h-3.5 w-3.5 text-[#A970FF]" title="Twitch VODs & Clips" />
                  <YouTubeIcon className="h-3.5 w-3.5 text-[#FF4E45]" title="YouTube" />
                  <KickIcon className="h-3 w-3 text-[#53FC18]" title="Kick" />
                  <TikTokIcon className="h-3.5 w-3.5 text-[#D4D4D8]" title="TikTok" />
                  <XBrandIcon className="h-3 w-3 text-[#D4D4D8]" title="X / Twitter" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex min-w-0 flex-1 items-center">
                  {typedPlatform !== "local" && typedPlatform !== "web" && (
                    <span className="pointer-events-none absolute left-2.5">
                      <PlatformMark platform={typedPlatform} className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      if (!e.target.value.trim()) setProbeInfo(null);
                    }}
                    placeholder="https://www.twitch.tv/videos/... or https://youtube.com/watch?v=..."
                    className={`w-full rounded-md border border-[#222228] bg-[#09090B] py-1.5 pr-3 text-xs text-[#F4F4F5] placeholder-[#71717A] focus:border-[#F59E0B] focus:outline-none ${
                      typedPlatform !== "local" && typedPlatform !== "web" ? "pl-8" : "pl-3"
                    }`}
                  />
                </div>

                <button
                  type="button"
                  disabled={probing || !urlInput.trim()}
                  onClick={() => void handleProbeUrl()}
                  title="Inspect VOD duration & chapters before downloading"
                  className="inline-flex items-center gap-1 rounded-md border border-[#2C2C35] bg-[#18181C] px-2.5 py-1.5 text-xs font-medium text-[#D4D4D8] hover:border-[#3F3F46] hover:text-white disabled:opacity-40"
                >
                  {probing ? (
                    <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MagnifyingGlass className="h-3.5 w-3.5" />
                  )}
                  Inspect
                </button>

                <button
                  type="submit"
                  disabled={Boolean(busyMessage) || !urlInput.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#F59E0B] px-3.5 py-1.5 text-xs font-semibold text-[#09090B] transition-colors hover:bg-[#FBBF24] disabled:opacity-40"
                >
                  <Scissors weight="bold" className="h-3.5 w-3.5" />
                  Clip VOD
                </button>
              </div>

              {/* Probed VOD Metadata + Full VOD vs Time Window Selector */}
              {(probeInfo || typedPlatform === "twitch") && urlInput.trim() && (
                <div className="space-y-2.5 rounded-md border border-[#27272F] bg-[#09090B] p-2.5">
                  {probeInfo && (
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <PlatformMark platform={probeInfo.platform} className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate font-medium text-[#F4F4F5]">
                          {probeInfo.title}
                        </span>
                      </div>
                      <span className="tabular-tc shrink-0 text-[11px] text-[#A1A1AA]">
                        {probeInfo.channel ? `${probeInfo.channel} · ` : ""}
                        {formatDurationSec(probeInfo.durationS)}
                      </span>
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-12 sm:items-center">
                    <div className="sm:col-span-6">
                      <SegmentedControl
                        size="xs"
                        value={vodMode}
                        onChange={setVodMode}
                        options={[
                          { value: "full", label: "Full VOD (8× Parallel)" },
                          { value: "window", label: "Time Window (Fast)" },
                        ]}
                      />
                    </div>

                    {vodMode === "window" ? (
                      <div className="flex items-center gap-1.5 sm:col-span-6">
                        <input
                          type="text"
                          value={windowStartStr}
                          onChange={(e) => setWindowStartStr(e.target.value)}
                          aria-label="Start time"
                          placeholder="00:00"
                          className="tabular-tc w-full rounded border border-[#222228] bg-[#111114] px-2 py-1 text-center text-[11px] text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                        />
                        <span className="text-[11px] text-[#71717A]">to</span>
                        <input
                          type="text"
                          value={windowEndStr}
                          onChange={(e) => setWindowEndStr(e.target.value)}
                          aria-label="End time"
                          placeholder="20:00"
                          className="tabular-tc w-full rounded border border-[#222228] bg-[#111114] px-2 py-1 text-center text-[11px] text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                        />
                      </div>
                    ) : (
                      <div className="text-[11px] text-[#71717A] sm:col-span-6">
                        Downloads 8 HLS fragments concurrently &amp; scans full broadcast.
                      </div>
                    )}
                  </div>

                  {probeInfo && probeInfo.chapters.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      <span className="text-[10px] text-[#71717A]">Chapters:</span>
                      {probeInfo.chapters.slice(0, 5).map((ch, idx) => (
                        <button
                          key={`${ch.title}-${idx}`}
                          type="button"
                          onClick={() => {
                            setVodMode("window");
                            setWindowStartStr(formatDurationSec(ch.startS));
                            setWindowEndStr(formatDurationSec(ch.endS));
                          }}
                          className="rounded border border-[#222228] bg-[#141418] px-1.5 py-0.5 text-[10px] text-[#D4D4D8] hover:border-[#F59E0B]/50 hover:text-white"
                        >
                          {ch.title} ({formatDurationSec(ch.startS)})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {activeProfile && (
              <div className="mt-2.5 flex items-center justify-between border-t border-[#1C1C22] pt-2 text-[11px] text-[#71717A]">
                <span>
                  Preset:{" "}
                  <strong className="font-medium text-[#D4D4D8]">{activeProfile.name}</strong>
                </span>
                <span className="tabular-tc">
                  {(activeProfile.default_ratio ?? "9:16").toUpperCase()} ·{" "}
                  {activeProfile.bgm_mode && activeProfile.bgm_mode !== "off"
                    ? "Auto-Ducked BGM"
                    : "Clean Dialogue"}
                </span>
              </div>
            )}
          </form>
        </div>

        {/* Followed Creator Feed */}
        {activeFeed.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
              Followed Creator Feed ({activeFeed.length})
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {activeFeed.map((item) => {
                const plat = detectPlatformFromUrl(item.url);
                return (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between rounded-lg border border-[#222228] bg-[#111114] p-3"
                  >
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#A1A1AA]">
                        <PlatformMark platform={plat} className="h-3 w-3" />
                        <span className="truncate">{item.channel || item.profileId}</span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs font-semibold text-[#F4F4F5]">
                        {item.title}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await transport.clipFeedItem(item.id);
                          if (res.job) onJobStarted(res.job);
                          await onRefreshAll();
                        }}
                        className="flex-1 rounded bg-[#F59E0B] px-2.5 py-1 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                      >
                        Clip VOD
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await transport.dismissFeedItem(item.id);
                          await onRefreshAll();
                        }}
                        className="rounded border border-[#222228] px-2 py-1 text-xs text-[#A1A1AA] hover:text-white"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Pipeline Jobs */}
        {jobs.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                Pipeline Telemetry ({jobs.length})
              </h2>
              <button
                type="button"
                onClick={() => void onRefreshAll()}
                className="inline-flex items-center gap-1 text-[11px] text-[#A1A1AA] hover:text-white"
              >
                <ArrowsClockwise className="h-3 w-3" />
                Refresh
              </button>
            </div>
            <div className="space-y-1.5">
              {jobs.slice(0, 6).map((job) => {
                const pct = Math.round(job.progress * 100);
                const statusBadge =
                  job.status === "done"
                    ? "border-[#22C55E]/30 bg-[#22C55E]/10 text-[#4ADE80]"
                    : job.status === "failed"
                      ? "border-[#EF4444]/30 bg-[#EF4444]/10 text-[#F87171]"
                      : "border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#FBBF24]";
                return (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#222228] bg-[#111114] px-3.5 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-[#F4F4F5]">
                          {job.sourceTitle || job.sourceId}
                        </span>
                        <span
                          className={`tabular-tc rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${statusBadge}`}
                        >
                          {job.stage}
                        </span>
                        {job.downloadDetail && job.status === "running" && (
                          <span className="tabular-tc text-[10px] text-[#A1A1AA]">
                            {job.downloadDetail}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[#09090B]">
                        <div
                          className="h-full rounded-full bg-[#F59E0B] transition-all"
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                      {job.error && (
                        <p className="mt-1 text-[11px] text-[#FCA5A5]">{job.error}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-3.5">
                      <HypeSparkline points={job.hypeCurve} />
                      <div className="tabular-tc text-right text-[11px] text-[#A1A1AA]">
                        <div className="font-semibold text-[#F4F4F5]">{pct}%</div>
                        <div>{job.clipCount} clips</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Generated Clips Library + Multi-Clip Theme Mashup Compiler */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717A]">
                Generated Clips ({projects.length})
              </h2>
              {projects.length >= 2 && (
                <button
                  type="button"
                  onClick={() => setShowMashupBar((v) => !v)}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    showMashupBar || selectedMashupIds.length >= 2
                      ? "border-[#F59E0B]/60 bg-[#F59E0B]/15 text-[#FDE68A]"
                      : "border-[#222228] bg-[#111114] text-[#A1A1AA] hover:text-[#F4F4F5]"
                  }`}
                >
                  <Intersect className="h-3.5 w-3.5" />
                  Theme Mashup
                  {selectedMashupIds.length > 0 && (
                    <span className="tabular-tc">({selectedMashupIds.length})</span>
                  )}
                </button>
              )}
            </div>

            {unarchivedSources.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {unarchivedSources.slice(0, 2).map((src) => (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => void handleArchiveSource(src.id)}
                    className="inline-flex items-center gap-1 rounded border border-[#222228] bg-[#111114] px-2 py-1 text-[11px] text-[#A1A1AA] hover:border-[#3F3F46] hover:text-[#F4F4F5]"
                  >
                    <Archive className="h-3 w-3" />
                    Reclaim Raw VOD ({src.title.slice(0, 18)})
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme Mashup Compiler Bar */}
          {(showMashupBar || selectedMashupIds.length >= 2) && (
            <div className="grid gap-2.5 rounded-lg border border-[#F59E0B]/35 bg-[#111114] p-3 sm:grid-cols-12 sm:items-end">
              <div className="sm:col-span-3">
                <label className="mb-1 block text-[10px] text-[#A1A1AA]">Mashup Title</label>
                <input
                  type="text"
                  value={mashupTitle}
                  onChange={(e) => setMashupTitle(e.target.value)}
                  className="w-full rounded border border-[#222228] bg-[#09090B] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-4">
                <label className="mb-1 block text-[10px] text-[#A1A1AA]">
                  Top POV Header Hook
                </label>
                <input
                  type="text"
                  value={mashupHook}
                  onChange={(e) => setMashupHook(e.target.value)}
                  placeholder="POV: MOVIES SHOWING..."
                  className="w-full rounded border border-[#222228] bg-[#09090B] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-3">
                <label className="mb-1 block text-[10px] text-[#A1A1AA]">Cut Transition</label>
                <SegmentedControl
                  size="xs"
                  value={mashupTransition}
                  onChange={setMashupTransition}
                  options={[
                    { value: "flash_white", label: "White Flash" },
                    { value: "dip_black", label: "Dip Black" },
                  ]}
                />
              </div>
              <div className="sm:col-span-2">
                <button
                  type="button"
                  disabled={selectedMashupIds.length < 2 || Boolean(busyMessage)}
                  onClick={() => void handleCompileMashup()}
                  className="w-full rounded-md bg-[#F59E0B] px-2.5 py-1.5 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24] disabled:opacity-40"
                >
                  Compile ({selectedMashupIds.length})
                </button>
              </div>
            </div>
          )}

          {projects.length === 0 ? (
            <div className="rounded-lg border border-[#222228] bg-[#111114] p-8 text-center text-xs text-[#71717A]">
              No clips in workspace yet. Drop a video or paste a VOD link above to generate
              zero-touch timelines.
            </div>
          ) : (
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((clip) => {
                const thumbUrl = clip.hasThumb
                  ? transport.projectThumbUrl(clip.id)
                  : null;
                const isPicked = selectedMashupIds.includes(clip.id);
                return (
                  <article
                    key={clip.id}
                    className={`group flex flex-col overflow-hidden rounded-lg border bg-[#111114] transition-colors ${
                      isPicked
                        ? "border-[#F59E0B]"
                        : "border-[#222228] hover:border-[#3A3A44]"
                    }`}
                  >
                    <div className="relative h-36 bg-[#09090B]">
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={clip.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="studio-stage-grid flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[#71717A]">
                          <FilmStrip className="h-5 w-5 text-[#52525B]" />
                          <span className="tabular-tc">EDL v1 · READY</span>
                        </div>
                      )}

                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleMashupSelect(clip.id)}
                          title="Select clip for Theme Mashup"
                          className="flex h-5 w-5 items-center justify-center rounded bg-black/80 text-[#D4D4D8] hover:text-white"
                        >
                          {isPicked ? (
                            <CheckSquare weight="fill" className="h-4 w-4 text-[#F59E0B]" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                        <span className="tabular-tc rounded border border-white/10 bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-[#F59E0B]">
                          SCORE {clip.score}
                        </span>
                      </div>

                      <span className="tabular-tc absolute bottom-2 right-2 rounded border border-white/10 bg-black/80 px-1.5 py-0.5 text-[10px] text-[#F4F4F5]">
                        {formatTimecodeMs(clip.totalDurationMs)}
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-3">
                      <div>
                        <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-[#F4F4F5]">
                          {clip.title}
                        </h3>
                        {clip.reason && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-[#A1A1AA]">
                            {clip.reason}
                          </p>
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-[#1E1E24] pt-2.5">
                        <span className="tabular-tc text-[10px] uppercase text-[#71717A]">
                          {clip.wordCount} words · {clip.status}
                        </span>
                        <button
                          type="button"
                          onClick={() => onOpenProject(clip.id)}
                          className="inline-flex items-center gap-1 rounded border border-[#2C2C35] bg-[#18181C] px-2.5 py-1 text-[11px] font-medium text-[#F4F4F5] transition-colors group-hover:border-[#F59E0B]/60 group-hover:bg-[#F59E0B] group-hover:text-[#09090B]"
                        >
                          <Scissors className="h-3 w-3" />
                          Cut Room
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
